// Pure drawing model: marks, geometry, hit-testing and rendering. No DOM beyond a 2D context.

export type Pt = [number, number];
export type MarkType = 'pen' | 'highlight' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'text' | 'step';

export interface Mark {
  type: MarkType;
  color: string;
  size: number; // 1..3
  points: Pt[]; // pen/highlight: path; shapes: [start, end]; text/step: [anchor]
  text?: string;
  step?: number;
}

export const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ffffff', '#1c1c1e'];

export const strokeWidth = (m: Mark) => (m.type === 'highlight' ? 14 : 3) * m.size;
export const fontSize = (m: Mark) => 14 + m.size * 6;
export const stepRadius = (m: Mark) => 10 + m.size * 3;

// Chaikin corner cutting: turns jittery mouse paths into smooth curves, keeping the endpoints.
export function smooth(pts: Pt[], passes = 2): Pt[] {
  let out = pts;
  for (let p = 0; p < passes && out.length > 2; p++) {
    const next: Pt[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [ax, ay] = out[i], [bx, by] = out[i + 1];
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

export function rectOf(a: Pt, b: Pt) {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

function segDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function outline(m: Mark): Pt[] {
  const [a, b] = m.points;
  if (m.type === 'rect') {
    const r = rectOf(a, b);
    return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y]];
  }
  if (m.type === 'ellipse') {
    const r = rectOf(a, b);
    return Array.from({ length: 49 }, (_, i) => {
      const t = (i / 48) * Math.PI * 2;
      return [r.x + r.w / 2 + Math.cos(t) * r.w / 2, r.y + r.h / 2 + Math.sin(t) * r.h / 2] as Pt;
    });
  }
  return m.points;
}

// Text width needs a canvas to measure; callers that only hit-test can pass a rough estimate.
let measure: (m: Mark) => number = m => (m.text?.length ?? 0) * fontSize(m) * 0.6;
export const setMeasure = (fn: (m: Mark) => number) => { measure = fn; };

export function bounds(m: Mark) {
  if (m.type === 'text') {
    const [x, y] = m.points[0];
    return { x, y, w: measure(m), h: fontSize(m) * 1.3 * (m.text ?? '').split('\n').length };
  }
  if (m.type === 'step') {
    const r = stepRadius(m), [x, y] = m.points[0];
    return { x: x - r, y: y - r, w: 2 * r + (m.text ? measure({ ...m, size: 1 }) + 24 : 0), h: 2 * r };
  }
  const xs = m.points.map(p => p[0]), ys = m.points.map(p => p[1]);
  const pad = strokeWidth(m) / 2;
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

export function hit(m: Mark, p: Pt, radius = 8): boolean {
  if (m.type === 'text' || m.type === 'step') {
    const b = bounds(m);
    return p[0] >= b.x - radius && p[0] <= b.x + b.w + radius && p[1] >= b.y - radius && p[1] <= b.y + b.h + radius;
  }
  const pts = outline(m), reach = radius + strokeWidth(m) / 2;
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= reach;
  for (let i = 0; i < pts.length - 1; i++) if (segDist(p, pts[i], pts[i + 1]) <= reach) return true;
  return false;
}

export function contentBounds(marks: Mark[]) {
  if (!marks.length) return null;
  const bs = marks.map(bounds);
  const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y));
  return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y };
}

// Constrain a drag: shift snaps lines to 45° and boxes to squares; alt draws boxes from the center.
export function constrain(type: MarkType, a: Pt, b: Pt, shift: boolean, alt: boolean): [Pt, Pt] {
  let [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  if (shift && (type === 'line' || type === 'arrow')) {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
    [dx, dy] = [Math.cos(ang) * len, Math.sin(ang) * len];
  } else if (shift && (type === 'rect' || type === 'ellipse')) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    [dx, dy] = [Math.sign(dx || 1) * s, Math.sign(dy || 1) * s];
  }
  if (alt && (type === 'rect' || type === 'ellipse')) return [[a[0] - dx, a[1] - dy], [a[0] + dx, a[1] + dy]];
  return [a, [a[0] + dx, a[1] + dy]];
}

const FONT = 'Inter, "Noto Sans", "DejaVu Sans", sans-serif';
const contrast = (c: string) => (['#ffffff', '#ffcc00'].includes(c) ? '#1c1c1e' : '#ffffff');

