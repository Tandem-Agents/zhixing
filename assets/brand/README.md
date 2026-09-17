# 品牌与展示素材

| 素材 | 用途 | 状态 |
| --- | --- | --- |
| [README 中文主视觉](readme-hero.png) / [静态版](readme-hero-static.png) | 1200 × 630、8 秒循环的全彩 APNG；手机发起、异地屏幕响应、光流返回。静态版用于减少动态效果及直接查看 | 已正式采用，接入根目录 README |
| [README 英文主视觉](readme-hero.en.png) / [静态版](readme-hero.en-static.png) | 同一场景、布局和动效，仅本地化左侧文字 | 正式英文配套，已接入根目录 README.en.md |
| [伴身智能全景图](companion-panorama.png) | AI 生成的伴身智能愿景插画，非产品截图 | 2026-09-17 确认为正式候选，是否用于 README 待定；长期保留，即使不采用也不删除 |
| [独立办公室工位原图](office-workstation-source.png) | 正式场景所用的独立工位素材；原文件带模拟透明的棋盘格背景，不是透明 PNG | 当前正式版配套素材 |
| [跨端协作三场景·工位版](companion-three-scenes-office.png) | 办公室工位、户外手机与咖啡厅笔记本的暖白底合成图 | 当前正式主视觉的底图 |

## 正式源稿与导出

- 排版：[中文 SVG](source/readme-hero.svg)、[英文 SVG](source/readme-hero.en.svg)；共用上述工位版素材。
- 动效：[屏幕与连接图层](source/readme-hero-motion.svg)、[时序](source/readme-hero-motion.cjs)。
- [导出脚本](tools/render-readme-hero.cjs)：`node assets/brand/tools/render-readme-hero.cjs zh` 或 `en`，生成对应 APNG 与静态 PNG。

导出需要 Node.js、Playwright/Chromium，以及带 Pillow 的 Python；不自动安装依赖。可用 `README_NODE_MODULES` 指定已有 Node 模块目录、`README_BROWSER` 指定浏览器、`README_PYTHON` 指定 Python。字体使用 SVG 中声明的系统字体。

正式动效使用全彩 APNG（扩展名 `.png`），保留屏幕柔光的连续色阶；不以存在色带或颗粒的 GIF 替代。以上底图、排版、动效源稿与导出脚本构成完整维护入口。
