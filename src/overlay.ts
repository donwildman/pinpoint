import {
  COLORS, constrain, contentBounds, draw, fontSize, fromSpec, hit, measureWith, rectOf, setMeasure, smooth,
  type Mark, type MarkSpec, type MarkType, type Pt,
} from './engine';

type Tool = MarkType | 'laser' | 'eraser' | 'crop';
type Kind = 'screen' | 'white' | 'black' | 'image';
type Rect = { x: number; y: number; w: number; h: number };
interface Page { kind: Kind; marks: Mark[]; history: Mark[][]; future: Mark[][]; view: { x: number; y: number; z: number }; crop?: Rect }

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
setMeasure(measureWith(ctx));

const params = new URLSearchParams(location.search);
const editFile = params.get('edit');
const BG: Record<Kind, string> = { screen: 'rgba(0,0,0,0.01)', white: '#fafaf7', black: '#22302a', image: '#232326' };
const newPage = (kind: Kind): Page => ({ kind, marks: [], history: [], future: [], view: { x: 0, y: 0, z: 1 } });

const st = {
  tool: 'pen' as Tool, color: COLORS[0], size: 2, pages: [] as Page[], page: 0, pinned: false,
  drawing: null as Mark | null, start: null as Pt | null, erasing: false, cropDrag: null as Rect | null,
  editing: null as Mark | null, pan: null as { sx: number; sy: number; vx: number; vy: number } | null, space: false,
};
let bgImage: HTMLImageElement | null = null;
const laser: { p: Pt; t: number }[] = [];
const cur = () => st.pages[st.page];
const board = () => cur().kind !== 'screen';

// --- Coordinates ------------------------------------------------------------

const toWorld = (e: { clientX: number; clientY: number }): Pt => {
  const { x, y, z } = cur().view;
  return [x + e.clientX / z, y + e.clientY / z];
};

function fit() {
  const p = cur();
  const b = p.kind === 'image' ? { x: 0, y: 0, w: bgImage!.width, h: bgImage!.height } : contentBounds(p.marks);
  if (!b || p.kind === 'screen') return;
  const pad = p.kind === 'image' ? 24 : 80, top = 64;
  const z = Math.min((innerWidth - pad * 2) / b.w, (innerHeight - pad - top) / b.h, p.kind === 'image' ? 1 : 3);
  p.view = { z, x: b.x - (innerWidth / z - b.w) / 2, y: b.y - (top + (innerHeight - top - b.h * z) / 2) / z };
  render();
}

function zoomAt(sx: number, sy: number, factor: number) {
  const v = cur().view, z = Math.min(8, Math.max(0.1, v.z * factor));
  v.x += sx / v.z - sx / z;
  v.y += sy / v.z - sy / z;
  v.z = z;
}

// --- Rendering --------------------------------------------------------------

function paintPage(c: CanvasRenderingContext2D, p: Page, scale: number, withChrome: boolean) {
  const { x, y, z } = p.view;
  c.setTransform(scale * z, 0, 0, scale * z, -x * scale * z, -y * scale * z);
  if (p.kind === 'image' && bgImage) c.drawImage(bgImage, 0, 0);
  for (const m of p.marks) if (!withChrome || m !== st.editing) draw(c, m);
  if (withChrome && st.drawing) draw(c, st.drawing);
}

