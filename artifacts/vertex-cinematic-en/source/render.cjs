/* Vertex2OpenAI cinematic introduction — deterministic 1080p60 renderer.
 * Every frame is drawn procedurally; no live API traffic, footage or third-party artwork.
 * Usage: node render.cjs [--stills] [--frame <seconds>]
 */
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {once} = require('events');
const {createCanvas} = require(process.env.CANVAS_MODULE || '/Users/akira/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..');
const STORY = JSON.parse(fs.readFileSync(path.join(__dirname, 'story.json')));
const {width: W, height: H, fps: FPS, duration: DURATION} = STORY;
const FF = process.env.FFMPEG || '/Users/akira/Documents/Codex/2026-10-07/pets-plugin-work-pets-openai-curated/work/preview-deps/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1';

const SANS = '"Helvetica Neue"', MONO = '".SF NS Mono"';
const C = {
  bg: '#05070B', white: '#F4F6FA', text: '#E7EBF2', dim: '#8A93A6', faint: '#4A5263', hair: 'rgba(255,255,255,0.09)',
  cool: '#A9BEFF', coolDeep: '#6F8FE8', warm: '#F2B48C', brand: '#F59A62', mint: '#A6E3C6', alert: '#F0907E', violet: '#C9BDF2',
};

const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
const layers = [createCanvas(W, H), createCanvas(W, H)];
const errors = new Set();
let NOW = 0, CHECK = true;

/* ---------- math ---------- */
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, p) => a + (b - a) * p;
const outExpo = v => (v = clamp(v)) === 1 ? 1 : 1 - Math.pow(2, -10 * v);
const outCubic = v => 1 - Math.pow(1 - clamp(v), 3);
const outQuart = v => 1 - Math.pow(1 - clamp(v), 4);
const inOut = v => { v = clamp(v); return v < .5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2; };
const smooth = v => { v = clamp(v); return v * v * (3 - 2 * v); };
const win = (t, a, b, fadeIn = .25, fadeOut = .25) => clamp((t - a) / fadeIn) * clamp((b - t) / fadeOut);
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------- drawing primitives ---------- */
function setFont(c, size, weight = 600, mono = false, track = 0) {
  c.font = `${weight} ${size}px ${mono ? MONO : SANS}`;
  c.letterSpacing = `${track}px`;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
}
function boundsCheck(c, x0, y0, x1, y1, label) {
  if (!CHECK || c.globalAlpha < .2) return;
  const m = c.getTransform();
  if (Math.abs(m.b) > 1e-4 || Math.abs(m.c) > 1e-4) return;
  const a = m.a * x0 + m.e, b = m.a * x1 + m.e, top = m.d * y0 + m.f, bot = m.d * y1 + m.f;
  if (a < 36 || b > W - 36 || top < 26 || bot > H - 26) errors.add(`t=${NOW.toFixed(2)} text outside safe area: ${label}`);
}
function measure(c, s) { return c.measureText(s).width; }
function startX(x, w, align) { return align === 'center' ? x - w / 2 : align === 'right' ? x - w : x; }
function gradFill(c, x0, x1, stops) {
  const g = c.createLinearGradient(x0, 0, x1, 0);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  return g;
}
/* Plain text with optional gradient. Returns width. */
function text(c, s, x, y, o = {}) {
  const {size = 32, weight = 500, mono = false, track = 0, align = 'left', color = C.text, gradient = null} = o;
  setFont(c, size, weight, mono, track);
  const w = measure(c, s), x0 = startX(x, w, align);
  c.fillStyle = gradient ? gradFill(c, x0, x0 + w, gradient) : color;
  boundsCheck(c, x0, y - size * .78, x0 + w, y + size * .24, s);
  c.fillText(s, x0, y);
  return w;
}
/* Per-character blur-in reveal. t is seconds since the reveal started. */
function blurText(c, s, x, y, t, o = {}) {
  const {size = 96, weight = 700, mono = false, track = 0, align = 'left', color = C.white, gradient = null, stagger = .028, dur = .55, rise = .32, blur = 14} = o;
  if (t <= 0) return 0;
  setFont(c, size, weight, mono, track);
  const w = measure(c, s), x0 = startX(x, w, align);
  const fill = gradient ? gradFill(c, x0, x0 + w, gradient) : color;
  const base = c.globalAlpha;
  boundsCheck(c, x0, y - size * .78, x0 + w, y + size * .24, s);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ') continue;
    const q = outCubic((t - i * stagger) / dur);
    if (q <= 0) continue;
    const px = x0 + measure(c, s.slice(0, i));
    c.globalAlpha = base * q;
    const b = (1 - q) * blur;
    if (b > .4) c.filter = `blur(${b.toFixed(1)}px)`;
    c.fillStyle = fill;
    c.fillText(ch, px, y + (1 - q) * size * rise);
    if (b > .4) c.filter = 'none';
  }
  c.globalAlpha = base;
  return w;
}
/* Line reveal: text rises from behind an invisible mask. */
function maskText(c, s, x, y, t, o = {}) {
  const {size = 80, dur = .7} = o;
  if (t <= 0) return 0;
  const q = outExpo(t / dur);
  c.save();
  c.beginPath(); c.rect(0, y - size * 1.05, W, size * 1.38); c.clip();
  const prev = CHECK; CHECK = q > .98 && prev;
  const w = text(c, s, x, y + (1 - q) * size * 1.25, o);
  CHECK = prev;
  c.restore();
  return w;
}
function fadeText(c, s, x, y, t, o = {}) {
  if (t <= 0) return 0;
  const q = outCubic(t / (o.dur || .6));
  c.save(); c.globalAlpha *= q; c.translate(0, (1 - q) * (o.rise ?? 18));
  const w = text(c, s, x, y, o); c.restore(); return w;
}
function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); }
function glass(c, x, y, w, h, r, o = {}) {
  const {fill = 'rgba(255,255,255,0.035)', edge = 'rgba(255,255,255,0.12)', shadow = true} = o;
  c.save();
  if (shadow) { c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 60; c.shadowOffsetY = 24; }
  rr(c, x, y, w, h, r); c.fillStyle = 'rgba(12,15,22,0.82)'; c.fill();
  c.restore();
  rr(c, x, y, w, h, r); c.fillStyle = fill; c.fill();
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, edge); g.addColorStop(1, 'rgba(255,255,255,0.03)');
  rr(c, x + .5, y + .5, w - 1, h - 1, r); c.strokeStyle = g; c.lineWidth = 1; c.stroke();
}
function line(c, pts, color, width = 2, cap = 'round') {
  c.beginPath(); pts.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
  c.strokeStyle = color; c.lineWidth = width; c.lineCap = cap; c.lineJoin = 'round'; c.stroke();
}
function dot(c, x, y, r, color) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = color; c.fill(); }
const sprites = {};
function glowSprite(color, size = 256) {
  const key = color + size;
  if (!sprites[key]) {
    const s = createCanvas(size, size), g = s.getContext('2d');
    const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    rg.addColorStop(0, color); rg.addColorStop(.25, color.replace(/[\d.]+\)$/, m => (parseFloat(m) * .35).toFixed(3) + ')'));
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, size, size); sprites[key] = s;
  }
  return sprites[key];
}
function glow(c, x, y, r, color, alpha = 1) {
  const s = glowSprite(color);
  c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha *= alpha;
  c.drawImage(s, x - r, y - r, r * 2, r * 2); c.restore();
}
function mark(c, x, y, s = 1, alpha = 1) {
  c.save(); c.translate(x, y); c.scale(s, s); c.globalAlpha *= alpha;
  const g = c.createLinearGradient(-30, -30, 30, 30); g.addColorStop(0, '#F8B07E'); g.addColorStop(1, '#E9844E');
  rr(c, -30, -30, 60, 60, 17); c.fillStyle = g; c.fill();
  line(c, [[-16, -9], [-5, 12], [3, -12], [15, 9]], '#121620', 4.4);
  dot(c, 15, 9, 3.2, '#121620');
  c.restore();
}
function sparkle(c, x, y, r, color) {
  c.beginPath(); c.moveTo(x, y - r);
  c.quadraticCurveTo(x + r * .14, y - r * .14, x + r, y); c.quadraticCurveTo(x + r * .14, y + r * .14, x, y + r);
  c.quadraticCurveTo(x - r * .14, y + r * .14, x - r, y); c.quadraticCurveTo(x - r * .14, y - r * .14, x, y - r);
  c.fillStyle = color; c.fill();
}
function brackets(c, x, y, s, color, width) {
  line(c, [[x - s * .18, y - s * .42], [x - s * .62, y], [x - s * .18, y + s * .42]], color, width);
  line(c, [[x + s * .18, y - s * .42], [x + s * .62, y], [x + s * .18, y + s * .42]], color, width);
}
function eyebrow(c, s, x, y, t, color = C.warm, align = 'left') {
  fadeText(c, s, x, y, t, {size: 19, weight: 500, mono: true, track: 4, color, align, rise: 10});
}

