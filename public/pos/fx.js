// Sales-screen effects: tap ripples, "fly to cart", counting totals and a glow on the newest bill line.
// The shop picks the level in ธีมและรูปแบบ (pos_fx: extra / normal / off); off keeps the screen still.
const level = () => document.documentElement.dataset.posFx || 'normal';
const still = () => level() === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;

export function setFxLevel(v) { document.documentElement.dataset.posFx = ['extra', 'normal', 'off'].includes(v) ? v : 'normal'; }

// material-style ripple from the point that was touched
const RIPPLE = '.btn, .prod, .opt, .tab, .chip, .qp-tile, .seg button, .key, .qty button';
document.addEventListener('pointerdown', (e) => {
  if (still()) return;
  const el = e.target.closest(RIPPLE);
  if (!el || el.disabled) return;
  const r = el.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 2.2;
  const s = document.createElement('span');
  s.className = 'fx-rip';
  s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  // its own clipping layer, so badges that stick out of the button (e.g. counters) are not cut off
  const w = document.createElement('span');
  w.className = 'fx-ripw';
  w.append(s); el.append(w);
  setTimeout(() => w.remove(), 650);
}, { passive: true });

// a copy of the product picture arcs into the cart. The tap is remembered first (the grid re-renders after adding).
let tap = null;
export function rememberTap(el) {
  const img = el && (el.querySelector('.img') || el);
  tap = img ? { node: img.cloneNode(true), rect: img.getBoundingClientRect(), at: Date.now() } : null;
}
export function flyToCart() {
  const t = tap; tap = null;
  if (still() || !t || Date.now() - t.at > 30000) return;
  const target = [document.querySelector('.actions .pay'), document.querySelector('#mcart')].find((x) => x && x.getClientRects().length && x.getBoundingClientRect().width);
  if (!target) return;
  const a = t.rect, b = target.getBoundingClientRect();
  const ghost = t.node;
  ghost.classList.add('fx-fly');
  Object.assign(ghost.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', margin: 0 });
  document.body.append(ghost);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const anim = ghost.animate([
    { transform: 'translate(0,0) scale(1) rotate(0)', opacity: 1, offset: 0 },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.15 - 90}px) scale(.62) rotate(-8deg)`, opacity: 1, offset: 0.45 },
    { transform: `translate(${dx}px, ${dy}px) scale(.16) rotate(12deg)`, opacity: 0.2, offset: 1 },
  ], { duration: level() === 'extra' ? 720 : 560, easing: 'cubic-bezier(.45,.05,.55,.95)' });
  anim.onfinish = () => { ghost.remove(); target.classList.remove('fx-catch'); void target.offsetWidth; target.classList.add('fx-catch'); burst(target); };
}

// little sparks where the item lands (extra only)
function burst(el) {
  if (level() !== 'extra') return;
  const r = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = 'fx-burst';
  box.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px`;
  for (let i = 0; i < 12; i++) { const p = document.createElement('i'); p.style.setProperty('--a', i * 30 + 'deg'); box.append(p); }
  document.body.append(box);
  setTimeout(() => box.remove(), 700);
}

// count a money label from its last value to the new one ("1,234.00 ฿")
export function countTo(el, to, fmt) {
  if (!el) return;
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = to;
  if (still() || from === to) { el.textContent = fmt(to); return; }
  el.classList.remove('fx-bump'); void el.offsetWidth; el.classList.add('fx-bump');
  const t0 = performance.now(), ms = 420;
  const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
  el.textContent = fmt(from);
  requestAnimationFrame(step);
}

// remember which bill line changed last so the cart can glow it
let prev = new Map(), latest = null;
export function lineChanges(lines, keyOf) {
  const now = new Map(), fresh = new Set(), more = new Set();
  let last = null;
  for (const l of lines) now.set(keyOf(l), (now.get(keyOf(l)) || 0) + l.qty);
  for (const [k, q] of now) { const was = prev.get(k); if (was === undefined) { if (prev.size || lines.length === 1) { fresh.add(k); last = k; } } else if (q > was) { more.add(k); last = k; } }
  prev = now;
  if (last) latest = last; else if (latest && !now.has(latest)) latest = null;
  return { fresh, more, latest };
}
export function resetLines() { prev = new Map(); latest = null; }
