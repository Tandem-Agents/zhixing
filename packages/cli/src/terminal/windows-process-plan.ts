import { open, stat } from 'node:fs/promises';
import path from 'node:path';

function environment(env: NodeJS.ProcessEnv, key: string): string | undefined {
  // Match the native gate's case-insensitive last-defined-key replacement.
  let result: string | undefined;
  for (const [name, value] of Object.entries(env)) if (value !== undefined && name.toLowerCase() === key.toLowerCase()) result = value;
  return result;
}

/** Resolve against the child's cwd/PATH; never change the owner's process cwd. */
export async function resolveWindowsExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const qualified = /[\\/:]/u.test(command);
  const directories = qualified ? [''] : [cwd, ...(environment(env, 'PATH') ?? '').split(';')];
  const extensions = path.win32.extname(command) ? [''] : ['', ...(environment(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => /^\.[a-z0-9]+$/iu.test(ext))];
  for (const directory of directories) {
    const base = path.win32.resolve(cwd, directory.replace(/^"|"$/gu, ''), command);
    for (const extension of extensions) {
      const file = base + extension;
      if (await stat(file).then(value => value.isFile(), () => false)) return file;
    }
  }
  throw Object.assign(Error('terminal-helper-executable-not-found'), { code: 'ENOENT' });
}

// cmd has a second parser in addition to Windows argv quoting. Escape its
// metacharacters, including quotes, before /s /c receives the complete string.
const meta = /([()\][%!^"`<>&|;, *?])/gu;
function shellArgument(value: string, shim: boolean): string {
  let quoted = '"';
  for (let at = 0; at < value.length;) {
    let slashes = 0;
    while (value[at] === '\\') { slashes++; at++; }
    quoted += '\\'.repeat(at === value.length || value[at] === '"' ? slashes * 2 : slashes);
    if (at === value.length) break;
    if (value[at] === '"') quoted += '\\';
    quoted += value[at++]!;
  }
  quoted = (quoted + '"').replace(meta, '^$1');
  return shim ? quoted.replace(meta, '^$1') : quoted;
}

export async function windowsProcessPlan(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ executable: string; args: readonly string[]; verbatim: boolean }> {
  let executable = await resolveWindowsExecutable(command, env, cwd);
  if (!/\.(?:com|exe|cmd|bat)$/iu.test(executable)) {
    const handle = await open(executable, 'r');
    let header: string;
    try { const bytes = Buffer.alloc(150); const read = await handle.read(bytes, 0, bytes.length, 0); header = bytes.subarray(0, read.bytesRead).toString('utf8'); }
    finally { await handle.close(); }
    const shebang = /^#!\s*(?:\S*\/env\s+)?(\S+)(?:\s+([^\r\n]+))?/u.exec(header);
    if (!shebang) throw Object.assign(Error('terminal-helper-executable-format'), { code: 'ENOEXEC' });
    args = [...(shebang[2] ? [shebang[2]] : []), executable, ...args];
    executable = await resolveWindowsExecutable(path.posix.basename(shebang[1]!), env, cwd);
  }
  if (/\.(?:exe|com)$/iu.test(executable)) return { executable, args, verbatim: false };
  if ([executable, ...args].some(value => /[\r\n]/u.test(value))) throw Error('terminal-helper-script-line-break');
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(executable);
  const commandLine = [executable.replace(meta, '^$1'), ...args.map(arg => shellArgument(arg, shim))].join(' ');
  const shell = environment(env, 'ComSpec') ?? path.win32.join(environment(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return { executable: await resolveWindowsExecutable(shell, env, cwd), args: ['/d', '/s', '/c', `"${commandLine}"`], verbatim: true };
}