/* ---------- global atmosphere ---------- */
const vignette = (() => {
  const v = createCanvas(W, H), g = v.getContext('2d');
  const rg = g.createRadialGradient(W / 2, H / 2, H * .35, W / 2, H / 2, H * 1.05);
  rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,0.62)');
  g.fillStyle = rg; g.fillRect(0, 0, W, H); return v;
})();
const grains = Array.from({length: 6}, (_, k) => {
  const gw = 960, gh = 540, g = createCanvas(gw, gh), x = g.getContext('2d'), img = x.createImageData(gw, gh), r = rng(97 + k);
  for (let i = 0; i < img.data.length; i += 4) { const v = r() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  x.putImageData(img, 0, 0); return g;
});
const small = [createCanvas(480, 270), createCanvas(480, 270)];
function ambient(T) {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  glow(ctx, 1320 + Math.sin(T * .21) * 220, 300 + Math.cos(T * .17) * 120, 1050, 'rgba(70,96,170,0.30)');
  glow(ctx, 420 + Math.cos(T * .19) * 200, 860 + Math.sin(T * .23) * 90, 900, 'rgba(190,120,80,0.16)');
}
function post(T) {
  // Bloom: blur a quarter-resolution copy and screen it back.
  const [a, b] = small, ax = a.getContext('2d'), bx = b.getContext('2d');
  ax.clearRect(0, 0, 480, 270); ax.drawImage(canvas, 0, 0, 480, 270);
  bx.clearRect(0, 0, 480, 270); bx.filter = 'blur(7px)'; bx.drawImage(a, 0, 0); bx.filter = 'none';
  ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = .42; ctx.drawImage(b, 0, 0, W, H); ctx.restore();
  ctx.drawImage(vignette, 0, 0);
  ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = .07;
  ctx.drawImage(grains[Math.floor(T * FPS) % grains.length], 0, 0, W, H); ctx.restore();
}

/* ---------- scenes (c = layer context, t = seconds since scene start) ---------- */
function sceneSignal(c, t) {
  const y = 772;
  const head = lerp(-160, W + 160, inOut((t + .35) / 1.6));
  // persistent beam
  const g = c.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(169,190,255,0)'); g.addColorStop(.5, 'rgba(200,214,255,0.55)'); g.addColorStop(1, 'rgba(242,180,140,0)');
  c.save(); c.beginPath(); c.rect(0, y - 4, clamp(head, 0, W), 8); c.clip(); line(c, [[0, y], [W, y]], g, 1.4); c.restore();
  if (head > -100 && head < W + 100) {
    glow(c, head, y, 180, 'rgba(255,226,200,0.9)');
    const tail = c.createLinearGradient(head - 520, 0, head, 0); tail.addColorStop(0, 'rgba(242,180,140,0)'); tail.addColorStop(1, 'rgba(255,236,220,0.95)');
    line(c, [[head - 520, y], [head, y]], tail, 3);
  }
  // floating dust
  const r = rng(11);
  for (let i = 0; i < 70; i++) {
    const px = r() * W, py = r() * H, sp = .2 + r() * .8, a = .08 + r() * .22;
    dot(c, (px + t * 14 * sp) % W, py - t * 6 * sp, .8 + r() * 1.3, `rgba(220,228,255,${a})`);
  }
  eyebrow(c, 'OPENAI-COMPATIBLE  ·  VERTEX AI GEMINI', W / 2, 330, t - 2.3, C.dim, 'center');
  blurText(c, 'Speak OpenAI.', W / 2, 500, t - .45, {size: 140, weight: 700, track: -3, align: 'center', color: C.white});
  blurText(c, 'Run Gemini.', W / 2, 652, t - 1.35, {size: 140, weight: 700, track: -3, align: 'center', gradient: ['#B9C9FF', '#E9DDF7', '#F4BE98']});
}

function sceneBridge(c, t) {
  // perspective floor
  const vx = W / 2, vy = 560;
  c.save(); c.beginPath(); c.rect(0, 690, W, H - 690); c.clip();
  for (let i = -14; i <= 14; i++) {
    const a = .05 + .05 * (1 - Math.abs(i) / 14);
    line(c, [[vx + i * 30, vy], [vx + i * 330, H + 40]], `rgba(160,180,230,${a * outCubic(t / 1.2)})`, 1);
  }
  for (let k = 0; k < 12; k++) {
    const z = ((k + t * .9) % 12) / 12, yy = vy + 130 + Math.pow(z, 2.2) * 420;
    line(c, [[0, yy], [W, yy]], `rgba(160,180,230,${.11 * z * outCubic(t / 1.2)})`, 1);
  }
  c.restore();

  const nodes = [{x: 420, label: 'Your app', sub: 'OPENAI SDK'}, {x: 960, label: 'Vertex2OpenAI', sub: 'CLOUDFLARE WORKER'}, {x: 1500, label: 'Vertex AI', sub: 'GEMINI'}];
  const ny = 560;
  // rails
  const rail = outExpo((t - .5) / 1.1);
  [[nodes[0].x + 90, nodes[1].x - 110], [nodes[1].x + 110, nodes[2].x - 90]].forEach(([a, b]) => {
    const e = lerp(a, b, rail);
    line(c, [[a, ny - 10], [e, ny - 10]], 'rgba(242,180,140,0.28)', 1.5);
    line(c, [[a, ny + 10], [e, ny + 10]], 'rgba(169,190,255,0.28)', 1.5);
  });
  // packets: requests travel right on the warm rail, responses return on the cool rail
  if (t > 1.2) {
    for (let k = 0; k < 6; k++) {
      const p = ((t - 1.2) * .62 - k * .25);
      if (p < 0 || p > 1) continue;
      const x = lerp(nodes[0].x + 90, nodes[2].x - 90, p);
      if (x > nodes[1].x - 110 && x < nodes[1].x + 110) continue;
      glow(c, x, ny - 10, 34, 'rgba(255,200,160,0.9)'); dot(c, x, ny - 10, 2.6, '#FFE9D9');
      const xr = lerp(nodes[2].x - 90, nodes[0].x + 90, clamp(p - .12));
      if (p > .12 && !(xr > nodes[1].x - 110 && xr < nodes[1].x + 110)) { glow(c, xr, ny + 10, 34, 'rgba(170,195,255,0.9)'); dot(c, xr, ny + 10, 2.6, '#E6EDFF'); }
    }
  }
  nodes.forEach((n, i) => {
    const q = outQuart((t - .1 - i * .14) / .8);
    if (q <= 0) return;
    const s = i === 1 ? 200 : 150;
    c.save(); c.globalAlpha *= q; c.translate(n.x, ny + (1 - q) * 40);
    if (i === 1) glow(c, 0, 0, 260, 'rgba(245,154,98,0.32)', .8 + .2 * Math.sin(t * 3));
    glass(c, -s / 2, -s / 2, s, s, i === 1 ? 46 : 38, {edge: i === 1 ? 'rgba(255,214,186,0.30)' : 'rgba(255,255,255,0.14)'});
    if (i === 0) brackets(c, 0, 0, 62, C.cool, 4);
    if (i === 1) mark(c, 0, 0, 1.45);
    if (i === 2) { sparkle(c, 0, 0, 34, '#CFDBFF'); sparkle(c, 30, -28, 9, C.warm); }
    text(c, n.label, 0, s / 2 + 62, {size: i === 1 ? 34 : 30, weight: 600, align: 'center', color: C.white, track: -.5});
    text(c, n.sub, 0, s / 2 + 98, {size: 17, weight: 500, mono: true, track: 3, align: 'center', color: C.dim});
    c.restore();
  });
  maskText(c, 'Meet Vertex2OpenAI.', W / 2, 232, t - .2, {size: 92, weight: 700, track: -2, align: 'center', color: C.white});
  fadeText(c, 'An OpenAI-compatible adapter for Gemini on Vertex AI.', W / 2, 300, t - .7, {size: 30, weight: 400, align: 'center', color: C.dim});
}

const CODE = [
  [['import', 'k'], [' OpenAI ', 'i'], ['from', 'k'], [' "openai"', 's'], [';', 'p']],
  [],
  [['const', 'k'], [' client = ', 'i'], ['new', 'k'], [' OpenAI({', 'i']],
  [['  baseURL: ', 'i'], ['"https://<your-worker>.workers.dev/v1"', 's'], [',', 'p']],
  [['  apiKey: process.env.API_KEY', 'i'], [',', 'p']],
  [['});', 'p']],
  [],
  [['const', 'k'], [' stream = ', 'i'], ['await', 'k'], [' client.chat.completions.create({', 'i']],
  [['  model: ', 'i'], ['"gemini-4-carbon"', 's'], [',', 'p']],
  [['  reasoning_effort: ', 'i'], ['"medium"', 's'], [',', 'p']],
  [['  stream: ', 'i'], ['true', 'k'], [',', 'p']],
  [['  messages: [{ role: ', 'i'], ['"user"', 's'], [', content: ', 'i'], ['"Hi"', 's'], [' }]', 'i'], [',', 'p']],
  [['});', 'p']],
];
const TOK = {k: C.violet, i: '#E3E7EF', s: C.mint, p: '#7F8899'};
const CODE_CHARS = CODE.reduce((n, l) => n + l.reduce((m, [s]) => m + s.length, 0) + 1, 0);
function sceneDropIn(c, t) {
  const L = 140;
  eyebrow(c, 'DROP-IN COMPATIBLE', L, 300, t - .05);
  maskText(c, 'Same SDK.', L, 410, t - .12, {size: 92, weight: 700, track: -2, color: C.white});
  maskText(c, 'New engine.', L, 510, t - .26, {size: 92, weight: 700, track: -2, gradient: ['#C3D0FF', '#F3BF9C']});
  ['/v1/chat/completions', '/v1/responses', '/v1/models'].forEach((s, i) => {
    const tt = t - .8 - i * .12;
    if (tt <= 0) return;
    c.save(); c.globalAlpha *= outCubic(tt / .5);
    dot(c, L + 6, 618 + i * 54 - 8, 4, i === 2 ? C.dim : C.warm);
    text(c, s, L + 28, 618 + i * 54, {size: 25, weight: 500, mono: true, color: C.text});
    c.restore();
  });
  fadeText(c, 'Chat Completions and Responses, with streaming.', L, 820, t - 1.2, {size: 24, weight: 400, color: C.dim});

  // code window
  const q = outQuart((t - .05) / 1);
  const x = 830, y = 196, w = 970, h = 640;
  c.save(); c.globalAlpha *= q; c.translate(0, (1 - q) * 70 + Math.sin(t * 1.3) * 4);
  glow(c, x + w / 2, y + h / 2, 640, 'rgba(90,120,210,0.20)');
  glass(c, x, y, w, h, 26);
  [0, 1, 2].forEach(i => dot(c, x + 34 + i * 22, y + 32, 6, 'rgba(255,255,255,0.18)'));
  text(c, 'chat.ts', x + w / 2, y + 39, {size: 17, mono: true, color: C.dim, align: 'center'});
  line(c, [[x, y + 64], [x + w, y + 64]], C.hair, 1);
  let budget = Math.floor(clamp((t - .35) / 1.75) * CODE_CHARS);
  const lh = 38, cx0 = x + 40, cy0 = y + 118;
  let caret = null;
  // highlight the two lines that change when moving from OpenAI to Gemini
  const hl = outCubic((t - 2.3) / .5);
  if (hl > 0) [3, 8].forEach(li => { rr(c, x + 18, cy0 + li * lh - 27, w - 36, 36, 8); c.fillStyle = `rgba(242,180,140,${.10 * hl})`; c.fill(); dot(c, x + 24, cy0 + li * lh - 9, 3, `rgba(242,180,140,${hl})`); });
  CODE.forEach((toks, li) => {
    let cx = cx0; const cy = cy0 + li * lh;
    for (const [s, k] of toks) {
      if (budget <= 0) break;
      const part = s.slice(0, budget); budget -= part.length;
      setFont(c, 21, 400, true); c.fillStyle = TOK[k]; c.fillText(part, cx, cy);
      cx += measure(c, part);
      if (part.length < s.length) { caret = [cx, cy]; break; }
    }
    if (budget > 0) { budget -= 1; caret = [cx, cy]; }
  });
  if (caret && Math.floor(t * 3) % 2 === 0) { c.fillStyle = C.warm; c.fillRect(caret[0] + 2, caret[1] - 19, 10, 24); }
  c.restore();

  // streamed reply card
  const rq = outQuart((t - 2.45) / .6);
  if (rq > 0) {
    const bx = 1286, by = 742, bw = 560, bh = 150;
    c.save(); c.globalAlpha *= rq; c.translate(0, (1 - rq) * 30);
    glass(c, bx, by, bw, bh, 20, {edge: 'rgba(166,227,198,0.30)'});
    dot(c, bx + 30, by + 38, 4, C.mint); glow(c, bx + 30, by + 38, 18, 'rgba(166,227,198,0.9)');
    text(c, 'STREAM  ·  gemini-4-carbon', bx + 46, by + 44, {size: 15, mono: true, track: 2, color: C.dim});
    const reply = 'Hi! How can I help you today?';
    const n = Math.floor(clamp((t - 2.75) / .9) * reply.length);
    const w2 = text(c, reply.slice(0, n), bx + 30, by + 104, {size: 28, weight: 500, color: C.white});
    if (n < reply.length) { c.fillStyle = C.mint; c.fillRect(bx + 34 + w2, by + 82, 3, 28); }
    c.restore();
  }
}

const CAPS = ['Streaming', 'Tool calling', 'Reasoning', 'JSON Schema', 'Google Search', 'Images & documents', 'Image generation'];
function motif(c, i, t, a) {
  c.save(); c.globalAlpha *= a; c.translate(W / 2, 540);
  const col = 'rgba(169,190,255,0.16)';
  if (i === 0) for (let k = -30; k <= 30; k++) { const hgt = 40 + 160 * Math.abs(Math.sin(k * .7 + t * 9)) * (1 - Math.abs(k) / 34); line(c, [[k * 30, -hgt], [k * 30, hgt]], col, 6); }
  if (i === 1) { brackets(c, 0, 0, 640, col, 10); line(c, [[90, -250], [-90, 250]], col, 10); }
  if (i === 2) { const r = rng(5), pts = Array.from({length: 22}, () => [(r() - .5) * 1500, (r() - .5) * 640]); pts.forEach((p, a1) => pts.forEach((q, b1) => { if (b1 > a1 && Math.hypot(p[0] - q[0], p[1] - q[1]) < 330) line(c, [p, q], col, 2); })); pts.forEach(p => dot(c, p[0], p[1], 7, 'rgba(169,190,255,0.3)')); }
  if (i === 3) { setFont(c, 620, 300, true); c.fillStyle = col; c.textAlign = 'center'; c.fillText('{ }', 0, 210); }
  if (i === 4) { c.beginPath(); c.arc(-40, -30, 230, 0, Math.PI * 2); c.strokeStyle = col; c.lineWidth = 12; c.stroke(); line(c, [[125, 135], [300, 310]], col, 24); }
  if (i === 5) for (let k = 0; k < 3; k++) { rr(c, -260 + k * 90, -300 + k * 50, 400, 520, 26); c.strokeStyle = col; c.lineWidth = 6; c.stroke(); }
  if (i === 6) for (let gx = 0; gx < 8; gx++) for (let gy = 0; gy < 4; gy++) { const on = clamp(t * 18 - (gx + gy * 8) * .5); rr(c, -620 + gx * 158, -310 + gy * 158, 140, 140, 16); c.fillStyle = `rgba(169,190,255,${.03 + .1 * on})`; c.fill(); }
  c.restore();
}
function sceneCaps(c, t) {
  const beat = .5;
  const idx = Math.floor(t / beat);
  if (t < 3.5 && t >= 0) {
    const lt = t - idx * beat;
    const inq = outExpo(lt / .22), outq = clamp((lt - .4) / .1);
    motif(c, idx, lt, inq * (1 - outq));
    c.save(); c.globalAlpha *= inq * (1 - outq);
    const sc = lerp(1.14, 1, inq) * lerp(1, .97, outq);
    c.translate(W / 2, 560); c.scale(sc, sc);
    if (inq < .98) c.filter = `blur(${((1 - inq) * 18).toFixed(1)}px)`;
    const prev = CHECK; CHECK = false;
    text(c, CAPS[idx] + '.', 0, 0, {size: idx === 5 ? 132 : 156, weight: 700, track: -3.4, align: 'center', color: C.white});
    CHECK = prev; c.filter = 'none';
    c.restore();
    if (inq > .98 && outq === 0) { setFont(c, idx === 5 ? 132 : 156, 700, false, -3.4); const w = measure(c, CAPS[idx] + '.'); boundsCheck(c, W / 2 - w / 2, 440, W / 2 + w / 2, 600, CAPS[idx]); }
  }
  // counter and progress
  const ca = win(t, 0, 3.6, .2, .2);
  if (ca > 0) {
    c.save(); c.globalAlpha *= ca;
    text(c, `${String(Math.min(idx + 1, 7)).padStart(2, '0')} / 07`, W / 2, 250, {size: 18, mono: true, track: 4, color: C.dim, align: 'center'});
    line(c, [[W / 2 - 160, 790], [W / 2 + 160, 790]], 'rgba(255,255,255,0.10)', 2);
    line(c, [[W / 2 - 160, 790], [W / 2 - 160 + 320 * clamp(t / 3.5), 790]], C.warm, 2);
    c.restore();
  }
  // summary
  if (t > 3.45) {
    const q = outCubic((t - 3.45) / .4);
    c.save(); c.globalAlpha *= q;
    const rows = [CAPS.slice(0, 4), CAPS.slice(4)];
    rows.forEach((row, ri) => {
      const s = row.join('   ·   ');
      text(c, s, W / 2, 520 + ri * 70, {size: 40, weight: 600, track: -.6, align: 'center', color: ri ? C.text : C.white});
    });
    c.restore();
  }
}

function sceneResilience(c, t) {
  const L = 140;
  eyebrow(c, 'CREDENTIAL POOL', L, 330, t - .05);
  const lines = [['Keys rotate.', .15], ['Requests fail over.', 1.0], ['Tokens refresh.', 2.15]];
  lines.forEach(([s, at], i) => {
    const active = i === 0 ? win(t, .15, 1.05, .3, .3) : i === 1 ? win(t, 1.0, 2.2, .3, .3) : clamp((t - 2.15) / .3);
    c.save(); c.globalAlpha *= lerp(.38, 1, active);
    maskText(c, s, L, 440 + i * 96, t - at, {size: 70, weight: 700, track: -1.5, color: C.white});
    c.restore();
  });
  fadeText(c, 'Service accounts and Vertex Express keys.', L, 790, t - 2.6, {size: 24, weight: 400, color: C.dim});

  const lanes = [{y: 420, label: 'SERVICE ACCOUNT  A'}, {y: 560, label: 'SERVICE ACCOUNT  B'}, {y: 700, label: 'EXPRESS KEY'}];
  const x0 = 1130, x1 = 1780, fail = 1420;
  const showL = outCubic(t / .7);
  lanes.forEach((l, i) => {
    c.save(); c.globalAlpha *= showL;
    const lit = i === 1 ? clamp((t - 1.35) / .3) : 0;
    text(c, l.label, x0 - 24, l.y + 6, {size: 17, mono: true, track: 2, color: lit ? C.text : C.dim, align: 'right'});
    line(c, [[x0, l.y], [x1, l.y]], `rgba(255,255,255,${.10 + .2 * lit})`, 1.5);
    dot(c, x0, l.y, 4, 'rgba(255,255,255,0.35)');
    c.restore();
  });
  // packet path: lane A until the 429, then hop to lane B
  const p = clamp((t - .35) / 2.0);
  if (p > 0) {
    let px, py;
    const a = .32, b = .48;
    if (p < a) { px = lerp(x0, fail, p / a); py = lanes[0].y; }
    else if (p < b) { const u = inOut((p - a) / (b - a)); px = lerp(fail, fail + 80, u); py = lerp(lanes[0].y, lanes[1].y, u); }
    else { px = lerp(fail + 80, x1, outCubic((p - b) / (1 - b))); py = lanes[1].y; }
    const trail = c.createLinearGradient(px - 200, 0, px, 0); trail.addColorStop(0, 'rgba(242,180,140,0)'); trail.addColorStop(1, 'rgba(255,225,200,0.9)');
    if (p < a) line(c, [[Math.max(x0, px - 200), py], [px, py]], trail, 3);
    if (p >= b) line(c, [[Math.max(fail + 80, px - 200), py], [px, py]], trail, 3);
    glow(c, px, py, 46, 'rgba(255,205,170,0.95)'); dot(c, px, py, 4, '#FFF1E6');
  }
  // 429 marker
  const fq = win(t, .95, 2.4, .12, .5);
  if (fq > 0) {
    c.save(); c.globalAlpha *= fq;
    glow(c, fail, lanes[0].y, 70, 'rgba(240,144,126,0.9)', .6 + .4 * Math.sin(t * 20));
    rr(c, fail - 36, lanes[0].y - 62, 72, 34, 17); c.fillStyle = 'rgba(240,144,126,0.16)'; c.fill();
    text(c, '429', fail, lanes[0].y - 38, {size: 18, mono: true, weight: 600, color: C.alert, align: 'center'});
    c.restore();
  }
  // success badge
  const sq = outCubic((t - 2.35) / .4);
  if (sq > 0) {
    c.save(); c.globalAlpha *= sq;
    rr(c, x1 - 36, lanes[1].y - 62, 72, 34, 17); c.fillStyle = 'rgba(166,227,198,0.16)'; c.fill();
    text(c, '200', x1, lanes[1].y - 38, {size: 18, mono: true, weight: 600, color: C.mint, align: 'center'});
    c.restore();
  }
  // token refresh ring on lane C
  const rq = clamp((t - 2.15) / .9);
  if (rq > 0) {
    const rx = 1455, ry = lanes[2].y;
    c.beginPath(); c.arc(rx, ry, 26, 0, Math.PI * 2); c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 3; c.stroke();
    c.beginPath(); c.arc(rx, ry, 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * outCubic(rq)); c.strokeStyle = C.mint; c.lineWidth = 3; c.lineCap = 'round'; c.stroke();
    dot(c, rx, ry, 5, rq >= 1 ? C.mint : 'rgba(255,255,255,0.4)');
    fadeText(c, 'TOKEN REFRESHED', rx + 50, ry + 6, t - 3.0, {size: 15, mono: true, track: 2.5, color: C.mint, rise: 6, dur: .3});
  }
  fadeText(c, 'Illustrative flow', x1, 860, t - 1.5, {size: 15, mono: true, track: 1, color: C.faint, align: 'right'});
}

const SPHERE = (() => { const n = 1200, out = [], ga = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < n; i++) { const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), th = ga * i; out.push([Math.cos(th) * r, y, Math.sin(th) * r]); } return out; })();
const ARCS = (() => {
  const r = rng(42), out = [];
  while (out.length < 12) {
    const a = Math.floor(r() * SPHERE.length), b = Math.floor(r() * SPHERE.length), A = SPHERE[a], B = SPHERE[b];
    const om = Math.acos(clamp(A[0] * B[0] + A[1] * B[1] + A[2] * B[2], -1, 1));
    if (om > .5 && om < 1.1) out.push({a, b, at: .25 + out.length * .24});
  }
  return out;
})();
function sceneEdge(c, t) {
  const cx = 1360, cy = 540, R = 370, rot = t * .28 + 1.2, tilt = .38;
  const proj = ([x, y, z]) => { const cr = Math.cos(rot), sr = Math.sin(rot); const x1 = x * cr + z * sr, z1 = -x * sr + z * cr; const ct = Math.cos(tilt), st = Math.sin(tilt); const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct; return [cx + x1 * R, cy - y2 * R, z2]; };
  const appear = outCubic(t / 1.2);
  glow(c, cx, cy, R * 1.6, 'rgba(80,110,200,0.22)', appear);
  c.save(); c.globalAlpha *= appear;
  for (const p of SPHERE) { const [x, y, z] = proj(p); const a = z > 0 ? .18 + .5 * z : .05 + .05 * (1 + z); dot(c, x, y, z > 0 ? 1.7 : 1.1, `rgba(200,214,255,${a.toFixed(3)})`); }
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.strokeStyle = 'rgba(169,190,255,0.10)'; c.lineWidth = 1.5; c.stroke();
  for (const arc of ARCS) {
    const u = clamp((t - arc.at) / .9); if (u <= 0) continue;
    const A = SPHERE[arc.a], B = SPHERE[arc.b];
    const dotAB = clamp(A[0] * B[0] + A[1] * B[1] + A[2] * B[2], -1, 1), om = Math.acos(dotAB);
    if (om < .45 || om > 1.25) continue;
    const pts = [];
    for (let s = 0; s <= 40; s++) {
      const f = s / 40 * outCubic(u), k1 = Math.sin((1 - f) * om) / Math.sin(om), k2 = Math.sin(f * om) / Math.sin(om), lift = 1 + .14 * Math.sin(Math.PI * f) * om;
      pts.push(proj([(A[0] * k1 + B[0] * k2) * lift, (A[1] * k1 + B[1] * k2) * lift, (A[2] * k1 + B[2] * k2) * lift]));
    }
    const fade = 1 - clamp((t - arc.at - 1.6) / .6);
    if (pts[pts.length - 1][2] < -.2 && pts[0][2] < -.2) continue;
    c.globalAlpha = appear * fade;
    line(c, pts.map(p => [p[0], p[1]]), 'rgba(242,180,140,0.65)', 1.6);
    const hd = pts[pts.length - 1]; if (u < 1) glow(c, hd[0], hd[1], 26, 'rgba(255,210,180,0.95)');
    dot(c, pts[0][0], pts[0][1], 3, C.warm);
    c.globalAlpha = appear;
  }
  c.restore();

  const L = 140;
  eyebrow(c, 'SMALL BY DESIGN', L, 300, t - .05);
  // rolling zero
  const roll = outExpo((t - .15) / 1.1);
  if (t > .15) {
    c.save(); c.beginPath(); c.rect(L - 20, 330, 330, 340); c.clip();
    const digits = '9876543210', n = digits.length - 1, pos = roll * n;
    for (let k = 0; k <= n; k++) {
      const dy = (k - pos) * 300;
      if (Math.abs(dy) > 400) continue;
      const prev = CHECK; CHECK = false;
      text(c, digits[k], L - 6, 620 + dy, {size: 360, weight: 800, track: -6, gradient: ['#F7F8FB', '#F2B48C']});
      CHECK = prev;
    }
    c.restore();
  }
  maskText(c, 'runtime', L + 250, 520, t - .9, {size: 64, weight: 700, track: -1.3, color: C.white});
  maskText(c, 'dependencies.', L + 250, 594, t - 1.0, {size: 64, weight: 700, track: -1.3, color: C.white});
  fadeText(c, 'Runs on Cloudflare Workers.', L, 750, t - 1.5, {size: 40, weight: 500, track: -.8, color: C.text});
  let chipX = L;
  ['TypeScript', 'MIT License', 'One-click deploy'].forEach((s, i) => {
    setFont(c, 18, 500, true, 1.5); const w = measure(c, s) + 40, x = chipX; chipX += w + 14;
    const tt = t - 2.0 - i * .1; if (tt <= 0) return;
    c.save(); c.globalAlpha *= outCubic(tt / .4);
    rr(c, x, 800, w, 44, 22); c.fillStyle = 'rgba(255,255,255,0.05)'; c.fill(); c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 1; c.stroke();
    text(c, s, x + 20, 829, {size: 18, weight: 500, mono: true, track: 1.5, color: C.text});
    c.restore();
  });
}

