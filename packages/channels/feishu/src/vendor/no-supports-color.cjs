// debug 可选加载 supports-color，加载失败时使用默认颜色。此空实现与“未安装”等价，
// 让独立打包的扩展只依赖 Node 内置模块（见 tsup.config.ts 的 alias）。
module.exports = false;
