import { describe, expect, it } from 'vitest';
import { BODY_FRAGMENT_BYTES, BODY_FRAGMENT_ENCODED_BYTES, BODY_PARSE_BYTES, BODY_STYLE, validateBodyMetadata } from '@zhixing/terminal-ui/body-model';
import { TerminalBodyProjection, projectBodyHistory, mergeBodyAppends, type BodyAppend, type BodyProjectionChange } from '../body-projection.js';

function apply(items: BodyAppend[], change: BodyProjectionChange) {
  if (change.kind === 'append') items.push(change);
  else for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.contentOffset < change.to && item.contentOffset + item.text.length > change.from) {
      items[i] = { ...item, body: change.project(item.contentOffset, item.text.length, item.body) };
    }
  }
}
function live(source: string, chunk = 8192) {
  const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
  for (let start = 0; start < source.length; start += chunk) for (const change of projection.feed(source.slice(start, start + chunk))) apply(items, change);
  for (const change of projection.end()) apply(items, change);
  return items;
}
const visible = (items: readonly BodyAppend[]) => items.flatMap(item => item.body.context.nodes.flatMap(node => node.runs.map(run => run.text))).join('');
const noWait = async () => {};

describe('terminal source body projection', () => {
  it('replays an 8 MiB cold code block including a 1 MiB line without losing internal source anchors', async () => {
    const prefix = '```ts\n' + 'x'.repeat(1024 * 1024) + '\n', suffix = '\n```';
    const line = 'const value = "中文🙂";\n';
    const remaining = 8 * 1024 * 1024 - Buffer.byteLength(prefix + suffix);
    const repeat = Math.floor(remaining / Buffer.byteLength(line));
    const source = prefix + line.repeat(repeat) + ' '.repeat(remaining - repeat * Buffer.byteLength(line)) + suffix;
    expect(Buffer.byteLength(source)).toBe(8 * 1024 * 1024);
    let end = source.length, parts = 0;
    for await (const item of projectBodyHistory(source, 'markdown', 'reverse', noWait)) {
      expect(item.contentOffset + item.text.length).toBe(end);
      expect(item.text).toBe(source.slice(item.contentOffset, end));
      expect(validateBodyMetadata(item.body, item.contentOffset, item.text.length)).toBe(true);
      if (parts++ === 0) expect(item.body.end).toBe(true);
      end = item.contentOffset;
    }
    expect(end).toBe(0); expect(parts).toBeGreaterThan(256);
  }, 15000);
  it('keeps source and strong continuation through fragments and four-fragment pages', () => {
    const inner = '汉字ab'.repeat(12000), source = `开始 **${inner}** 收尾`;
    const items = live(source);
    expect(items.length).toBeGreaterThan(4);
    expect(items.map(item => item.text).join('')).toBe(source);
    expect(visible(items)).toBe(`开始 ${inner} 收尾`);
    const bold = items.flatMap(item => item.body.context.nodes.flatMap(node => node.runs)).filter(run => run.style & BODY_STYLE.bold);
    expect(bold.map(run => run.text).join('')).toBe(inner);
    for (const item of items) {
      expect(Buffer.byteLength(item.text)).toBeLessThanOrEqual(BODY_FRAGMENT_BYTES);
      expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(BODY_FRAGMENT_ENCODED_BYTES);
      expect(validateBodyMetadata(item.body, item.contentOffset, item.text.length)).toBe(true);
    }
    expect(items.filter(item => item.body.end)).toHaveLength(1);
    expect(items.at(-1)?.body.end).toBe(true);
  });
  it('coalesces small live appends after amendments without stale styles or a token-sized page', () => {
    const source = '开头 **' + '连续正文'.repeat(300) + '** 尾部', projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
    for (let at = 0; at < source.length; at += 3) for (const change of projection.feed(source.slice(at, at + 3))) {
      if (change.kind === 'amend') apply(items, change);
      else {
        const last = items.at(-1), merged = last && mergeBodyAppends(last, change);
        if (merged) items[items.length - 1] = merged; else items.push(change);
      }
    }
    for (const change of projection.end()) apply(items, change);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe(source);
    expect(visible(items)).toBe('开头 ' + '连续正文'.repeat(300) + ' 尾部');
    expect(items[0]!.body.context.nodes.flatMap(node => node.runs).filter(run => run.style & BODY_STYLE.bold).map(run => run.text).join(''))
      .toBe('连续正文'.repeat(300));
    expect(items[0]!.body.end).toBe(true);
  });
  it('reserves the rendered copy of held CJK inline text before publishing its source fragment', () => {
    const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
    for (const part of ['前缀 **' + '汉'.repeat(8184), '**\n\n后继']) for (const change of projection.feed(part)) {
      apply(items, change);
      expect(items.every(item => Buffer.byteLength(JSON.stringify(item)) <= BODY_FRAGMENT_ENCODED_BYTES)).toBe(true);
    }
    for (const change of projection.end()) apply(items, change);
    expect(visible(items)).toBe('前缀 ' + '汉'.repeat(8184) + '后继');
    expect(items.map(item => item.text).join('')).toBe('前缀 **' + '汉'.repeat(8184) + '**\n\n后继');
  });
  it('streams a code block larger than the parse workspace without retaining its prefix', () => {
    const content = 'const 长变量 = "🙂"; // 窄屏连续代码\n'.repeat(18000);
    const source = `\`\`\`typescript\n${content}\`\`\`\n结束`;
    const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
    for (let position = 0; position < source.length; position += 8192) {
      for (const change of projection.feed(source.slice(position, position + 8192))) apply(items, change);
      expect(projection.retainedBytes).toBeLessThan(BODY_PARSE_BYTES);
    }
    for (const change of projection.end()) apply(items, change);
    expect(items.map(item => item.text).join('')).toBe(source);
    expect(visible(items)).toBe(content + '结束');
    expect(projection.retainedBytes).toBe(0);
  });
  it('amends a previously published paragraph into a table without duplicating its header', () => {
    const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
    for (const change of projection.feed('| 名称 | 值 |\n')) apply(items, change);
    expect(items[0]?.body.context.nodes[0]?.kind).toBe('paragraph');
    for (const change of projection.feed('| --- | --- |\n| a\\|b | **粗体** |\n')) apply(items, change);
    for (const change of projection.end()) apply(items, change);
    const nodes = items.flatMap(item => item.body.context.nodes);
    expect(nodes.every(node => node.kind === 'table')).toBe(true);
    expect(visible(items)).toBe('名称值a|b粗体');
    expect(nodes.filter(node => node.header).flatMap(node => node.runs).map(run => run.text).join('')).toBe('名称值');
  });
  it('keeps nested quote/list source positions and formatted inline content', () => {
    const source = '> - **一项**\n>   继续\n> - 第二项\n\n# 标题\n';
    const items = live(source, 5);
    expect(items.map(item => item.text).join('')).toBe(source);
    expect(visible(items)).toContain('一项');
    expect(visible(items)).not.toContain('**');
    expect(items.some(item => item.body.context.nodes.some(node => node.kind === 'heading'))).toBe(true);
    expect(items.every(item => validateBodyMetadata(item.body, item.contentOffset, item.text.length))).toBe(true);
  });
  it('releases completed table rows and list items instead of retaining a long aggregate token', () => {
    const source = '| 名称 | 值 |\n| --- | --- |\n' + '| cell | **value** |\n'.repeat(15000) +
      '\n' + '- 列表 **项目**\n'.repeat(25000);
    const projection = new TerminalBodyProjection('markdown');
    let appended = 0;
    for (let position = 0; position < source.length; position += 8192) {
      for (const change of projection.feed(source.slice(position, position + 8192))) if (change.kind === 'append') appended += change.text.length;
      expect(projection.retainedBytes).toBeLessThan(BODY_PARSE_BYTES);
    }
    for (const _change of projection.end()) { /* close the last source range */ }
    expect(appended).toBe(source.length);
  });
  it.each([
    ['table', '| 名称 | 值 |\n| --- | --- |\n| a | b |\n', '\n'],
    ['fence', '```ts\nconst x = 1;\n', '```\n\n'],
  ])('releases the completed list tail in the same step that ends a carried %s', (_kind, opening, closing) => {
    const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
    const list = '- 列表 **项目**\n'.repeat(650);
    for (const change of projection.feed(opening!)) apply(items, change);
    for (const change of projection.feed(closing! + list)) apply(items, change);
    expect(projection.retainedBytes).toBeLessThan(256);
    for (const change of projection.feed(list)) apply(items, change);
    for (const change of projection.end()) apply(items, change);
    expect(items.map(item => item.text).join('')).toBe(opening! + closing! + list + list);
    expect(visible(items).match(/项目/gu)).toHaveLength(1300);
    expect(items.every(item => validateBodyMetadata(item.body, item.contentOffset, item.text.length))).toBe(true);
  });
  it('uses real EOF to release unfinished inline text, independently of transport boundaries', () => {
    const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
    for (const change of projection.feed('前缀 **没有闭合')) apply(items, change);
    expect(visible(items)).toBe('前缀 ');
    expect(items.every(item => !item.body.end)).toBe(true);
    for (const change of projection.end()) apply(items, change);
    expect(visible(items)).toBe('前缀 **没有闭合');
    expect(items.at(-1)?.body.end).toBe(true);
    expect([...projection.end()]).toEqual([]);
    expect(() => [...projection.feed('迟到')]).toThrow('terminal-body-projection-state');
  });
  it('produces identical final forward and reverse cold slices with bounded cooperative replay', async () => {
    const source = Array.from({ length: 70 }, (_, index) => `## 小节 ${index}\n\n文字 **${'内容'.repeat(800)}**\n\n`).join('') + '未闭合 `尾部';
    const forward: BodyAppend[] = [], reverse: BodyAppend[] = [];
    for await (const item of projectBodyHistory(source, 'markdown', 'forward', noWait)) forward.push(item);
    for await (const item of projectBodyHistory(source, 'markdown', 'reverse', noWait)) reverse.push(item);
    expect(reverse.map(item => item.contentOffset)).toEqual(forward.map(item => item.contentOffset).reverse());
    expect(reverse.reverse().map(item => ({ text: item.text, nodes: item.body.context.nodes, end: item.body.end })))
      .toEqual(forward.map(item => ({ text: item.text, nodes: item.body.context.nodes, end: item.body.end })));
    expect(visible(forward)).toContain('未闭合 `尾部');
  });
  it('does not infer Markdown from a role and preserves plain long source', async () => {
    const source = '**原样**\r\n'.repeat(40000), items: BodyAppend[] = [];
    for await (const item of projectBodyHistory(source, 'plain', 'forward', noWait)) items.push(item);
    expect(items.every(item => item.body.kind === 'plain')).toBe(true);
    expect(visible(items)).toBe(source);
  });
  it.each(['\r\n', '\r'])('maps normalized %j Markdown back to original UTF-16 across cold pages', async newline => {
    const source = [
      ...Array.from({ length: 20 }, (_, index) => `## 小节 ${index}${newline}${newline}文字 **${'内容'.repeat(100)}**${newline}${newline}`),
      `| 表头 | 值 |${newline}| --- | --- |${newline}`,
      ...Array.from({ length: 800 }, () => `| 单元 | **正确** |${newline}`), newline,
      ...Array.from({ length: 800 }, () => `- **项目** 继续${newline}`), newline,
      `\`\`\`typescript${newline}`, ...Array.from({ length: 1000 }, () => `const x = "中文🙂";${newline}`),
      `\`\`\`${newline}最后 **尾部**`,
    ].join('');
    const items = live(source, 257);
    expect(items.map(item => item.text).join('')).toBe(source);
    expect(items.every(item => validateBodyMetadata(item.body, item.contentOffset, item.text.length))).toBe(true);
    expect(visible(items)).toContain('最后 尾部');
    expect(visible(items)).not.toContain('\r');
    const tail = items.flatMap(item => item.body.context.nodes.flatMap(node => node.runs)).find(run => run.text === '尾部');
    expect(tail?.from).toBe(source.lastIndexOf('尾部'));
    const forward: BodyAppend[] = [], reverse: BodyAppend[] = [];
    for await (const item of projectBodyHistory(source, 'markdown', 'forward', noWait)) forward.push(item);
    for await (const item of projectBodyHistory(source, 'markdown', 'reverse', noWait)) reverse.push(item);
    expect(reverse.reverse().map(item => [item.contentOffset, item.text, item.body.context, item.body.end]))
      .toEqual(forward.map(item => [item.contentOffset, item.text, item.body.context, item.body.end]));
  });
  it('keeps a CR held across feeds instead of committing half of a CRLF code line', () => {
    const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
    for (const part of ['```ts\r', '\nline one\r', '\nline two\r', '\n```\r', '\n尾部']) {
      for (const change of projection.feed(part)) apply(items, change);
    }
    for (const change of projection.end()) apply(items, change);
    expect(items.map(item => item.text).join('')).toBe('```ts\r\nline one\r\nline two\r\n```\r\n尾部');
    expect(visible(items)).toBe('line one\nline two\n尾部');
    expect(items.every(item => validateBodyMetadata(item.body, item.contentOffset, item.text.length))).toBe(true);
  });
  it.each(['\n', '\r\n', '\r'])('maps the lexer final-list whitespace token without inventing a source newline (%j)', newline => {
    for (const whitespace of [' ', '\t']) {
      const prefix = `- **先项** 继续${newline}- **尾项**${whitespace}`;
      const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
      for (const change of projection.feed(prefix)) apply(items, change);
      expect(items.map(item => item.text).join('')).toBe(prefix);
      expect(visible(items)).toBe('- 先项 继续- 尾项');
      for (const change of projection.feed(`续文${newline}`)) apply(items, change);
      for (const change of projection.end()) apply(items, change);
      expect(items.map(item => item.text).join('')).toBe(prefix + `续文${newline}`);
      expect(visible(items)).toContain('尾项');
      expect(visible(items)).toContain('续文');
      expect(visible(items)).toBe('- 先项 继续- 尾项' + (whitespace === '\t' ? '    ' : ' ') + '续文');
      const tail = items.flatMap(item => item.body.context.nodes.flatMap(node => node.runs)).find(run => run.text === '尾项');
      expect(tail?.from).toBe(prefix.indexOf('尾项'));
      expect(tail?.to).toBe(prefix.indexOf('尾项') + 2);
      if (whitespace === '\t') {
        const replacement = items.flatMap(item => item.body.context.nodes.flatMap(node => node.runs)).filter(run => run.from === prefix.length - 1);
        expect(replacement.map(run => [run.from, run.to, run.text])).toEqual([[prefix.length - 1, prefix.length, '    ']]);
      }
      expect(items.every(item => validateBodyMetadata(item.body, item.contentOffset, item.text.length))).toBe(true);
      const ended = live(prefix, prefix.length);
      expect(visible(ended)).toBe('- 先项 继续- 尾项');
      expect(ended.map(item => item.text).join('')).toBe(prefix);
    }
  });
  it.each(['\n', '\r\n', '\r'])('keeps real leading blank lines distinct from trailing horizontal whitespace (%j)', newline => {
    const source = ['```ts', 'const value = 1;', '```', '', '| 项目 | 状态 |', '| --- | --- |',
      '| 中文 | 完成 |', '', '> 引用', '', '尾部正文 '].join(newline);
    const expected = visible(live(source, source.length));
    // Every possible two-chunk boundary includes a code close followed by a
    // partial table row. A real space token must not consume the row's space.
    for (let boundary = 1; boundary < source.length; boundary++) {
      const parser = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
      for (const part of [source.slice(0, boundary), source.slice(boundary)]) {
        for (const change of parser.feed(part)) apply(items, change);
      }
      for (const change of parser.end()) apply(items, change);
      expect(items.map(item => item.text).join('')).toBe(source);
      expect(visible(items), `boundary ${boundary}: ${JSON.stringify(source.slice(0, boundary))}`).toBe(expected);
      expect(items.every(item => validateBodyMetadata(item.body, item.contentOffset, item.text.length))).toBe(true);
    }
  });
  it('keeps list tab expansion and lazy continuation source ranges through a streamed Unicode item', () => {
    const source = '- **🙂甲**\t尾部\n  延伸\t内容\n懒续\t原样';
    const complete = live(source, source.length), streamed = live(source, 7);
    expect(visible(complete)).toBe('- 🙂甲    尾部\n延伸    内容\n懒续\t原样');
    expect(visible(streamed)).toBe(visible(complete));
    expect(streamed.map(item => item.text).join('')).toBe(source);
    for (const items of [complete, streamed]) {
      expect(items.every(item => validateBodyMetadata(item.body, item.contentOffset, item.text.length))).toBe(true);
      const expanded = items.flatMap(item => item.body.context.nodes.flatMap(node => node.runs)).filter(run => run.text === '    ');
      const firstTab = source.indexOf('\t'), secondTab = source.indexOf('\t', firstTab + 1);
      expect(expanded.map(run => [run.from, run.to])).toEqual([
        [firstTab, firstTab + 1], [secondTab, secondTab + 1],
      ]);
    }
  });
  it('rejects a stale amendment predecessor and seals an abandoned publication', () => {
    const projection = new TerminalBodyProjection('markdown'), items: BodyAppend[] = [];
    for (const change of projection.feed('before **')) apply(items, change);
    const feed = projection.feed('after**'), change = feed.next().value;
    expect(change?.kind).toBe('amend');
    if (change?.kind !== 'amend') throw Error('expected amendment');
    expect(() => change.project(0, items[0]!.text.length, { ...items[0]!.body, revision: change.revision }))
      .toThrow('terminal-body-amend-predecessor');
    feed.return(undefined);
    expect(() => [...projection.feed('late')]).toThrow('terminal-body-projection-state');
    expect(projection.retainedBytes).toBe(0);
  });
  it('gives closed and streamed indented fences the same newlines and source coordinates', () => {
    const source = '  ```ts\r\n  const 甲 = "🙂";\r\n  next();\r\n  ```\r\n尾部';
    const complete = live(source, source.length), streamed = live(source, 1);
    expect(visible(complete)).toBe('const 甲 = "🙂";\nnext();\n尾部');
    expect(visible(streamed)).toBe(visible(complete));
    expect(streamed.map(item => item.text).join('')).toBe(source);
    expect(streamed.every(item => validateBodyMetadata(item.body, item.contentOffset, item.text.length))).toBe(true);
  });
  it('keeps forward reference dependencies until their definition and carries committed definitions', async () => {
    const source = '[early]: https://example.invalid/early\r\n\r\n' +
      '普通段落\r\n\r\n'.repeat(9000) + '已定义 [已有][early]\r\n\r\n' +
      '晚定义 [稍后][late]\r\n\r\n| 列 |\r\n| --- |\r\n| [表内][late] |\r\n\r\n' +
      '[late]: https://example.invalid/late\r\n\r\n最后';
    const forward: BodyAppend[] = [], reverse: BodyAppend[] = [];
    for await (const item of projectBodyHistory(source, 'markdown', 'forward', noWait)) forward.push(item);
    for await (const item of projectBodyHistory(source, 'markdown', 'reverse', noWait)) reverse.push(item);
    expect(forward.map(item => item.text).join('')).toBe(source);
    expect(visible(forward)).toContain('已定义 已有');
    expect(visible(forward)).toContain('晚定义 稍后');
    expect(visible(forward)).toContain('表内');
    expect(visible(forward)).not.toContain('https://');
    const links = forward.flatMap(item => item.body.context.nodes.flatMap(node => node.runs)).filter(run => run.style & BODY_STYLE.link);
    expect(links.map(run => run.text).join('')).toBe('已有稍后表内');
    expect(links.map(run => run.href)).toEqual(['https://example.invalid/early', 'https://example.invalid/late', 'https://example.invalid/late']);
    expect(reverse.reverse().map(item => [item.contentOffset, item.body.context, item.body.end]))
      .toEqual(forward.map(item => [item.contentOffset, item.body.context, item.body.end]));
  });
  it('rejects parser capacity without fabricating EOF or deleting accepted source', () => {
    const projection = new TerminalBodyProjection('markdown');
    for (const _change of projection.feed('x'.repeat(BODY_PARSE_BYTES))) { /* accepted prefix */ }
    const accepted = projection.contentOffset;
    expect(() => [...projection.feed('overflow')]).toThrow('terminal-body-projection-capacity');
    expect(projection.contentOffset).toBe(accepted);
    projection.dispose();
    expect(projection.retainedBytes).toBe(0);
  });
});