function render() {
  const dpr = devicePixelRatio, W = innerWidth, H = innerHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const p = cur();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // A faint fill keeps the overlay clickable on compositors that pass clicks through fully transparent pixels.
  ctx.fillStyle = BG[p.kind];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  paintPage(ctx, p, dpr, true);

  const crop = st.cropDrag ?? p.crop;
  if (crop && p.kind === 'image') {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(-1e5, -1e5, 2e5, 2e5);
    ctx.rect(crop.x, crop.y, crop.w, crop.h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 / p.view.z;
    ctx.setLineDash([6 / p.view.z, 4 / p.view.z]);
    ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
    ctx.setLineDash([]);
  }

  const now = performance.now();
  while (laser.length && now - laser[0].t > 600) laser.shift();
  for (let i = 1; i < laser.length; i++) {
    const age = (now - laser[i].t) / 600;
    ctx.strokeStyle = `rgba(255, 45, 45, ${1 - age})`;
    ctx.lineWidth = (8 * (1 - age) + 2) / p.view.z;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(...laser[i - 1].p);
    ctx.lineTo(...laser[i].p);
    ctx.stroke();
  }
  if (laser.length) {
    const [lx, ly] = laser[laser.length - 1].p;
    ctx.shadowColor = '#ff2d2d';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath();
    ctx.arc(lx, ly, 6 / p.view.z, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    requestAnimationFrame(render);
  }
}

// --- History ----------------------------------------------------------------

function snapshot() {
  const p = cur();
  p.history.push(structuredClone(p.marks));
  p.future = [];
}
function undo() {
  const p = cur();
  if (!p.history.length) return;
  p.future.push(p.marks);
  p.marks = p.history.pop()!;
  render();
}
function redo() {
  const p = cur();
  if (!p.future.length) return;
  p.history.push(p.marks);
  p.marks = p.future.pop()!;
  render();
}
function commit(m: Mark) {
  snapshot();
  cur().marks.push(m);
}

// --- Text -------------------------------------------------------------------

function editText(at: Pt, existing?: Mark, label = false) {
  const p = cur(), z = p.view.z;
  const ta = document.createElement('textarea');
  ta.className = 'text-input';
  const proto: Mark = existing ?? { type: 'text', color: st.color, size: st.size, points: [at] };
  const fs = fontSize(label ? { ...proto, size: 1 } : proto) * z;
  const [wx, wy] = label ? [at[0] + 24, at[1] - 10] : proto.points[0];
  Object.assign(ta.style, {
    left: `${(wx - p.view.x) * z}px`, top: `${(wy - p.view.y) * z}px`, fontSize: `${fs}px`,
    color: label ? '#fff' : proto.color, background: label ? 'rgba(28,28,30,.85)' : 'transparent',
  });
  ta.value = (label ? existing?.text : proto.text) ?? '';
  if (existing && !label) { st.editing = existing; render(); }
  const grow = () => {
    ta.style.width = '0';
    ta.style.height = '0';
    ta.style.width = `${ta.scrollWidth + fs}px`;
    ta.style.height = `${ta.scrollHeight}px`;
  };
  ta.addEventListener('input', grow);
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    st.editing = null;
    const text = ta.value.trimEnd();
    ta.remove();
    if (!keep) return render();
    if (label && existing) {
      snapshot();
      existing.text = text || undefined;
    } else if (existing) {
      snapshot();
      if (text) existing.text = text;
      else p.marks.splice(p.marks.indexOf(existing), 1);
    } else if (text) commit({ ...proto, text });
    render();
  };
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') finish(false);
    if (e.key === 'Enter' && (label || !e.shiftKey)) { e.preventDefault(); finish(true); }
  });
  ta.addEventListener('blur', () => finish(true));
  document.body.append(ta);
  grow();
  requestAnimationFrame(() => ta.focus());
}

// --- Pointer ----------------------------------------------------------------

function eraseAt(w: Pt) {
  const p = cur();
  const keep = p.marks.filter(m => !hit(m, w, 10 / p.view.z));
  if (keep.length !== p.marks.length) { p.marks = keep; render(); }
}

canvas.addEventListener('pointerdown', e => {
  if (st.pinned) return;
  canvas.setPointerCapture(e.pointerId);
  closeMenus();
  const w = toWorld(e), p = cur();
  if (e.button === 1 || (e.button === 0 && st.space && board())) {
    st.pan = { sx: e.clientX, sy: e.clientY, vx: p.view.x, vy: p.view.y };
    return;
  }
  if (e.button !== 0) return;
  switch (st.tool) {
    case 'pen': case 'highlight':
      st.drawing = { type: st.tool, color: st.color, size: st.size, points: [w] };
      break;
    case 'arrow': case 'line': case 'rect': case 'ellipse':
      st.start = w;
      st.drawing = { type: st.tool, color: st.color, size: st.size, points: [w, w] };
      break;
    case 'text': {
      const t = [...p.marks].reverse().find(m => m.type === 'text' && hit(m, w, 4));
      editText(w, t);
      return;
    }
    case 'step': {
      const s = [...p.marks].reverse().find(m => m.type === 'step' && hit(m, w, 2));
      if (s) return editText(s.points[0], s, true);
      const n = Math.max(0, ...p.marks.filter(m => m.type === 'step').map(m => m.step!)) + 1;
      commit({ type: 'step', color: st.color, size: st.size, points: [w], step: n });
      break;
    }
    case 'eraser':
      snapshot();
      st.erasing = true;
      eraseAt(w);
      break;
    case 'laser':
      laser.push({ p: w, t: performance.now() });
      break;
    case 'crop':
      st.start = w;
      st.cropDrag = { x: w[0], y: w[1], w: 0, h: 0 };
      break;
  }
  render();
});

