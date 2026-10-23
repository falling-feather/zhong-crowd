/*
 * Adapted from RVO2 v2.0.2 Agent.cpp (c96a6ec8328492bae0721e59774026a119a60b4a).
 * Copyright 2008 University of North Carolina at Chapel Hill.
 * Licensed under Apache-2.0; see ../../licenses/RVO2-Apache-2.0.txt.
 * Changes: TypeScript vectors, exhaustive stable neighbor search for small crowds,
 * orthogonal-wall union contours and explicit per-step scene bounds.
 * https://github.com/snape/RVO2/blob/c96a6ec8328492bae0721e59774026a119a60b4a/src/Agent.cpp
 */
import { add, sub, scale, dot, length, clamp, type Bounds } from './geometry';
import type { Rect, Vec } from './types';

const EPS = 1e-5;
const zero = (): Vec => ({ x: 0, y: 0 });
const det = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
const square = (v: Vec) => dot(v, v);
const neg = (v: Vec) => scale(v, -1);
const norm = (v: Vec) => length(v) > 1e-12 ? scale(v, 1 / length(v)) : zero();
const clockwise = (v: Vec): Vec => ({ x: v.y, y: -v.x });
const counterclockwise = (v: Vec): Vec => ({ x: -v.y, y: v.x });

export interface MovingDisc {
  id: number;
  position: Vec;
  velocity: Vec;
  preferred: Vec;
  radius: number;
  speed: number;
}
export interface Obstacle { id: number; point: Vec; direction: Vec; convex: boolean; prev: Obstacle; next: Obstacle }
interface Line { point: Vec; direction: Vec; neighbor?: number }
export interface Motion { velocity: Vec; constrainedBy: number[] }

