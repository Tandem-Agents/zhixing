import { normalizeLeadingSlashAlias } from '@zhixing/terminal-ui/protocol';
import * as path from 'node:path';
import { expandUserHome } from '@zhixing/core/paths';
import type { InputMaterialRegistry } from '../input-material-registry.js';
import { detectMimeType } from '../input-material-ingest.js';
import { readBoundedInputFile } from './bounded-input-file.js';
import { SessionSendJsonWriter } from './session-send-encoding.js';
import type { SessionSendSnapshotIdentity } from '../runtime/rpc-conversation-facade.js';

const MiB = 1024 * 1024;
const TEXT_UNITS = 8192;
const FIRST_FILE_CHARACTER = /^[\p{L}\p{N}_\-.\/~:]/u;
const WHITESPACE = /\s/u;
const CAPACITY_ERROR = '输入准备工作区不足，草稿已保留。';
const ENGAGE_IMAGE_ERROR = '多视角评议目前只支持文本内容；请将图片转成文字说明，或移除图片后再触发 @。';

export interface PrepareSessionSendOptions {
  readonly workspaceRoot: string;
  readonly materialRegistry: InputMaterialRegistry;
  readonly signal: AbortSignal;
  readonly maximumParamsBytes?: number;
  /** Alias position proven against the unexpanded immutable draft by N. */
  readonly commandAliasOffset?: number;
}
type SnapshotValue = { readonly kind: 'text'; readonly text: string } | {
  readonly kind: 'image'; readonly data: string; readonly mediaType: string;
  readonly name: string; readonly size: number;
};
type Range = readonly [start: number, end: number];

/** Only this terminal session.send preparation uses this fixed-schema encoder.
 * E <= 128 MiB + cached material values <= emitted wire (100 MiB) + 16 MiB
 * current material/encoding/IO scratch + 8 MiB indices/paths = 252 MiB.
 * Ordinary text has no retained parts array. A cached value is admitted only
 * after its first complete encoding, so its value bytes are already bounded
 * by the wire counter. No prepared.text, combined question, or full JSON copy.
 * The caller must hold the receive preparation lease through this whole frame.
 */
export async function prepareSessionSendSnapshot(
  original: string,
  identity: SessionSendSnapshotIdentity,
  options: PrepareSessionSendOptions,
  write: (bytes: Buffer) => Promise<void>,
): Promise<number | undefined> {
  options.signal.throwIfAborted();
  if (!/\S/u.test(original)) return undefined;
  if (Buffer.byteLength(original) > 128 * MiB) throw Error(CAPACITY_ERROR);
  const aliasAt = options.commandAliasOffset;
  if (aliasAt !== undefined && (!Number.isSafeInteger(aliasAt) || aliasAt < 0 || normalizeLeadingSlashAlias(original[aliasAt] ?? '') !== '/' || original[aliasAt] === '/')) throw Error('terminal-command-alias-source');
  const view = new InputView(original, [[0, original.length]], aliasAt);
  const question = await engageView(view, options.signal);
  const writer = new SessionSendJsonWriter(write, options.signal, options.maximumParamsBytes);
  const materials = new MaterialSnapshots(options);
  await writer.literal('{"input":{"parts":[');
  const parts = new InputPartsWriter(writer);
  await scanInput(view, parts, materials);
  await parts.finish();
  await writer.literal(']},"turnId":');
  await writer.string(identity.turnId);
  if (identity.conversationId !== undefined) {
    await writer.literal(',"conversationId":'); await writer.string(identity.conversationId);
  }
  await writer.literal(',"surfaceCapabilities":{"postTurnControl":true}');
  if (identity.acceptLimitedCapabilities) await writer.literal(',"acceptLimitedCapabilities":true');
  if (question) {
    await writer.literal(',"engage":{"kind":"perspectives","question":"');
    await scanInput(question, {
      text: text => writer.stringContent(text),
      image: async () => { throw Error(ENGAGE_IMAGE_ERROR); },
    }, materials);
    await writer.literal('"}');
  }
  await writer.literal('}');
  await writer.finish();
  return writer.byteLength;
}