canvas.addEventListener('pointermove', e => {
  if (st.pinned) return;
  const w = toWorld(e), p = cur();
  if (st.pan) {
    p.view.x = st.pan.vx - (e.clientX - st.pan.sx) / p.view.z;
    p.view.y = st.pan.vy - (e.clientY - st.pan.sy) / p.view.z;
    return render();
  }
  if (st.tool === 'laser') {
    laser.push({ p: w, t: performance.now() });
    if (laser.length === 1) render();
    return;
  }
  if (st.erasing) return eraseAt(w);
  if (st.cropDrag && st.start) {
    const img = { w: bgImage!.width, h: bgImage!.height };
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    st.cropDrag = rectOf([clamp(st.start[0], img.w), clamp(st.start[1], img.h)], [clamp(w[0], img.w), clamp(w[1], img.h)]);
    return render();
  }
  const d = st.drawing;
  if (!d) return;
  if (d.type === 'pen' || d.type === 'highlight') {
    if (e.shiftKey) d.points = [d.points[0], w];
    else d.points.push(w);
  } else if (st.start) {
    d.points = constrain(d.type, st.start, w, e.shiftKey, e.altKey);
  }
  render();
});

canvas.addEventListener('pointerup', () => {
  st.pan = null;
  st.erasing = false;
  if (st.cropDrag) {
    const c = st.cropDrag;
    cur().crop = c.w > 8 && c.h > 8 ? c : undefined;
    st.cropDrag = null;
  }
  const d = st.drawing;
  st.drawing = null;
  st.start = null;
  if (d) {
    const [a, b] = [d.points[0], d.points[d.points.length - 1]];
    const tiny = Math.hypot(b[0] - a[0], b[1] - a[1]) < 3;
    if (d.type === 'pen' || d.type === 'highlight') {
      if (d.points.length > 2) d.points = smooth(d.points);
      commit(d);
    } else if (!tiny) commit(d);
  }
  render();
});

let swipe = 0, swipeLock = 0;
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = cur();
  if (board()) {
    if (e.ctrlKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    else { p.view.x += e.deltaX / p.view.z; p.view.y += e.deltaY / p.view.z; }
    return render();
  }
  // Two-finger horizontal swipe on a screen page flips pages, making a fresh one past the end.
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || performance.now() < swipeLock) return;
  swipe += e.deltaX;
  if (Math.abs(swipe) > 160) {
    swipe > 0 ? (st.page === st.pages.length - 1 ? addPage('screen') : goPage(st.page + 1)) : goPage(st.page - 1);
    swipe = 0;
    swipeLock = performance.now() + 500;
  }
}, { passive: false });

// --- Pages ------------------------------------------------------------------

function goPage(i: number) {
  if (i < 0 || i >= st.pages.length) return;
  st.page = i;
  document.body.classList.toggle('on-board', board());
  syncUI();
  render();
}
function addPage(kind: Kind) {
  const p = newPage(kind);
  if (kind === 'black' && ['#1c1c1e'].includes(st.color)) st.color = '#ffffff';
  if (kind === 'black' && st.color === COLORS[0]) st.color = '#ffcc00';
  st.pages.push(p);
  goPage(st.pages.length - 1);
}

// --- Screenshots ------------------------------------------------------------

const loadImage = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = rej;
  i.src = src;
});

function flash(msg?: string) {
  const f = $('#flash');
  f.classList.add('go');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('go')));
  if (msg) toast(msg);
}
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// The current page as a picture at device pixels: the screen behind it plus the marks.
async function composite() {
  const p = cur(), out = document.createElement('canvas'), c = out.getContext('2d')!;
  if (p.kind === 'screen') {
    const url = await pin.capture();
    if (!url) return null;
    const shot = await loadImage(url);
    out.width = shot.width;
    out.height = shot.height;
    c.drawImage(shot, 0, 0);
    paintPage(c, p, shot.width / innerWidth, false);
  } else {
    const dpr = devicePixelRatio;
    out.width = innerWidth * dpr;
    out.height = innerHeight * dpr;
    c.fillStyle = BG[p.kind];
    c.fillRect(0, 0, out.width, out.height);
    paintPage(c, p, dpr, false);
  }
  return out.toDataURL('image/png');
}

