import { describe, expect, it } from 'vitest';
import { solveVelocities, buildObstacles } from '../src/core/avoidance';
import { projectMotion } from '../src/core/motion';
import { add, distance, length, scale, segmentClear, sweptDistance } from '../src/core/geometry';
import doorway from './fixtures/dense-doorway.json';

describe('连续接触运动约束', () => {
  it('真实密集门前的 ORCA 不可行片段仍满足身体、墙体、边界与步速约束', () => {
    const input = doorway.bodies;
    const proposed = solveVelocities(input.map(a => ({ ...a, radius: a.radius + .02 })), buildObstacles(doorway.walls), .1, doorway.bounds);
    const motion = projectMotion(input, proposed, doorway.walls, .1, doorway.bounds);
    const ends = input.map(a => add(a.position, scale(motion.get(a.id)!.velocity, .1)));
    input.forEach((a, i) => {
      expect(length(motion.get(a.id)!.velocity)).toBeLessThanOrEqual(a.speed + 1e-7);
      expect(segmentClear(a.position, ends[i], doorway.walls, .229999)).toBe(true);
      expect(ends[i].x).toBeGreaterThanOrEqual(doorway.bounds.minX - 1e-8);
      expect(ends[i].x).toBeLessThanOrEqual(doorway.bounds.maxX + 1e-8);
      expect(ends[i].y).toBeGreaterThanOrEqual(doorway.bounds.minY - 1e-8);
      expect(ends[i].y).toBeLessThanOrEqual(doorway.bounds.maxY + 1e-8);
      for (let j = i + 1; j < input.length; j++) expect(sweptDistance(a.position, ends[i], input[j].position, ends[j])).toBeGreaterThanOrEqual(.459999);
    });
    expect(projectMotion([...input].reverse(), proposed, doorway.walls, .1, doorway.bounds)).toEqual(motion);
  });

  it('没有约束冲突时完全保留 ORCA 的速度', () => {
    const bodies = [{ id: 1, position: { x: 2, y: 2 }, radius: .23, speed: 1.2 }];
    const proposed = new Map([[1, { velocity: { x: .8, y: -.3 }, constrainedBy: [] }]]);
    expect(projectMotion(bodies, proposed, [], .1)).toEqual(proposed);
  });

  it('从同一快照同时约束相向运动，不逐个挤开位置或凭空增加步速', () => {
    const bodies = [{ id: 1, position: { x: 0, y: 0 }, radius: .23, speed: 1 }, { id: 2, position: { x: .5, y: 0 }, radius: .23, speed: 1 }];
    const proposed = new Map([[1, { velocity: { x: 1, y: 0 }, constrainedBy: [] }], [2, { velocity: { x: -1, y: 0 }, constrainedBy: [] }]]);
    const motion = projectMotion(bodies, proposed, [], .1);
    const ends = bodies.map(a => add(a.position, scale(motion.get(a.id)!.velocity, .1)));
    expect(distance(ends[0], ends[1])).toBeCloseTo(.46, 7);
    expect(ends[0].x).toBeCloseTo(.02, 7);
    expect(ends[1].x).toBeCloseTo(.48, 7);
  });
});