interface PartsSink {
  text(value: string): Promise<void>;
  image(value: Extract<SnapshotValue, { kind: 'image' }>): Promise<void>;
}
class InputPartsWriter implements PartsSink {
  #first = true; #text = false;
  constructor(readonly writer: SessionSendJsonWriter) {}
  async text(value: string): Promise<void> {
    if (!value.length) return;
    if (!this.#text) {
      await this.#separator();
      await this.writer.literal('{"type":"text","text":"'); this.#text = true;
    }
    await this.writer.stringContent(value);
  }
  async image(value: Extract<SnapshotValue, { kind: 'image' }>): Promise<void> {
    await this.finish(); await this.#separator();
    await this.writer.literal('{"type":"image","source":{"type":"base64","mediaType":');
    await this.writer.string(value.mediaType);
    await this.writer.literal(',"data":'); await this.writer.string(value.data);
    await this.writer.literal('},"name":'); await this.writer.string(value.name);
    await this.writer.literal(',"mimeType":'); await this.writer.string(value.mediaType);
    await this.writer.literal(`,"size":${value.size}}`);
  }
  async finish(): Promise<void> {
    if (this.#text) { await this.writer.literal('"}'); this.#text = false; }
  }
  async #separator(): Promise<void> {
    if (!this.#first) await this.writer.literal(',');
    this.#first = false;
  }
}

/** At most three ranges reference the one expanded original. The engage view
 * implements the existing trigger/whitespace rule without concatenating it. */
class InputView {
  readonly length: number;
  readonly #searches = new Map<string, { from: number; found: number }>();
  constructor(readonly original: string, readonly ranges: readonly Range[], readonly commandAliasOffset?: number) {
    this.length = ranges.reduce((length, range) => length + range[1] - range[0], 0);
  }
  char(index: number): string {
    if (index < 0) return '';
    for (const [start, end] of this.ranges) {
      if (index < end - start) return start + index === this.commandAliasOffset ? '/' : this.original[start + index] ?? '';
      index -= end - start;
    }
    return '';
  }
  slice(from: number, to: number): string {
    let position = 0; let result = '';
    for (const [start, end] of this.ranges) {
      const low = Math.max(0, from - position), high = Math.min(end - start, to - position);
      if (high > low) {
        const alias = this.commandAliasOffset;
        result += alias !== undefined && alias >= start + low && alias < start + high
          ? this.original.slice(start + low, alias) + '/' + this.original.slice(alias + 1, start + high)
          : this.original.slice(start + low, start + high);
      }
      position += end - start;
      if (position >= to) break;
    }
    return result;
  }
  indexOf(character: string, from: number): number {
    // The scanner uses only [, @, ], and LF. Retain one cursor per character,
    // so repeated malformed tokens cannot rescan the same long suffix.
    const previous = this.#searches.get(character);
    if (previous && from >= previous.from && (previous.found < 0 || from <= previous.found)) return previous.found;
    const found = this.#find(character, from);
    this.#searches.set(character, { from, found });
    return found;
  }
  #find(character: string, from: number): number {
    let position = 0;
    for (const [start, end] of this.ranges) {
      if (position + end - start > from) {
        const found = this.original.indexOf(character, start + Math.max(0, from - position));
        if (found >= start && found < end) return position + found - start;
      }
      position += end - start;
    }
    return -1;
  }
}

