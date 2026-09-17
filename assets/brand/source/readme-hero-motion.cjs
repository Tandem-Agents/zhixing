// 两种语言共用的屏幕响应与跨端光流时序。
function animateResponse(t) {
  const clamp = x => Math.max(0, Math.min(1, x));
  const ease = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  const envelope = (a, b, c, d) => ease((t - a) / (b - a)) * (1 - ease((t - c) / (d - c)));
  const set = (id, attr, value) => document.getElementById(`response-${id}`).setAttribute(attr, value);
  set('phone', 'opacity', envelope(.25, .65, 1.3, 1.95));
  set('office', 'opacity', envelope(1.32, 1.82, 3.45, 4.15));
  set('cafe', 'opacity', envelope(2.67, 3.17, 3.8, 4.5));
  set('complete', 'opacity', envelope(4.62, 5.12, 5.55, 6));
  set('office-sheen', 'transform', `translate(${ease((t - 1.7) / 1.7) * 220} 0)`);
  set('cafe-sheen', 'transform', `translate(${ease((t - 3) / .85) * 180} 0)`);
  set('office-progress', 'stroke-dashoffset', 1 - ease((t - 1.8) / 1.5));
  set('cafe-progress', 'stroke-dashoffset', 1 - ease((t - 3.1) / .7));
  for (const [name, start, end] of [['request',.55,1.4],['collaborate',1.85,2.75],['return',3.65,4.7]]) {
    const progress = clamp((t-start)/(end-start));
    const flow = document.getElementById(`response-flow-${name}`);
    set(`thread-${name}`, 'opacity', envelope(start-.15,start+.15,5.6,6));
    flow.setAttribute('opacity', ease(progress/.14)*(1-ease((progress-.9)/.1)));
    const head = progress*1.13;
    for (const part of flow.querySelectorAll('[data-flow]')) {
      const length = part.dataset.flow === 'core' ? .06 : .15;
      const left = Math.max(0,head-length), right = Math.min(1,head);
      part.setAttribute('stroke-dasharray', `${Math.max(.00001,right-left)} 2`);
      part.setAttribute('stroke-dashoffset', -left);
    }
  }
}

module.exports = { animateResponse, duration: 8, fps: 20, activeSeconds: 6, staticTime: 3.2 };

