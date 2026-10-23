import { clamp, type Bounds } from './geometry';
import type { Motion } from './avoidance';
import type { Rect, Vec } from './types';

interface Body { id: number; position: Vec; radius: number; speed: number }
interface Constraint { a: number; b: number; nx: number; ny: number; limit: number; correction: number }
const TOLERANCE = 1e-8;

/**
 * ORCA's crowded LP can be infeasible. Before integrating, project all proposed
 * velocities together onto convex, one-step contact constraints (Dykstra sweeps).
 * A pair retains separation along its current normal throughout the entire step;
 * each rectangle uses its nearest supporting plane. Positions are never pushed.
 * Zero motion is feasible for a non-overlapping snapshot, including at bounds.
 */
export function projectMotion(bodies: Body[], proposed: Map<number, Motion>, walls: Rect[], step: number, bounds?: Bounds): Map<number, Motion> {
  const ordered = [...bodies].sort((a, b) => a.id - b.id);
  const values = new Float64Array(ordered.length * 2);
  const speedCorrection = new Float64Array(values.length);
  const constraints: Constraint[] = [];
  const add = (a: number, b: number, nx: number, ny: number, limit: number) => constraints.push({ a, b, nx, ny, limit, correction: 0 });
  ordered.forEach((a, i) => {
    const velocity = proposed.get(a.id)?.velocity;
    if (!velocity) throw new Error(`缺少第 ${a.id} 号的运动提案`);
    values[i * 2] = velocity.x; values[i * 2 + 1] = velocity.y;
    if (bounds) {
      add(i, -1, 1, 0, (bounds.minX - a.position.x) / step);
      add(i, -1, -1, 0, (a.position.x - bounds.maxX) / step);
      add(i, -1, 0, 1, (bounds.minY - a.position.y) / step);
      add(i, -1, 0, -1, (a.position.y - bounds.maxY) / step);
    }
    for (const wall of walls) {
      const dx = a.position.x - clamp(a.position.x, wall.x, wall.x + wall.w);
      const dy = a.position.y - clamp(a.position.y, wall.y, wall.y + wall.h);
      const distance = Math.hypot(dx, dy);
      if (distance > a.radius + a.speed * step) continue;
      if (distance < a.radius - 1e-7) throw new Error('接触检查发现身体起点位于墙体内');
      add(i, -1, dx / distance, dy / distance, (a.radius - distance) / step);
    }
    for (let j = 0; j < i; j++) {
      const b = ordered[j];
      const dx = a.position.x - b.position.x, dy = a.position.y - b.position.y;
      const distance = Math.hypot(dx, dy), radii = a.radius + b.radius;
      if (distance > radii + (a.speed + b.speed) * step) continue;
      if (distance < radii - 1e-7) throw new Error('接触检查发现身体起点重叠');
      add(i, j, dx / distance, dy / distance, (radii - distance) / step);
    }
  });
  const value = (c: Constraint) => c.nx * (values[c.a * 2] - (c.b < 0 ? 0 : values[c.b * 2]))
    + c.ny * (values[c.a * 2 + 1] - (c.b < 0 ? 0 : values[c.b * 2 + 1]));
  const residual = () => Math.max(0, ...constraints.map(c => c.limit - value(c)), ...ordered.map((a, i) => Math.hypot(values[i * 2], values[i * 2 + 1]) - a.speed));
  let violation = residual();
  for (let iteration = 0; violation > TOLERANCE && iteration < 2000; iteration++) {
    for (const c of constraints) {
      const normSquared = c.b < 0 ? 1 : 2;
      const projection = Math.max(0, (c.limit - value(c) + c.correction * normSquared) / normSquared);
      const delta = projection - c.correction;
      c.correction = projection;
      values[c.a * 2] += delta * c.nx; values[c.a * 2 + 1] += delta * c.ny;
      if (c.b >= 0) { values[c.b * 2] -= delta * c.nx; values[c.b * 2 + 1] -= delta * c.ny; }
    }
    ordered.forEach((a, i) => {
      const x = values[i * 2] + speedCorrection[i * 2], y = values[i * 2 + 1] + speedCorrection[i * 2 + 1];
      const ratio = Math.min(1, a.speed / Math.max(1e-15, Math.hypot(x, y)));
      values[i * 2] = x * ratio; values[i * 2 + 1] = y * ratio;
      speedCorrection[i * 2] = x - values[i * 2]; speedCorrection[i * 2 + 1] = y - values[i * 2 + 1];
    });
    violation = residual();
  }
  if (violation > TOLERANCE) throw new Error(`接触约束未收敛（${violation.toExponential(2)}），本轮未生成结果`);
  return new Map(ordered.map((a, i) => {
    const peers = constraints.filter(c => c.b >= 0 && c.correction > TOLERANCE && (c.a === i || c.b === i))
      .map(c => ordered[c.a === i ? c.b : c.a].id);
    return [a.id, { velocity: { x: values[i * 2], y: values[i * 2 + 1] },
      constrainedBy: [...new Set([...proposed.get(a.id)!.constrainedBy, ...peers])].sort((x, y) => x - y) }];
  }));
}
