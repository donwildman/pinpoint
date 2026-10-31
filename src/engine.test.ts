import { expect, test } from 'bun:test';
import { COLORS, constrain, contentBounds, fromSpec, hit, smooth, type Mark } from './engine';

const mk = (type: Mark['type'], points: Mark['points'], extra: Partial<Mark> = {}): Mark =>
  ({ type, color: '#ff3b30', size: 1, points, ...extra });

test('smooth keeps endpoints and adds points', () => {
  const s = smooth([[0, 0], [10, 0], [10, 10]]);
  expect(s[0]).toEqual([0, 0]);
  expect(s.at(-1)).toEqual([10, 10]);
  expect(s.length).toBeGreaterThan(3);
});

test('hit-tests strokes, outlines and labels', () => {
  const line = mk('line', [[0, 0], [100, 0]]);
  expect(hit(line, [50, 5])).toBe(true);
  expect(hit(line, [50, 40])).toBe(false);

  const rect = mk('rect', [[0, 0], [100, 100]]);
  expect(hit(rect, [100, 50])).toBe(true);
  expect(hit(rect, [50, 50])).toBe(false); // the inside of a box is not the box

  const ell = mk('ellipse', [[0, 0], [100, 100]]);
  expect(hit(ell, [50, 0])).toBe(true);
  expect(hit(ell, [50, 50])).toBe(false);

  expect(hit(mk('step', [[200, 200]], { step: 1 }), [205, 195])).toBe(true);
  expect(hit(mk('text', [[0, 0]], { text: 'hello' }), [10, 10])).toBe(true);
});

test('constrain snaps to 45°, squares and centers', () => {
  const [, end] = constrain('line', [0, 0], [100, 10], true, false);
  expect(end[1]).toBeCloseTo(0);
  expect(constrain('rect', [0, 0], [100, 40], true, false)[1]).toEqual([100, 100]);
  expect(constrain('rect', [50, 50], [60, 70], false, true)).toEqual([[40, 30], [60, 70]]);
});

test('contentBounds spans every mark', () => {
  const b = contentBounds([mk('line', [[0, 0], [10, 10]]), mk('line', [[100, 100], [200, 50]])])!;
  expect(b.x).toBeLessThan(0);
  expect(b.x + b.w).toBeGreaterThan(200);
  expect(contentBounds([])).toBeNull();
});

test('turns agent specs into marks in page space', () => {
  const half = (p: [number, number]): [number, number] => [p[0] / 2, p[1] / 2];
  expect(fromSpec({ type: 'arrow', from: [0, 0], to: [100, 50], color: 'blue' }, half, 1))
    .toEqual({ type: 'arrow', color: COLORS[4], size: 2, points: [[0, 0], [50, 25]], text: undefined });
  expect(fromSpec({ type: 'rect', box: { x: 10, y: 20, width: 30, height: 40 } }, p => p, 1).points).toEqual([[10, 20], [40, 60]]);
  expect(fromSpec({ type: 'step', at: [5, 5], text: 'Click', color: '#00ff00' }, p => p, 3))
    .toMatchObject({ step: 3, text: 'Click', color: '#00ff00' });
  expect(() => fromSpec({ type: 'text', at: [0, 0] }, p => p, 1)).toThrow('text needs');
  expect(() => fromSpec({ type: 'arrow', from: [0, 0] }, p => p, 1)).toThrow('from');
  expect(() => fromSpec({ type: 'blob' as never }, p => p, 1)).toThrow('Unknown');
});