const MODELS = ['gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'];
function sceneModels(c, t) {
  const L = 140;
  eyebrow(c, 'MODELS', L, 330, t - .05);
  maskText(c, 'Gemini 4.', L, 440, t - .12, {size: 104, weight: 700, track: -2.4, gradient: ['#C3D0FF', '#E9DDF7']});
  maskText(c, 'Ready.', L, 548, t - .26, {size: 104, weight: 700, track: -2.4, color: C.white});
  fadeText(c, 'Carbon and Argon, plus the Gemini 3 family.', L, 626, t - .7, {size: 26, weight: 400, color: C.dim});
  // reasoning effort control
  const rq = outCubic((t - 1.0) / .5);
  if (rq > 0) {
    c.save(); c.globalAlpha *= rq;
    text(c, 'reasoning_effort', L, 724, {size: 18, mono: true, color: C.dim});
    const opts = ['low', 'medium', 'high'], bx = L, by = 744, ow = 128;
    rr(c, bx, by, ow * 3 + 8, 52, 26); c.fillStyle = 'rgba(255,255,255,0.05)'; c.fill(); c.strokeStyle = 'rgba(255,255,255,0.10)'; c.lineWidth = 1; c.stroke();
    const sel = t < 1.9 ? 0 : t < 2.6 ? lerp(0, 1, outExpo((t - 1.9) / .35)) : lerp(1, 2, outExpo((t - 2.6) / .35));
    rr(c, bx + 4 + sel * ow, by + 4, ow, 44, 22); c.fillStyle = 'rgba(242,180,140,0.20)'; c.fill();
    opts.forEach((o, i) => text(c, o, bx + 4 + ow * i + ow / 2, by + 33, {size: 20, mono: true, align: 'center', color: Math.abs(sel - i) < .5 ? C.white : C.dim}));
    text(c, `→ Vertex ${['LOW', 'MEDIUM', 'HIGH'][Math.round(sel)]}`, bx + ow * 3 + 36, by + 33, {size: 18, mono: true, color: C.warm});
    c.restore();
  }
  // wheel
  const cy = 540, X = 1060;
  const pos = lerp(7, 0, inOut((t - .1) / 1.7));
  const wq = outCubic(t / .6);
  c.save(); c.globalAlpha *= wq;
  glow(c, 1420, cy, 520, 'rgba(90,120,210,0.18)');
  rr(c, X - 30, cy - 46, 770, 92, 22); c.fillStyle = 'rgba(255,255,255,0.045)'; c.fill(); c.strokeStyle = 'rgba(255,255,255,0.14)'; c.lineWidth = 1; c.stroke();
  MODELS.forEach((m, i) => {
    const d = i - pos; if (Math.abs(d) > 4.2) return;
    const ang = d * .36, y = cy + Math.sin(ang) * 330, s = Math.cos(ang);
    const a = clamp(1 - Math.abs(d) * .24);
    c.save(); c.globalAlpha *= a; c.translate(X, y); c.scale(1, s);
    const centered = Math.abs(d) < .5;
    const prev = CHECK; CHECK = centered && wq > .98;
    text(c, m, 0, 16, {size: centered ? 44 : 34, weight: centered ? 500 : 400, mono: true, color: centered ? C.white : C.dim});
    CHECK = prev;
    if (centered && i === 0 && t > 2.1) {
      setFont(c, 44, 500, true); const w = measure(c, m);
      const suf = t < 2.95 ? '-search' : '-max', st = t < 2.95 ? t - 2.1 : t - 2.95;
      const n = Math.floor(clamp(st / .3) * suf.length);
      text(c, suf.slice(0, n), w, 16, {size: 44, weight: 500, mono: true, color: C.warm});
    }
    c.restore();
  });
  c.restore();
  const capT = t < 2.95 ? t - 2.3 : t - 3.05;
  if (t > 2.3) fadeText(c, t < 2.95 ? 'SUFFIX  -search  →  GOOGLE SEARCH' : 'SUFFIX  -max  →  HIGHEST THINKING', X, cy - 70, capT, {size: 15, mono: true, track: 2, color: C.dim, rise: 6, dur: .3});
}