async function screenshot() {
  const url = await composite();
  if (!url) return toast("Couldn't capture the screen");
  pin.shot('add', url);
  flash();
}

function saveEdit() {
  const p = cur(), img = bgImage!;
  const crop = p.crop ?? { x: 0, y: 0, w: img.width, h: img.height };
  const out = document.createElement('canvas'), c = out.getContext('2d')!;
  out.width = Math.round(crop.w);
  out.height = Math.round(crop.h);
  c.translate(-crop.x, -crop.y);
  c.drawImage(img, 0, 0);
  for (const m of p.marks) draw(c, m);
  pin.shot('saved', editFile, out.toDataURL('image/png'));
  pin.close();
}

// --- Pin --------------------------------------------------------------------

function setPinned(on: boolean) {
  st.pinned = on;
  document.body.classList.toggle('is-pinned', on);
  pin.setPinned(on);
}
pin.onUnpin(() => { st.pinned = false; document.body.classList.remove('is-pinned'); });

// --- Toolbar ----------------------------------------------------------------

const colorsEl = $('#colors');
COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.color = c;
  b.dataset.tip = `Colour  ${i + 1}`;
  b.innerHTML = `<i style="background:${c}"></i>`;
  colorsEl.append(b);
});

function syncUI() {
  $$('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === st.tool));
  $$('[data-color]').forEach(b => b.classList.toggle('on', b.dataset.color === st.color));
  $$('[data-size]').forEach(b => b.classList.toggle('on', Number(b.dataset.size) === st.size));
  $$('.edit-only').forEach(b => (b.style.display = editFile ? '' : 'none'));
  $$('.screen-only').forEach(b => (b.style.display = editFile ? 'none' : ''));
  const pages = $('#pages');
  pages.innerHTML = '';
  if (st.pages.length > 1) st.pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.textContent = String(i + 1);
    b.className = `${p.kind}${i === st.page ? ' on' : ''}`;
    b.dataset.tip = { screen: 'Screen', white: 'Whiteboard', black: 'Blackboard', image: '' }[p.kind];
    b.onclick = () => goPage(i);
    pages.append(b);
  });
  canvas.style.cursor = st.tool === 'text' ? 'text' : st.tool === 'laser' ? 'none' : st.tool === 'eraser' ? 'cell' : 'crosshair';
}

const closeMenus = () => $$('.menu.open, .help.open').forEach(m => m.classList.remove('open'));

function setTool(t: Tool) {
  st.tool = t;
  syncUI();
}

const actions: Record<string, () => void> = {
  undo, redo,
  clear: () => { if (cur().marks.length) { snapshot(); cur().marks = []; render(); } },
  newpage: () => $('#newmenu').classList.toggle('open'),
  pin: () => setPinned(true),
  shot: () => void screenshot(),
  save: saveEdit,
  help: () => $('#help').classList.toggle('open'),
  close: () => pin.close(),
};

$('#bar').addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tool],[data-color],[data-size],[data-act],[data-new]');
  if (!el) return;
  const { tool, color, size, act } = el.dataset;
  if (tool) setTool(tool as Tool);
  if (color) { st.color = color; syncUI(); }
  if (size) { st.size = Number(size); syncUI(); }
  if (act) actions[act]();
  if (el.dataset.new) { closeMenus(); addPage(el.dataset.new as Kind); }
});

// Drag the bar by its grip.
$('#grip').addEventListener('pointerdown', e => {
  const bar = $('#bar'), r = bar.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
  bar.classList.add('moved');
  const move = (ev: PointerEvent) => Object.assign(bar.style, {
    left: `${Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx))}px`,
    top: `${Math.max(0, Math.min(innerHeight - r.height, ev.clientY - dy))}px`,
  });
  move(e);
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => removeEventListener('pointermove', move), { once: true });
});

// --- Keyboard ---------------------------------------------------------------

const TOOL_KEYS: Record<string, Tool> = {
  p: 'pen', h: 'highlight', a: 'arrow', i: 'line', r: 'rect', o: 'ellipse', t: 'text', n: 'step', l: 'laser', e: 'eraser',
};

