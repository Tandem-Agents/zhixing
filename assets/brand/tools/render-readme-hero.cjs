// 从正式源稿导出全彩 APNG 与静态 PNG，不依赖任务目录。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const resolveDependency = process.env.README_NODE_MODULES
  ? createRequire(path.join(process.env.README_NODE_MODULES, '_readme.cjs')) : require;
const { chromium } = resolveDependency('playwright');
const { animateResponse, duration, fps, activeSeconds, staticTime } = require('../source/readme-hero-motion.cjs');
const brand = path.resolve(__dirname, '..');
const source = path.join(brand, 'source');

async function main() {
  const language = process.argv[2] || 'zh';
  if (!['zh','en'].includes(language)) throw new Error('用法：node render-readme-hero.cjs [zh|en]');
  const stem = `readme-hero${language === 'en' ? '.en' : ''}`;
  const browser = await chromium.launch({headless:true, ...(process.env.README_BROWSER ? {executablePath:process.env.README_BROWSER} : {})});
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixing-brand-render-'));
  try {
    const page = await browser.newPage({viewport:{width:1200,height:630},deviceScaleFactor:1});
    const base = fs.readFileSync(path.join(source, `${stem}.svg`), 'utf8').replace(/(<image\b[^>]*?\bhref=")([^"]+)(")/g,
      (_, before, src, after) => before + 'data:image/png;base64,' + fs.readFileSync(path.resolve(source, src)).toString('base64') + after);
    await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block}</style>' + base);
    await page.evaluate(svg => {
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (parsed.querySelector('parsererror')) throw new Error('动效 SVG 无法解析');
      for (const element of [...parsed.documentElement.children]) document.querySelector('svg').appendChild(document.importNode(element, true));
    }, fs.readFileSync(path.join(source, 'readme-hero-motion.svg'), 'utf8'));
    await page.evaluate(() => document.fonts.ready);
    const timing = [];
    for (let index = 0; index <= activeSeconds*fps; index++) {
      await page.evaluate(`(${animateResponse.toString()})(${index/fps})`);
      await page.screenshot({path:path.join(scratch, `frame-${String(index).padStart(3,'0')}.png`),omitBackground:true});
      timing.push(index === activeSeconds*fps ? (duration-activeSeconds)*1000 : 1000/fps);
      if (index % (2*fps) === 0) console.log(`${language}: ${index/fps}s rendered`);
    }
    fs.writeFileSync(path.join(scratch, 'timing.json'), JSON.stringify(timing));
    const encode = String.raw`
import json, sys
from pathlib import Path
from PIL import Image
folder, output, static_index = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
frames = [Image.open(file).convert('RGBA') for file in sorted(folder.glob('frame-*.png'))]
assert frames[0].tobytes() == frames[-1].tobytes(), 'Loop frames differ'
frames[static_index].save(output.with_name(output.stem+'-static.png'))
timing = json.loads((folder/'timing.json').read_text())
frames[0].save(output, format='PNG', save_all=True, append_images=frames[1:], duration=timing, loop=0, disposal=0, blend=0)
image = Image.open(output)
elapsed = 0
for index in range(image.n_frames):
    image.seek(index)
    elapsed += image.info['duration']
assert elapsed == sum(timing)
assert image.convert('RGBA').tobytes() == frames[0].tobytes()
print(f'{output.name}: {image.size}; {image.n_frames} frames; {elapsed:.0f} ms; {output.stat().st_size} bytes')
`;
    const result = spawnSync(process.env.README_PYTHON || 'python', ['-c', encode, scratch, path.join(brand, `${stem}.png`), String(Math.round(staticTime*fps))], {stdio:'inherit'});
    if (result.status !== 0) throw new Error('APNG 导出失败');
  } finally {
    await browser.close();
    const resolved = fs.realpathSync(scratch), tempRoot = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('zhixing-brand-render-')) throw new Error('临时目录不在预期范围');
    fs.rmSync(resolved, {recursive:true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