function sceneFinale(c, t) {
  // converging streaks
  const r = rng(77);
  const conv = clamp(t / .9);
  if (conv < 1) {
    for (let i = 0; i < 90; i++) {
      const ang = r() * Math.PI * 2, d0 = 900 + r() * 700, len = 80 + r() * 260, d = lerp(d0, 0, inOut(conv + r() * .1));
      const x = W / 2 + Math.cos(ang) * d, y = 400 + Math.sin(ang) * d * .6;
      const x2 = W / 2 + Math.cos(ang) * (d + len), y2 = 400 + Math.sin(ang) * (d + len) * .6;
      const g = c.createLinearGradient(x, y, x2, y2); g.addColorStop(0, `rgba(255,230,210,${.6 * (1 - conv)})`); g.addColorStop(1, 'rgba(255,230,210,0)');
      line(c, [[x, y], [x2, y2]], g, 1.5);
    }
  }
  const flash = win(t, .75, 1.4, .12, .6);
  glow(c, W / 2, 400, 520, 'rgba(255,200,160,0.55)', flash);
  glow(c, W / 2, 400, 360, 'rgba(245,154,98,0.35)', clamp((t - .8) / .5) * (.85 + .15 * Math.sin(t * 2)));
  const mq = outExpo((t - .8) / .9);
  if (mq > 0) mark(c, W / 2, 400, lerp(2.6, 2.1, mq), mq);
  blurText(c, 'Vertex2OpenAI', W / 2, 640, t - 1.15, {size: 150, weight: 700, track: -3.5, align: 'center', color: C.white, stagger: .035});
  blurText(c, 'Speak OpenAI. Run Gemini.', W / 2, 726, t - 1.9, {size: 46, weight: 500, track: -1, align: 'center', gradient: ['#B9C9FF', '#E9DDF7', '#F4BE98'], stagger: .015, rise: .2, blur: 8});
  const uq = outCubic((t - 2.5) / .6);
  if (uq > 0) {
    c.save(); c.globalAlpha *= uq; c.translate(0, (1 - uq) * 16);
    setFont(c, 26, 500, true, .5); const s = 'github.com/workHMZ/vertex2openai-cf', w = measure(c, s) + 64;
    rr(c, W / 2 - w / 2, 806, w, 64, 32); c.fillStyle = 'rgba(255,255,255,0.05)'; c.fill(); c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 1; c.stroke();
    text(c, s, W / 2, 847, {size: 26, weight: 500, mono: true, track: .5, align: 'center', color: C.text});
    text(c, 'OPEN SOURCE  ·  MIT  ·  CLOUDFLARE WORKERS', W / 2, 930, {size: 16, mono: true, track: 4, align: 'center', color: C.dim});
    c.restore();
  }
}