export function draw(ctx: CanvasRenderingContext2D, m: Mark) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = m.color;
  ctx.lineWidth = strokeWidth(m);
  ctx.lineCap = ctx.lineJoin = 'round';
  const [a, b] = m.points;
  switch (m.type) {
    case 'highlight':
      ctx.globalAlpha = 0.35;
      ctx.lineCap = 'butt';
    // falls through
    case 'pen': {
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      if (m.points.length === 1) ctx.lineTo(a[0] + 0.1, a[1]);
      for (const p of m.points.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const head = Math.min(10 + ctx.lineWidth * 3, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.6);
      const tip: Pt = m.type === 'arrow' ? [b[0] - Math.cos(ang) * head * 0.6, b[1] - Math.sin(ang) * head * 0.6] : b;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.stroke();
      if (m.type === 'arrow') {
        ctx.beginPath();
        ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - Math.cos(ang - 0.45) * head, b[1] - Math.sin(ang - 0.45) * head);
        ctx.lineTo(b[0] - Math.cos(ang + 0.45) * head, b[1] - Math.sin(ang + 0.45) * head);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'rect': {
      const r = rectOf(a, b);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'ellipse': {
      const r = rectOf(a, b);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'text': {
      const fs = fontSize(m);
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3;
      ctx.strokeStyle = contrast(m.color) + '99';
      (m.text ?? '').split('\n').forEach((line, i) => {
        ctx.strokeText(line, a[0], a[1] + i * fs * 1.3);
        ctx.fillText(line, a[0], a[1] + i * fs * 1.3);
      });
      break;
    }
    case 'step': {
      const r = stepRadius(m);
      ctx.beginPath();
      ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = contrast(m.color);
      ctx.font = `700 ${Math.round(r * 1.1)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.step), a[0], a[1] + 1);
      if (m.text) {
        ctx.font = `600 ${fontSize({ ...m, size: 1 })}px ${FONT}`;
        const w = ctx.measureText(m.text).width;
        const x = a[0] + r + 6;
        ctx.fillStyle = 'rgba(28,28,30,0.85)';
        ctx.beginPath();
        ctx.roundRect(x, a[1] - 13, w + 16, 26, 13);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.fillText(m.text, x + 8, a[1] + 1);
      }
      break;
    }
  }
  ctx.restore();
}

export function measureWith(ctx: CanvasRenderingContext2D) {
  return (m: Mark) => {
    ctx.font = `600 ${fontSize(m)}px ${FONT}`;
    return Math.max(...(m.text ?? '').split('\n').map(l => ctx.measureText(l).width), 0);
  };
}

// --- Agent marks --------------------------------------------------------------

// What an agent sends over MCP: friendlier than a Mark, in its own pixel space (mapped by the caller).
export interface MarkSpec {
  type: MarkType;
  color?: string;
  size?: number;
  from?: Pt;
  to?: Pt;
  box?: { x: number; y: number; width: number; height: number };
  points?: Pt[];
  at?: Pt;
  text?: string;
}

const NAMED = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'white', 'black'];
const TYPES: MarkType[] = ['pen', 'highlight', 'arrow', 'line', 'rect', 'ellipse', 'text', 'step'];
const isPt = (p: unknown): p is Pt => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

export function fromSpec(s: MarkSpec, map: (p: Pt) => Pt, step: number): Mark {
  if (!TYPES.includes(s.type)) throw new Error(`Unknown mark type "${s.type}"; use one of ${TYPES.join(', ')}.`);
  const named = NAMED.indexOf(s.color?.toLowerCase() ?? '');
  const color = named >= 0 ? COLORS[named] : /^#[0-9a-f]{6}$/i.test(s.color ?? '') ? s.color! : COLORS[0];
  const size = Math.min(3, Math.max(1, Math.round(s.size ?? 2)));
  let points: Pt[];
  switch (s.type) {
    case 'arrow': case 'line':
      if (!isPt(s.from) || !isPt(s.to)) throw new Error(`${s.type} needs "from" and "to" as [x, y].`);
      points = [s.from, s.to];
      break;
    case 'rect': case 'ellipse': {
      const b = s.box;
      if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) throw new Error(`${s.type} needs "box" {x, y, width, height}.`);
      points = [[b.x, b.y], [b.x + b.width, b.y + b.height]];
      break;
    }
    case 'pen': case 'highlight':
      if (!Array.isArray(s.points) || s.points.length < 2 || !s.points.every(isPt)) throw new Error(`${s.type} needs "points": at least two [x, y].`);
      points = s.points;
      break;
    default:
      if (!isPt(s.at)) throw new Error(`${s.type} needs "at" as [x, y].`);
      if (s.type === 'text' && !s.text) throw new Error('text needs "text".');
      points = [s.at];
  }
  points = points.map(map);
  if (points.length > 2) points = smooth(points);
  return { type: s.type, color, size, points, text: s.text || undefined, ...(s.type === 'step' && { step }) };
}
