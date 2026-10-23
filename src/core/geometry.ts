import type { Rect, Sign, Vec } from './types';

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, factor: number): Vec => ({ x: a.x * factor, y: a.y * factor });
export const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
export const length = (a: Vec) => Math.hypot(a.x, a.y);
export const distance = (a: Vec, b: Vec) => length(sub(a, b));
export const unit = (v: Vec): Vec => length(v) > 1e-9 ? scale(v, 1 / length(v)) : { x: 0, y: -1 };
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const inflate = (rect: Rect, radius: number): Rect => ({
  ...rect, x: rect.x - radius, y: rect.y - radius,
  w: rect.w + 2 * radius, h: rect.h + 2 * radius,
});

function inside(p: Vec, rect: Rect): boolean {
  return p.x > rect.x + 1e-7 && p.x < rect.x + rect.w - 1e-7
    && p.y > rect.y + 1e-7 && p.y < rect.y + rect.h - 1e-7;
}

function hitsRect(a: Vec, b: Vec, rect: Rect): boolean {
  const min = { x: rect.x + 1e-7, y: rect.y + 1e-7 };
  const max = { x: rect.x + rect.w - 1e-7, y: rect.y + rect.h - 1e-7 };
  const delta = sub(b, a);
  let enter = 0;
  let leave = 1;
  for (const axis of ['x', 'y'] as const) {
    if (Math.abs(delta[axis]) < 1e-10) {
      if (a[axis] < min[axis] || a[axis] > max[axis]) return false;
    } else {
      const t1 = (min[axis] - a[axis]) / delta[axis];
      const t2 = (max[axis] - a[axis]) / delta[axis];
      enter = Math.max(enter, Math.min(t1, t2));
      leave = Math.min(leave, Math.max(t1, t2));
      if (enter > leave) return false;
    }
  }
  return leave >= 0 && enter <= 1;
}

export function isWalkable(point: Vec, walls: Rect[], radius = 0): boolean {
  return walls.every(wall => radius > 0 ? pointRectDistanceSq(point, wall) >= Math.max(0, radius - 1e-7) ** 2 : !inside(point, wall));
}

export function segmentClear(a: Vec, b: Vec, walls: Rect[], radius = 0): boolean {
  return walls.every(wall => {
    if (!hitsRect(a, b, inflate(wall, radius))) return true;
    if (radius === 0 || hitsRect(a, b, wall)) return false;
    const corners = [{ x: wall.x, y: wall.y }, { x: wall.x + wall.w, y: wall.y },
      { x: wall.x + wall.w, y: wall.y + wall.h }, { x: wall.x, y: wall.y + wall.h }];
    const gap = Math.min(pointRectDistanceSq(a, wall), pointRectDistanceSq(b, wall), ...corners.map(p => pointSegmentDistanceSq(p, a, b)));
    return gap >= Math.max(0, radius - 1e-7) ** 2;
  });
}

function pointRectDistanceSq(p: Vec, r: Rect) {
  return Math.max(r.x - p.x, 0, p.x - r.x - r.w) ** 2 + Math.max(r.y - p.y, 0, p.y - r.y - r.h) ** 2;
}
function pointSegmentDistanceSq(p: Vec, a: Vec, b: Vec) {
  const ab = sub(b, a);
  const square = dot(ab, ab);
  const t = square > 1e-12 ? clamp(dot(sub(p, a), ab) / square, 0, 1) : 0;
  const delta = sub(p, add(a, scale(ab, t)));
  return dot(delta, delta);
}