const SCENES = [sceneSignal, sceneBridge, sceneDropIn, sceneCaps, sceneResilience, sceneEdge, sceneModels, sceneFinale];
const TR = .3; // half-length of each zoom-through transition

function drawScene(i, T, layer) {
  const s = STORY.scenes[i], t = T - s.start, lc = layer.getContext('2d');
  lc.resetTransform(); lc.globalAlpha = 1; lc.filter = 'none'; lc.clearRect(0, 0, W, H);
  SCENES[i](lc, t);
  const len = s.end - s.start;
  // slow push-in camera
  let scale = 1 + .03 * clamp(t / len), alpha = 1, blur = 0;
  const inP = i > 0 ? clamp((T - (s.start - TR)) / (2 * TR)) : 1;
  const outP = i < SCENES.length - 1 ? clamp((T - (s.end - TR)) / (2 * TR)) : 0;
  if (inP < 1) { const q = inOut(inP); scale *= lerp(.92, 1, q); alpha *= q; blur += (1 - q) * 14; }
  if (outP > 0) { const q = inOut(outP); scale *= lerp(1, 1.14, q); alpha *= 1 - q; blur += q * 16; }
  if (alpha <= .002) return;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.translate(W / 2, H / 2); ctx.scale(scale, scale); ctx.translate(-W / 2, -H / 2);
  if (blur > .5) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}
