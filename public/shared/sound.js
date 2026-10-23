// "ติ๊ด ๆ ๆ ๆ" generated with Web Audio (no file needed) or a custom uploaded sound.
let ctx = null;
const ac = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());
// browsers allow audio only after a user gesture: call unlock() from any click
export function unlock() { try { const c = ac(); if (c.state === 'suspended') c.resume(); } catch { /* no audio */ } }
export async function beep({ count = 4, volume = 0.8, freq = 2600, ms = 90, gap = 70 } = {}) {
  try {
    const c = ac();
    if (c.state === 'suspended') await c.resume();
    let t = c.currentTime + 0.02;
    for (let i = 0; i < count; i++) {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(volume * 0.25, t + 0.005); g.gain.setValueAtTime(volume * 0.25, t + ms / 1000); g.gain.linearRampToValueAtTime(0, t + ms / 1000 + 0.01);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
      t += (ms + gap) / 1000;
    }
    return true;
  } catch { return false; }
}
export async function playFile(url, { volume = 0.8, count = 1 } = {}) {
  for (let i = 0; i < count; i++) {
    const a = new Audio(url); a.volume = Math.max(0, Math.min(1, volume));
    try { await a.play(); await new Promise((r) => { a.onended = r; setTimeout(r, 8000); }); } catch { return false; }
  }
  return true;
}
// kind: 'printed' | 'new_order' | 'error'
export async function playSound(settings, kind = 'printed', device = 'pos') {
  const s = settings || {};
  if (!s.enabled) return;
  if (kind === 'printed' && !(s.output || []).includes(device)) return;
  const file = kind === 'error' ? s.error_file : kind === 'new_order' ? s.new_order_file : s.file;
  if (file) return playFile(file, { volume: s.volume, count: kind === 'printed' ? 1 : 1 });
  if (kind === 'error') return beep({ count: 2, volume: s.volume, freq: 400, ms: 350, gap: 120 });
  if (kind === 'new_order') return beep({ count: 3, volume: s.volume, freq: 1400, ms: 160, gap: 90 });
  return beep({ count: s.count || 4, volume: s.volume });
}
