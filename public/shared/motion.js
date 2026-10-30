// Smooth list changes for every screen: items glide to their new place, new ones grow in, removed ones fade out where they were.
// Only transform and opacity are animated (GPU friendly, smooth on cheap tablets). Turned off by "reduce motion" and pos_fx = off.
export const EASE = 'cubic-bezier(.22, 1, .36, 1)';
export const SPRING = 'cubic-bezier(.34, 1.4, .64, 1)';
export const still = () => document.documentElement.dataset.posFx === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;

// flip(() => container, update): children carrying data-k are matched by key before and after update().
// The container may be replaced by update() (whole panels are re-rendered), so it is looked up again afterwards.
export function flip(getBox, update, { enter = true, exit = true, ms = 420 } = {}) {
  const box0 = getBox();
  if (still() || !box0) { update(); return; }
  const before = new Map();
  for (const el of box0.querySelectorAll(':scope > [data-k]')) {
    const r = el.getBoundingClientRect();
    if (r.width || r.height) before.set(el.dataset.k, { r, el });
  }
  update();
  const box = getBox(); if (!box) return;
  const seen = new Set();
  for (const el of box.querySelectorAll(':scope > [data-k]')) {
    const k = el.dataset.k, b = before.get(k);
    seen.add(k);
    if (!b) { if (enter && before.size) el.animate([{ opacity: 0, transform: 'translateY(10px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: ms, easing: SPRING, fill: 'backwards' }); continue; }
    const r = el.getBoundingClientRect();
    const dx = b.r.left - r.left, dy = b.r.top - r.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: ms, easing: EASE });
  }
  if (!exit) return;
  // gone: a copy fades and shrinks out at its old spot, above everything, without taking room in the list
  for (const [k, { r, el }] of before) {
    if (seen.has(k)) continue;
    const g = el.cloneNode(true);
    Object.assign(g.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: 0, pointerEvents: 'none', zIndex: 40, boxSizing: 'border-box' });
    document.body.append(g);
    const a = g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-24px) scale(.92)' }], { duration: ms * 0.75, easing: EASE, fill: 'forwards' });
    a.onfinish = () => g.remove();
  }
}

// animate an element out, then run done (removing it); falls back to done() at once when motion is off
export function leave(el, cls, done, ms = 260) {
  if (!el || still()) return done();
  el.classList.add(cls);
  let finished = false;
  const end = () => { if (finished) return; finished = true; done(); };
  el.addEventListener('animationend', end, { once: true });
  setTimeout(end, ms + 80); // safety: no animationend when the element is hidden
}