/** Extract the boundary of the rectangle union; no overlapping obstacle polygons. */
export function buildObstacles(rectangles: Rect[]): Obstacle[] {
  if (!rectangles.length) return [];
  const xs = [...new Set(rectangles.flatMap(r => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  const ys = [...new Set(rectangles.flatMap(r => [r.y, r.y + r.h]))].sort((a, b) => a - b);
  const filled = xs.slice(0, -1).map((x, i) => ys.slice(0, -1).map((y, j) => rectangles.some(r => {
    const mx = (x + xs[i + 1]) / 2;
    const my = (y + ys[j + 1]) / 2;
    return mx > r.x && mx < r.x + r.w && my > r.y && my < r.y + r.h;
  })));
  const edges: { start: Vec; end: Vec; used: boolean }[] = [];
  const occupied = (i: number, j: number) => filled[i]?.[j] ?? false;
  const edge = (x1: number, y1: number, x2: number, y2: number) => edges.push({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, used: false });
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    if (!occupied(i, j)) continue;
    if (!occupied(i, j - 1)) edge(xs[i], ys[j], xs[i + 1], ys[j]);
    if (!occupied(i + 1, j)) edge(xs[i + 1], ys[j], xs[i + 1], ys[j + 1]);
    if (!occupied(i, j + 1)) edge(xs[i + 1], ys[j + 1], xs[i], ys[j + 1]);
    if (!occupied(i - 1, j)) edge(xs[i], ys[j + 1], xs[i], ys[j]);
  }
  const key = (v: Vec) => `${v.x.toFixed(8)},${v.y.toFixed(8)}`;
  const outgoing = new Map<string, typeof edges>();
  for (const e of edges) outgoing.set(key(e.start), [...(outgoing.get(key(e.start)) ?? []), e]);
  const result: Obstacle[] = [];
  for (const first of edges) {
    if (first.used) continue;
    const polygon: Vec[] = [];
    let current = first;
    do {
      current.used = true;
      polygon.push(current.start);
      const next = outgoing.get(key(current.end))?.filter(e => !e.used);
      if (key(current.end) === key(first.start)) break;
      if (!next?.length) throw new Error('墙体轮廓未闭合');
      // Touching corners retain separate contours by choosing the leftmost continuation.
      const direction = sub(current.end, current.start);
      current = next.sort((a, b) => {
        const angle = (e: typeof current) => Math.atan2(det(direction, sub(e.end, e.start)), dot(direction, sub(e.end, e.start)));
        return angle(b) - angle(a);
      })[0];
    } while (!current.used);
    const corners = polygon.filter((p, i) => Math.abs(det(sub(p, polygon[(i - 1 + polygon.length) % polygon.length]), sub(polygon[(i + 1) % polygon.length], p))) > 1e-9);
    const nodes = corners.map((point, i) => ({ id: result.length + i, point, direction: norm(sub(corners[(i + 1) % corners.length], point)), convex: false } as Obstacle));
    nodes.forEach((o, i) => {
      o.prev = nodes[(i - 1 + nodes.length) % nodes.length];
      o.next = nodes[(i + 1) % nodes.length];
      o.convex = det(sub(o.point, o.prev.point), sub(o.next.point, o.point)) >= 0;
    });
    result.push(...nodes);
  }
  return result;
}

function segmentDistanceSq(point: Vec, a: Vec, b: Vec) {
  const ab = sub(b, a);
  const t = clamp(dot(sub(point, a), ab) / square(ab), 0, 1);
  return square(sub(point, add(a, scale(ab, t))));
}

function obstacleLines(agent: MovingDisc, obstacles: Obstacle[], horizon: number): Line[] {
  const lines: Line[] = [];
  const inverse = 1 / horizon;
  const radiusSq = agent.radius * agent.radius;
  const rangeSq = (horizon * agent.speed + agent.radius) ** 2;
  const neighbors = obstacles.filter(o => det(o.direction, sub(agent.position, o.point)) < 1e-8)
    .map(o => ({ obstacle: o, distance: segmentDistanceSq(agent.position, o.point, o.next.point) }))
    .filter(o => o.distance < rangeSq).sort((a, b) => a.distance - b.distance || a.obstacle.id - b.obstacle.id);
  for (const neighbor of neighbors) {
    let obstacle1 = neighbor.obstacle;
    let obstacle2 = obstacle1.next;
    const relative1 = sub(obstacle1.point, agent.position);
    const relative2 = sub(obstacle2.point, agent.position);
    if (lines.some(line => det(sub(scale(relative1, inverse), line.point), line.direction) - inverse * agent.radius >= -EPS
      && det(sub(scale(relative2, inverse), line.point), line.direction) - inverse * agent.radius >= -EPS)) continue;
    const d1 = square(relative1);
    const d2 = square(relative2);
    const obstacleVector = sub(obstacle2.point, obstacle1.point);
    const s = dot(neg(relative1), obstacleVector) / square(obstacleVector);
    const distanceLine = square(sub(neg(relative1), scale(obstacleVector, s)));
    if (s < 0 && d1 <= radiusSq) {
      if (obstacle1.convex) lines.push({ point: zero(), direction: norm(counterclockwise(relative1)) });
      continue;
    }
    if (s > 1 && d2 <= radiusSq) {
      if (obstacle2.convex && det(relative2, obstacle2.direction) >= 0) lines.push({ point: zero(), direction: norm(counterclockwise(relative2)) });
      continue;
    }
    if (s >= 0 && s < 1 && distanceLine <= radiusSq) {
      lines.push({ point: zero(), direction: neg(obstacle1.direction) });
      continue;
    }
    const leftLeg = (relative: Vec, d: number) => {
      const leg = Math.sqrt(Math.max(0, d - radiusSq));
      return scale({ x: relative.x * leg - relative.y * agent.radius, y: relative.x * agent.radius + relative.y * leg }, 1 / d);
    };
    const rightLeg = (relative: Vec, d: number) => {
      const leg = Math.sqrt(Math.max(0, d - radiusSq));
      return scale({ x: relative.x * leg + relative.y * agent.radius, y: -relative.x * agent.radius + relative.y * leg }, 1 / d);
    };
    let left: Vec;
    let right: Vec;
    if (s < 0 && distanceLine <= radiusSq) {
      if (!obstacle1.convex) continue;
      obstacle2 = obstacle1;
      left = leftLeg(relative1, d1); right = rightLeg(relative1, d1);
    } else if (s > 1 && distanceLine <= radiusSq) {
      if (!obstacle2.convex) continue;
      obstacle1 = obstacle2;
      left = leftLeg(relative2, d2); right = rightLeg(relative2, d2);
    } else {
      left = obstacle1.convex ? leftLeg(relative1, d1) : neg(obstacle1.direction);
      right = obstacle2.convex ? rightLeg(relative2, d2) : obstacle1.direction;
    }
    let foreignLeft = false;
    let foreignRight = false;
    if (obstacle1.convex && det(left, neg(obstacle1.prev.direction)) >= 0) { left = neg(obstacle1.prev.direction); foreignLeft = true; }
    if (obstacle2.convex && det(right, obstacle2.direction) <= 0) { right = obstacle2.direction; foreignRight = true; }
    const leftCutoff = scale(sub(obstacle1.point, agent.position), inverse);
    const rightCutoff = scale(sub(obstacle2.point, agent.position), inverse);
    const cutoffVector = sub(rightCutoff, leftCutoff);
    const t = obstacle1 === obstacle2 ? 0.5 : dot(sub(agent.velocity, leftCutoff), cutoffVector) / square(cutoffVector);
    const tLeft = dot(sub(agent.velocity, leftCutoff), left);
    const tRight = dot(sub(agent.velocity, rightCutoff), right);
    if ((t < 0 && tLeft < 0) || (obstacle1 === obstacle2 && tLeft < 0 && tRight < 0)) {
      const w = norm(sub(agent.velocity, leftCutoff));
      lines.push({ direction: clockwise(w), point: add(leftCutoff, scale(w, agent.radius * inverse)) });
      continue;
    }
    if (t > 1 && tRight < 0) {
      const w = norm(sub(agent.velocity, rightCutoff));
      lines.push({ direction: clockwise(w), point: add(rightCutoff, scale(w, agent.radius * inverse)) });
      continue;
    }
    const cutoffDistance = t < 0 || t > 1 || obstacle1 === obstacle2 ? Infinity : square(sub(agent.velocity, add(leftCutoff, scale(cutoffVector, t))));
    const leftDistance = tLeft < 0 ? Infinity : square(sub(agent.velocity, add(leftCutoff, scale(left, tLeft))));
    const rightDistance = tRight < 0 ? Infinity : square(sub(agent.velocity, add(rightCutoff, scale(right, tRight))));
    let direction: Vec;
    let cutoff: Vec;
    if (cutoffDistance <= leftDistance && cutoffDistance <= rightDistance) { direction = neg(obstacle1.direction); cutoff = leftCutoff; }
    else if (leftDistance <= rightDistance) {
      if (foreignLeft) continue;
      direction = left; cutoff = leftCutoff;
    } else {
      if (foreignRight) continue;
      direction = neg(right); cutoff = rightCutoff;
    }
    lines.push({ direction, point: add(cutoff, scale(counterclockwise(direction), agent.radius * inverse)) });
  }
  return lines;
}

function linearProgram1(lines: Line[], index: number, radius: number, target: Vec, directionOnly: boolean): Vec | null {
  const line = lines[index];
  const product = dot(line.point, line.direction);
  const discriminant = product * product + radius * radius - square(line.point);
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  let left = -product - root;
  let right = -product + root;
  for (let i = 0; i < index; i++) {
    const denominator = det(line.direction, lines[i].direction);
    const numerator = det(lines[i].direction, sub(line.point, lines[i].point));
    if (Math.abs(denominator) <= EPS) { if (numerator < 0) return null; continue; }
    const t = numerator / denominator;
    if (denominator >= 0) right = Math.min(right, t); else left = Math.max(left, t);
    if (left > right) return null;
  }
  const t = directionOnly ? (dot(target, line.direction) > 0 ? right : left) : clamp(dot(line.direction, sub(target, line.point)), left, right);
  return add(line.point, scale(line.direction, t));
}

function linearProgram2(lines: Line[], radius: number, target: Vec, directionOnly = false): { result: Vec; fail: number } {
  let result = directionOnly ? scale(target, radius) : square(target) > radius * radius ? scale(norm(target), radius) : target;
  for (let i = 0; i < lines.length; i++) if (det(lines[i].direction, sub(lines[i].point, result)) > 0) {
    const next = linearProgram1(lines, i, radius, target, directionOnly);
    if (next === null) return { result, fail: i };
    result = next;
  }
  return { result, fail: lines.length };
}

function linearProgram3(lines: Line[], staticCount: number, begin: number, radius: number, initial: Vec): Vec {
  let result = initial;
  let violation = 0;
  for (let i = begin; i < lines.length; i++) {
    if (det(lines[i].direction, sub(lines[i].point, result)) <= violation) continue;
    const projected = lines.slice(0, staticCount);
    for (let j = staticCount; j < i; j++) {
      const determinant = det(lines[i].direction, lines[j].direction);
      let point: Vec;
      if (Math.abs(determinant) <= EPS) {
        if (dot(lines[i].direction, lines[j].direction) > 0) continue;
        point = scale(add(lines[i].point, lines[j].point), 0.5);
      } else point = add(lines[i].point, scale(lines[i].direction, det(lines[j].direction, sub(lines[i].point, lines[j].point)) / determinant));
      projected.push({ point, direction: norm(sub(lines[j].direction, lines[i].direction)) });
    }
    const next = linearProgram2(projected, radius, counterclockwise(lines[i].direction), true);
    // Upstream retains the previous feasible velocity for round-off failure in the projected LP.
    if (next.fail === projected.length) result = next.result;
    violation = det(lines[i].direction, sub(lines[i].point, result));
  }
  return result;
}

export function solveVelocities(discs: MovingDisc[], obstacles: Obstacle[], step: number, bounds?: Bounds): Map<number, Motion> {
  const result = new Map<number, Motion>();
  const ordered = [...discs].sort((a, b) => a.id - b.id);
  for (const agent of ordered) {
    const lines = obstacleLines(agent, obstacles, 2);
    if (bounds) lines.push(
      { point: { x: (bounds.maxX - agent.position.x) / step, y: 0 }, direction: { x: 0, y: 1 } },
      { point: { x: (bounds.minX - agent.position.x) / step, y: 0 }, direction: { x: 0, y: -1 } },
      { point: { x: 0, y: (bounds.maxY - agent.position.y) / step }, direction: { x: -1, y: 0 } },
      { point: { x: 0, y: (bounds.minY - agent.position.y) / step }, direction: { x: 1, y: 0 } },
    );
    const staticCount = lines.length;
    const neighbors = ordered.filter(other => other.id !== agent.id && square(sub(other.position, agent.position)) < 25)
      .sort((a, b) => square(sub(a.position, agent.position)) - square(sub(b.position, agent.position)) || a.id - b.id);
    for (const other of neighbors) {
      const position = sub(other.position, agent.position);
      const velocity = sub(agent.velocity, other.velocity);
      const distSq = square(position);
      const combined = agent.radius + other.radius;
      let direction: Vec;
      let u: Vec;
      if (distSq > combined * combined) {
        const w = sub(velocity, scale(position, 1 / 2.2));
        const product = dot(w, position);
        if (product < 0 && product * product > combined * combined * square(w)) {
          const unitW = norm(w);
          direction = clockwise(unitW);
          u = scale(unitW, combined / 2.2 - length(w));
        } else {
          const leg = Math.sqrt(distSq - combined * combined);
          direction = det(position, w) > 0
            ? scale({ x: position.x * leg - position.y * combined, y: position.x * combined + position.y * leg }, 1 / distSq)
            : scale({ x: position.x * leg + position.y * combined, y: -position.x * combined + position.y * leg }, -1 / distSq);
          u = sub(scale(direction, dot(velocity, direction)), velocity);
        }
      } else {
        const w = sub(velocity, scale(position, 1 / step));
        const unitW = norm(w);
        direction = clockwise(unitW);
        u = scale(unitW, combined / step - length(w));
      }
      lines.push({ point: add(agent.velocity, scale(u, 0.5)), direction, neighbor: other.id });
    }
    const linear = linearProgram2(lines, agent.speed, agent.preferred);
    const velocity = linear.fail < lines.length ? linearProgram3(lines, staticCount, linear.fail, agent.speed, linear.result) : linear.result;
    if (!Number.isFinite(velocity.x) || !Number.isFinite(velocity.y)) throw new Error(`个体 ${agent.id} 的局部速度无效`);
    result.set(agent.id, { velocity, constrainedBy: lines.filter(line => line.neighbor !== undefined && Math.abs(det(line.direction, sub(line.point, velocity))) < 0.025).map(line => line.neighbor!) });
  }
  return result;
}