function render(T) {
  NOW = T;
  ctx.resetTransform(); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
  ambient(T);
  let used = 0;
  STORY.scenes.forEach((s, i) => {
    const from = i > 0 ? s.start - TR : -1, to = i < SCENES.length - 1 ? s.end + TR : DURATION + 1;
    if (T >= from && T < to) drawScene(i, T, layers[used++ % 2]);
  });
  // light sweep at each cut
  for (const s of STORY.scenes.slice(1)) {
    const d = (T - s.start) / TR;
    if (Math.abs(d) < 1) { const a = Math.pow(1 - Math.abs(d), 2); glow(ctx, W / 2 + d * 700, H / 2, 900, 'rgba(255,225,200,0.20)', a); }
  }
  post(T);
  if (T < .25) { ctx.globalAlpha = 1 - smooth(T / .25); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
}

async function main() {
  const qa = path.join(ROOT, 'qa'); fs.mkdirSync(qa, {recursive: true}); fs.mkdirSync(path.join(ROOT, 'assets'), {recursive: true});
  const fi = process.argv.indexOf('--frame');
  if (fi > 0) { const T = parseFloat(process.argv[fi + 1]); render(T); fs.writeFileSync(path.join(qa, `frame-${T.toFixed(2)}.png`), canvas.toBuffer('image/png')); console.log([...errors].join('\n') || 'ok'); return; }
  if (process.argv.includes('--stills')) {
    const times = [2.6, 6.4, 11.2, 13.1, 14.3, 15.85, 18.6, 22.6, 26.9, 32.5];
    const board = createCanvas(1280, 360 * 5), b = board.getContext('2d');
    times.forEach((T, k) => {
      render(T); fs.writeFileSync(path.join(qa, `still-${String(k + 1).padStart(2, '0')}.png`), canvas.toBuffer('image/png'));
      b.drawImage(canvas, (k % 2) * 640, Math.floor(k / 2) * 360, 640, 360);
    });
    fs.writeFileSync(path.join(ROOT, 'storyboard.jpg'), board.toBuffer('image/jpeg', {quality: 92}));
    render(32.5); fs.writeFileSync(path.join(ROOT, 'poster.jpg'), canvas.toBuffer('image/jpeg', {quality: 95}));
    console.log([...errors].join('\n') || 'Stills passed text-safe-area checks.');
    return;
  }
  const out = path.join(ROOT, 'assets', 'picture.mp4');
  const proc = spawn(FF, ['-hide_banner', '-loglevel', 'warning', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${W}x${H}`, '-framerate', String(FPS), '-i', 'pipe:0', '-an',
    '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'grain',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', out], {stdio: ['pipe', 'inherit', 'inherit']});
  const done = once(proc, 'close');
  const total = FPS * DURATION, t0 = Date.now();
  for (let f = 0; f < total; f++) {
    render(f / FPS);
    if (!proc.stdin.write(canvas.data())) await once(proc.stdin, 'drain');
    if (f % (FPS * 3) === 0) console.log(`frame ${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  proc.stdin.end();
  const [code] = await done; if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  fs.writeFileSync(path.join(qa, 'layout.json'), JSON.stringify({frames_checked: total, safe_margin_px: 36, errors: [...errors]}, null, 2));
  if (errors.size) throw new Error([...errors].slice(0, 10).join('\n'));
  console.log('Picture complete.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
