import { describe, expect, it } from 'vitest';
import { buildObstacles, solveVelocities, type MovingDisc } from '../src/core/avoidance';
import { add, distance, isWalkable, scale, segmentClear, sweptDistance } from '../src/core/geometry';
import reference from './fixtures/rvo2-upstream.json';

describe('ORCA 局部运动与静态边界', () => {
  it('圆盘可以绕过矩形的圆角净空，不把外接方框当作真实碰撞体', () => {
    const walls = [{ id: 'corner', x: 3, y: 3, w: 1, h: 1 }];
    expect(isWalkable({ x: 2.82, y: 2.82 }, walls, 0.23)).toBe(true);
    expect(segmentClear({ x: 2.7, y: 2.9 }, { x: 2.9, y: 2.7 }, walls, 0.23)).toBe(true);
    expect(isWalkable({ x: 2.9, y: 2.9 }, walls, 0.23)).toBe(false);
    expect(segmentClear({ x: 2.9, y: 2.8 }, { x: 2.8, y: 2.9 }, walls, 0.23)).toBe(false);
  });
  it('与固定版本的原作 C++ 实际输出一致（浮点容差 0.00002）', () => {
    expect(reference.upstream).toBe('c96a6ec8328492bae0721e59774026a119a60b4a');
    for (const test of reference.cases) {
      const discs: MovingDisc[] = test.name === 'pair' ? [
        { id: 1, position: { x: -3, y: 0 }, velocity: { x: 0, y: 0 }, preferred: { x: 1, y: 0.015 }, radius: 0.23, speed: 1.1 },
        { id: 2, position: { x: 3, y: 0 }, velocity: { x: 0, y: 0 }, preferred: { x: -1, y: -0.015 }, radius: 0.23, speed: 1.1 },
      ] : [{ id: 1, position: test.name === 'wall' ? { x: 0, y: 0 } : { x: -2, y: 1.5 }, velocity: { x: 0, y: 0 },
        preferred: test.name === 'wall' ? { x: 1.2, y: 0 } : { x: 1, y: 0.1 }, radius: 0.23, speed: 1.2 }];
      const walls = test.name === 'wall' ? [{ id: 'a', x: 3, y: -3, w: 0.5, h: 6 }] : test.name === 'corner' ? [
        { id: 'a', x: 0, y: 0, w: 3, h: 1 }, { id: 'b', x: 0, y: 0, w: 1, h: 3 },
      ] : [];
      const obstacles = buildObstacles(walls);
      for (let tick = 0; tick < test.steps; tick++) {
        const motion = solveVelocities(discs, obstacles, 0.1);
        discs.forEach(a => { a.velocity = motion.get(a.id)!.velocity; a.position = add(a.position, scale(a.velocity, 0.1)); });
      }
      discs.forEach((a, i) => {
        const expected = test.agents[i];
        expect(Math.abs(a.position.x - expected.x)).toBeLessThan(0.00002);
        expect(Math.abs(a.position.y - expected.y)).toBeLessThan(0.00002);
        expect(Math.abs(a.velocity.x - expected.vx)).toBeLessThan(0.00002);
        expect(Math.abs(a.velocity.y - expected.vy)).toBeLessThan(0.00002);
      });
    }
  });
  it('矩形并集消除内部边，不把重叠墙体当成相交多边形', () => {
    const obstacles = buildObstacles([
      { id: 'a', x: 0, y: 0, w: 3, h: 1 },
      { id: 'b', x: 0, y: 0, w: 1, h: 3 },
    ]);
    expect(obstacles).toHaveLength(6);
    expect(obstacles.filter(o => !o.convex)).toHaveLength(1);
    for (const o of obstacles) {
      expect(o.next.prev).toBe(o);
      expect(distance(o.point, o.next.point)).toBeGreaterThan(0);
    }
  });

  it('开阔区域保持期望速度，求解顺序不产生不同结果', () => {
    const discs: MovingDisc[] = [
      { id: 1, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, preferred: { x: 1, y: 0 }, radius: 0.23, speed: 1.2 },
      { id: 2, position: { x: 20, y: 20 }, velocity: { x: 0, y: 0 }, preferred: { x: -1, y: 0 }, radius: 0.23, speed: 1.2 },
    ];
    const result = solveVelocities(discs, [], 0.1);
    expect(result.get(1)!.velocity).toEqual({ x: 1, y: 0 });
    expect(result.get(2)!.velocity).toEqual({ x: -1, y: 0 });
    expect(solveVelocities([...discs].reverse(), [], 0.1)).toEqual(result);
  });

  it('相向通行连续无碰撞，并能在有限时间内相互通过', () => {
    const agents: MovingDisc[] = [
      { id: 1, position: { x: -3, y: 0 }, velocity: { x: 0, y: 0 }, preferred: { x: 1, y: 0.015 }, radius: 0.23, speed: 1.1 },
      { id: 2, position: { x: 3, y: 0 }, velocity: { x: 0, y: 0 }, preferred: { x: -1, y: -0.015 }, radius: 0.23, speed: 1.1 },
    ];
    for (let tick = 0; tick < 100; tick++) {
      const motion = solveVelocities(agents, [], 0.1);
      const ends = agents.map(a => add(a.position, scale(motion.get(a.id)!.velocity, 0.1)));
      expect(sweptDistance(agents[0].position, ends[0], agents[1].position, ends[1])).toBeGreaterThanOrEqual(0.459);
      agents.forEach((a, i) => { a.velocity = motion.get(a.id)!.velocity; a.position = ends[i]; });
    }
    expect(agents[0].position.x).toBeGreaterThan(2);
    expect(agents[1].position.x).toBeLessThan(-2);
  });

  it('静态墙前逐步减速，不穿入矩形圆盘净空', () => {
    const walls = [{ id: 'wall', x: 3, y: -3, w: 0.5, h: 6 }];
    const obstacles = buildObstacles(walls);
    const agent: MovingDisc = { id: 1, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, preferred: { x: 1.2, y: 0 }, radius: 0.23, speed: 1.2 };
    for (let tick = 0; tick < 100; tick++) {
      const velocity = solveVelocities([agent], obstacles, 0.1).get(1)!.velocity;
      const end = add(agent.position, scale(velocity, 0.1));
      expect(segmentClear(agent.position, end, walls, 0.229)).toBe(true);
      agent.position = end;
      agent.velocity = velocity;
    }
    expect(agent.position.x).toBeLessThanOrEqual(2.771);
    expect(agent.position.x).toBeGreaterThan(2.5);
  });
});
