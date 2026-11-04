/**
 * 默认交互入口的启动提示：命令一进入交互分支就在原屏当前行写一行，让用户立刻看到知行已在启动。
 * 恢复进程把终端切入界面模式之前，S 是这块屏幕唯一的写者；切换前、启动失败输出提示前、进程退出时都清掉这一行，
 * 交还的原屏上不留残余。只写这一行、不换行，也不保存或恢复光标：原屏其余内容和光标位置保持不变。
 * 经 process.stdout 写：Windows 控制台上它按宽字符输出，直接写文件描述符会按控制台代码页解释字节，中文成乱码。
 * 清除只用回车和空格覆盖，不依赖终端序列。
 */
const HINT = '知行正在启动…';
// 按最宽情形计列宽（中日韩字符与省略号各两列），覆盖时宁多不少
const HINT_COLUMNS = [...HINT].length * 2;
let shown = false;

export function showStartupHint(): void {
  if (shown) return;
  try {
    process.stdout.write(`\r${HINT}`);
    shown = true;
    process.once('exit', clearStartupHint);
  } catch { /* 提示只是反馈，写不出来不影响启动 */ }
}

export function clearStartupHint(): void {
  if (!shown) return;
  shown = false;
  try { process.stdout.write(`\r${' '.repeat(HINT_COLUMNS)}\r`); } catch { /* 屏幕已不可写时无可清除 */ }
}