export type ReadabilityReason = 'inactive' | 'range' | 'back' | 'view' | 'wall' | 'readable';
export interface ReadabilityResult { reason: ReadabilityReason; distance: number; conditions: { active: boolean; range: boolean; front: boolean; view: boolean; clear: boolean } }
export function readability(position: Vec, heading: Vec, sign: Sign, walls: Rect[], time = 0): ReadabilityResult {
  const towardSign = sub(sign.position, position);
  const d = length(towardSign);
  // Readable from the front 130° of the sign and within the agent's 150° field of view.
  const conditions = {
    active: time + 1e-7 >= sign.from && time < sign.until,
    range: d <= sign.range && d >= 1e-7,
    front: dot(unit(sub(position, sign.position)), sign.normal) >= Math.cos(65 * Math.PI / 180),
    view: dot(unit(towardSign), unit(heading)) >= Math.cos(75 * Math.PI / 180),
    clear: segmentClear(position, sign.position, walls),
  };
  const reason = !conditions.active ? 'inactive' : !conditions.range ? 'range' : !conditions.front ? 'back' : !conditions.view ? 'view' : !conditions.clear ? 'wall' : 'readable';
  return { reason, distance: d, conditions };
}
export const canReadSign = (position: Vec, heading: Vec, sign: Sign, walls: Rect[], time = 0) => readability(position, heading, sign, walls, time).reason === 'readable';

export interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
export const within = (p: Vec, b: Bounds) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;

/** Visibility graph of expanded rectangular obstacles. No scripted crowd trajectories. */
export function findPath(start: Vec, goal: Vec, walls: Rect[], radius: number, bounds?: Bounds): Vec[] {
  if (!isWalkable(start, walls, radius) || !isWalkable(goal, walls, radius)) {
    throw new Error('路径起点或终点没有足够的通行净空');
  }
  if (segmentClear(start, goal, walls, radius)) return [{ ...goal }];
  const nodes: Vec[] = [{ ...start }, { ...goal }];
  for (const wall of walls) {
    const expanded = inflate(wall, radius + 0.045);
    const corners = [
      { x: expanded.x, y: expanded.y },
      { x: expanded.x + expanded.w, y: expanded.y },
      { x: expanded.x + expanded.w, y: expanded.y + expanded.h },
      { x: expanded.x, y: expanded.y + expanded.h },
    ];
    nodes.push(...corners.filter(p => (!bounds || within(p, bounds)) && isWalkable(p, walls, radius)));
  }
  const costs = nodes.map(() => Infinity);
  const parents = nodes.map(() => -1);
  const visited = new Set<number>();
  costs[0] = 0;
  for (let n = 0; n < nodes.length; n++) {
    let closest = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (!visited.has(i) && (closest < 0 || costs[i] < costs[closest])) closest = i;
    }
    if (closest < 0 || !Number.isFinite(costs[closest])) break;
    if (closest === 1) break;
    visited.add(closest);
    for (let i = 0; i < nodes.length; i++) {
      if (visited.has(i) || i === closest) continue;
      const cost = costs[closest] + distance(nodes[closest], nodes[i]);
      if (cost + 1e-8 < costs[i] && segmentClear(nodes[closest], nodes[i], walls, radius)) {
        costs[i] = cost;
        parents[i] = closest;
      }
    }
  }
  if (!Number.isFinite(costs[1])) throw new Error('当前几何中没有可通行路径');
  const path: Vec[] = [];
  for (let i = 1; i !== 0; i = parents[i]) path.unshift(nodes[i]);
  return path;
}

export function pathLength(start: Vec, path: Vec[]): number {
  let total = 0;
  let previous = start;
  for (const point of path) { total += distance(previous, point); previous = point; }
  return total;
}

/** Minimum distance of two moving centers over their entire simultaneous step. */
export function sweptDistance(a: Vec, aEnd: Vec, b: Vec, bEnd: Vec): number {
  const relativeStart = sub(a, b);
  const relativeStep = sub(sub(aEnd, a), sub(bEnd, b));
  const sq = dot(relativeStep, relativeStep);
  const t = sq > 1e-12 ? clamp(-dot(relativeStart, relativeStep) / sq, 0, 1) : 0;
  return length(add(relativeStart, scale(relativeStep, t)));
}