async function engageView(view: InputView, signal: AbortSignal): Promise<InputView | undefined> {
  let yielded = 0;
  for (let at = view.indexOf('@', 0); at !== -1; at = view.indexOf('@', at + 1)) {
    if (at - yielded >= 65536) { await scanYield(signal); yielded = at; }
    if (!space(view.char(at + 1)) || (at !== 0 && !space(view.char(at - 1)))) continue;
    let left = 0, prefixEnd = at, suffix = at + 1, right = view.length;
    while (suffix < right && space(view.char(suffix))) { suffix++; if (suffix % 65536 === 0) await scanYield(signal); }
    if (suffix === right) return undefined;
    while (right > suffix && space(view.char(right - 1))) { right--; if (right % 65536 === 0) await scanYield(signal); }
    while (left < prefixEnd && space(view.char(left))) { left++; if (left % 65536 === 0) await scanYield(signal); }
    while (prefixEnd > left && space(view.char(prefixEnd - 1))) { prefixEnd--; if (prefixEnd % 65536 === 0) await scanYield(signal); }
    if (left === prefixEnd) return new InputView(view.original, [[suffix, right]], view.commandAliasOffset);
    // Pick one existing separator code unit; no third large carrier. The old
    // parser normalizes CR/LF to LF, all other separating whitespace to space.
    let separator = ' ';
    for (let index = prefixEnd; index < at; index++) {
      if (index % 65536 === 0) await scanYield(signal);
      if (view.char(index) === '\r' || view.char(index) === '\n') { separator = '\n'; break; }
    }
    return new InputViewWithSeparator(view.original, [left, prefixEnd], [suffix, right], separator, view.commandAliasOffset);
  }
  return undefined;
}

class InputViewWithSeparator extends InputView {
  constructor(original: string, readonly prefix: Range, readonly suffix: Range, readonly separator: string, commandAliasOffset?: number) {
    // The separator substitutes the trigger's existing one-code-unit range.
    super(original, [prefix, [prefix[1], prefix[1] + 1], suffix], commandAliasOffset);
  }
  override char(index: number): string {
    return index === this.prefix[1] - this.prefix[0] ? this.separator : super.char(index);
  }
  override slice(from: number, to: number): string {
    const at = this.prefix[1] - this.prefix[0];
    if (from <= at && to > at) return super.slice(from, at) + this.separator + super.slice(at + 1, to);
    return super.slice(from, to);
  }
  override indexOf(character: string, from: number): number {
    const at = this.prefix[1] - this.prefix[0];
    const found = super.indexOf(character, from);
    if (from <= at && this.separator === character && (found < 0 || found > at)) return at;
    return found === at && this.separator !== character ? super.indexOf(character, at + 1) : found;
  }
}

async function scanInput(view: InputView, sink: PartsSink, materials: MaterialSnapshots): Promise<void> {
  let start = 0, cursor = 0, yielded = 0;
  while (cursor < view.length) {
    materials.options.signal.throwIfAborted();
    const bracket = view.indexOf('[', cursor), mention = view.indexOf('@', cursor);
    const at = bracket < 0 ? mention : mention < 0 ? bracket : Math.min(bracket, mention);
    if (at < 0) break;
    if (at - yielded >= 65536) { await scanYield(materials.options.signal); yielded = at; }
    const token = view.char(at) === '[' ? await materialToken(view, at, materials.options.signal) : undefined;
    if (token) {
      await emitText(view, start, at, sink);
      const known = token.end - at <= 1024 && Number.isSafeInteger(token.id) &&
        materials.options.materialRegistry.isKnownToken(token.id, view.slice(at, token.end));
      const entry = known ? materials.options.materialRegistry.get(token.id) : undefined;
      if (!entry || token.label !== (entry.kind === 'image' ? 'Image' : 'File')) await emitText(view, at, token.end, sink);
      else await materials.emitMaterial(token.id, sink);
      start = cursor = token.end;
    } else if (view.slice(at, at + 6) === '@file:' && FIRST_FILE_CHARACTER.test(view.slice(at + 6, at + 8))) {
      let end = at + 6;
      while (end < view.length && !space(view.char(end))) { end++; if (end % 65536 === 0) await scanYield(materials.options.signal); }
      await emitText(view, start, at, sink);
      await materials.emitFile(view, at + 6, end, sink);
      start = cursor = end;
    } else cursor = at + 1;
  }
  await emitText(view, start, view.length, sink);
}

async function emitText(view: InputView, start: number, end: number, sink: PartsSink): Promise<void> {
  while (start < end) {
    let next = Math.min(end, start + TEXT_UNITS);
    if (next < end && high(view.char(next - 1)) && low(view.char(next))) next--;
    await sink.text(view.slice(start, next)); start = next;
  }
}