window.addEventListener('keydown', e => {
  if (e.key === ' ') st.space = true;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if ($('.menu.open, .help.open')) return closeMenus();
    if (editFile && cur().crop) { cur().crop = undefined; return render(); }
    return pin.close();
  }
  if (st.pinned) return;
  if (ctrl && k === 'z') return e.shiftKey ? redo() : undo();
  if (ctrl && k === 'y') return redo();
  if (ctrl && k === 's' && editFile) return saveEdit();
  if (ctrl) return;
  if (e.code === 'Digit1' && e.shiftKey) return fit();
  if (/^[1-8]$/.test(e.key)) { st.color = COLORS[Number(e.key) - 1]; return syncUI(); }
  if (TOOL_KEYS[k]) return setTool(TOOL_KEYS[k]);
  if (k === 'c' && editFile) return setTool('crop');
  if (e.key === '[') { st.size = Math.max(1, st.size - 1); return syncUI(); }
  if (e.key === ']') { st.size = Math.min(3, st.size + 1); return syncUI(); }
  if (e.key === '?') return actions.help();
  if (e.key === 'Delete' || e.key === 'Backspace') return actions.clear();
  if (e.key === 'Enter' && editFile) return saveEdit();
  if (editFile) return;
  if (k === 's') return void screenshot();
  if (k === 'f') return setPinned(true);
  if (k === 'w') return addPage('white');
  if (k === 'k') return addPage('black');
  if (e.key === 'PageDown') return goPage(st.page + 1);
  if (e.key === 'PageUp') return goPage(st.page - 1);
});
window.addEventListener('keyup', e => { if (e.key === ' ') st.space = false; });
window.addEventListener('resize', render);

// --- Agents -----------------------------------------------------------------

// Main runs these via executeJavaScript for MCP tool calls. Coordinates are pixels of composite().
const fromPx = (p: Pt) => toWorld({ clientX: p[0] / devicePixelRatio, clientY: p[1] / devicePixelRatio });
const agentOps: Record<string, (cmd: any) => unknown> = {
  noop: () => null,
  capture: () => composite(),
  draw: ({ marks }: { marks: MarkSpec[] }) => {
    if (!Array.isArray(marks) || !marks.length) throw new Error('draw needs a non-empty "marks" array.');
    const p = cur();
    let step = Math.max(0, ...p.marks.filter(m => m.type === 'step').map(m => m.step!));
    const made = marks.map(s => fromSpec(s, fromPx, s.type === 'step' ? ++step : 0));
    snapshot();
    p.marks.push(...made);
    render();
    return `Drew ${made.length} mark${made.length === 1 ? '' : 's'}.`;
  },
  clear: () => { actions.clear(); return 'Cleared.'; },
  board: ({ kind }: { kind: Kind }) => { addPage(kind); return `Opened a ${kind === 'black' ? 'blackboard' : 'whiteboard'}.`; },
  move: ({ by, zoom, fit: toFit }: { by?: Pt; zoom?: number; fit?: boolean }) => {
    if (!board()) throw new Error('move_board only works on a whiteboard or blackboard; call new_board first.');
    const v = cur().view;
    if (toFit) fit();
    if (zoom) zoomAt(innerWidth / 2, innerHeight / 2, zoom / v.z);
    if (by) { v.x += by[0] / devicePixelRatio / v.z; v.y += by[1] / devicePixelRatio / v.z; }
    render();
    return `Board view at ${Math.round(v.z * 100)}%.`;
  },
};
Object.assign(window, {
  agent: async (cmd: { op: string }) => {
    try { return { ok: await agentOps[cmd.op](cmd) }; } catch (err) { return { error: (err as Error).message }; }
  },
});

// --- Start ------------------------------------------------------------------

async function start() {
  if (editFile) {
    document.body.classList.add('editor');
    bgImage = await loadImage(`file://${editFile}?t=${Date.now()}`);
    st.pages = [newPage('image')];
    goPage(0);
    fit();
  } else {
    const kind = params.get('start');
    st.pages = [newPage(kind === 'white' || kind === 'black' ? kind : 'screen')];
    goPage(0);
    if (params.has('pinned')) setPinned(true);
  }
  syncUI();
  render();
}
void start();
