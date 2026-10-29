// Build the two finite scheduling stimuli from the exact production source.
// Test artifacts have their own addon instance; its process-global seal is not reusable.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
const run=promisify(execFile), root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='win32'||process.arch!=='x64') throw Error('This native regression targets Windows x64');
const compiler=process.env.ZHIXING_RECOVERY_ZIG_BINARY;
if(!compiler)throw Error('Provide the pinned ZHIXING_RECOVERY_ZIG_BINARY');
const inputs=JSON.parse(await readFile(path.join(root,'native/build-inputs.json'),'utf8'));
if((await run(compiler,['version'],{windowsHide:true})).stdout.trim()!==inputs.versions.recoveryZig)throw Error('Native compiler version mismatch');
const source=await readFile(path.join(root,'native/exec-gate-win32.c'),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const output=path.join(root,'build/writer-deadline-tests');
const artifact=await readFile(path.join(root,'dist/win32-x64/foreground.node'));
await mkdir(output,{recursive:true});
for(const point of ['after-resumed','before-resumed']){
 const directory=path.join(output,point);await mkdir(directory,{recursive:true});
 const anchor=point==='before-resumed'?'  HANDLE watcher = NULL;':'  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) fail();';
 if(source.split(anchor).length!==2)throw Error('Native delay anchor is not unique');
 const file=path.join(directory,'exec-gate.c');
 await writeFile(file,source.replace(anchor,'  Sleep(6000); /* test-only scheduler pause */\n'+anchor));
 await copyFile(path.join(root,'dist/win32-x64/foreground.node'),path.join(directory,'foreground.node'));
 await run(compiler,['cc','-target',inputs.targets['win32-x64'].zig,'-municode','-O2','-Wall','-Wextra',file,'-o',path.join(directory,'exec-gate.exe')],{cwd:directory,windowsHide:true,maxBuffer:1024*1024});
 await writeFile(path.join(directory,'identity.json'),JSON.stringify({sourceSha256:hash(source),addonSha256:hash(artifact),gateSha256:hash(await readFile(path.join(directory,'exec-gate.exe'))),point},null,2));
 console.log('Built '+point+' from '+hash(source));
}