async function materialToken(view: InputView, start: number, signal: AbortSignal): Promise<{ end: number; id: number; label: string } | undefined> {
  const label = view.slice(start + 1, start + 6) === 'Image' ? 'Image' : view.slice(start + 1, start + 5) === 'File' ? 'File' : undefined;
  if (!label || view.slice(start + 1 + label.length, start + 3 + label.length) !== ' #') return undefined;
  const digits = start + 3 + label.length;
  let position = digits;
  while (view.char(position) >= '0' && view.char(position) <= '9') { position++; if (position % 65536 === 0) await scanYield(signal); }
  if (position === digits || view.slice(position, position + 3) !== ' · ') return undefined;
  const name = position + 3, end = view.indexOf(']', name), newline = view.indexOf('\n', name);
  if (end <= name || (newline !== -1 && newline < end)) return undefined;
  return { end: end + 1, id: position - digits <= 16 ? Number(view.slice(digits, position)) : NaN, label };
}

class MaterialSnapshots {
  readonly #values = new Map<string, SnapshotValue>();
  #metadata = 0;
  constructor(readonly options: PrepareSessionSendOptions) {}
  async emitMaterial(id: number, sink: PartsSink): Promise<void> {
    const key = `material:${id}`;
    const cached = this.#values.get(key);
    if (cached) { await emitValue(cached, sink); return; }
    const entry = this.options.materialRegistry.get(id)!;
    this.#charge(512 + Buffer.byteLength(entry.filePath) * 4 + Buffer.byteLength(entry.name) * 2);
    let value: SnapshotValue;
    if (entry.kind === 'image') {
      const bytes = await readBoundedInputFile(entry.filePath, 5 * MiB, this.options.signal);
      const mediaType = detectMimeType(entry.filePath, bytes);
      if (!mediaType.startsWith('image/')) throw Error('文件内容不是可识别图片；草稿已保留。');
      value = { kind: 'image', data: bytes.toString('base64'), mediaType, name: entry.name, size: bytes.length };
    } else {
      if (!entry.mimeType.startsWith('text/') && !['application/json', 'application/xml'].includes(entry.mimeType)) {
        throw Error('当前版本尚不能直接发送此类型文件；请先转成文本或图片。');
      }
      value = await this.#textFile(entry.filePath);
    }
    await emitValue(value, sink);
    this.#values.set(key, value);
  }
  async emitFile(view: InputView, from: number, to: number, sink: PartsSink): Promise<void> {
    // Bound lookup scratch before cloning. Existing cache entries do not need
    // another persistent metadata reservation during the engage replay.
    if (to - from > 8 * MiB / 24) throw Error(CAPACITY_ERROR);
    const raw = view.slice(from, to);
    const key = `ref:${raw}`;
    const cached = this.#values.get(key);
    if (cached) { await emitValue(cached, sink); return; }
    this.#charge(512 + Buffer.byteLength(raw) * 8 + Buffer.byteLength(this.options.workspaceRoot) * 4);
    const absolute = path.resolve(this.options.workspaceRoot, expandUserHome(raw));
    const value = await this.#textFile(absolute);
    await emitValue(value, sink);
    this.#values.set(key, value);
  }
  async #textFile(absolute: string): Promise<SnapshotValue> {
    const bytes = await readBoundedInputFile(absolute, 100 * 1024, this.options.signal);
    return { kind: 'text', text: `<file path="${absolute.replace(/\\/g, '/')}">\n${bytes.toString('utf8')}\n</file>` };
  }
  #charge(bytes: number): void {
    if (this.#metadata + bytes > 8 * MiB) throw Error(CAPACITY_ERROR);
    this.#metadata += bytes;
  }
}

async function emitValue(value: SnapshotValue, sink: PartsSink): Promise<void> {
  if (value.kind === 'text') await sink.text(value.text); else await sink.image(value);
}
function space(char: string): boolean { return char.length > 0 && WHITESPACE.test(char); }
function high(char: string): boolean { const code = char.charCodeAt(0); return code >= 0xd800 && code <= 0xdbff; }
function low(char: string): boolean { const code = char.charCodeAt(0); return code >= 0xdc00 && code <= 0xdfff; }
async function scanYield(signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  signal.throwIfAborted();
}
