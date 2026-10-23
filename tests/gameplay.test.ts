import { describe, expect, it } from 'vitest';
import { makeDesign, makeSign, SIGN_POSITIONS, designWalls, STEP } from '../src/core/scene';
import { simulate, frameAt } from '../src/core/simulation';
import { distance, isWalkable, sweptDistance } from '../src/core/geometry';
import { LEVELS, levelSnapshot } from '../src/game/content';
import { completed, evaluate, validateLevelDesign } from '../src/game/evaluation';
import references from './fixtures/campaign-designs.json';
import type { Design } from '../src/core/types';

describe('新的规则世界与关卡', () => {
  it('最后一课需要继续组织另一股人流，单侧信息改善还不足以达到综合目标', () => {
    const level = LEVELS[3], snapshot = levelSnapshot(level);
    const baseline = simulate(snapshot, level.baseline);
    const oneSide = simulate(snapshot, makeDesign([makeSign({ x: 6.7, y: 5.2 }), makeSign({ x: 21.3, y: 8.5 }, { id: 2, target: 'A' })]));
    expect(oneSide.metrics.meanArrival).toBeLessThan(baseline.metrics.meanArrival!);
    expect(completed(evaluate(level, baseline, oneSide))).toBe(false);
  });
  it('有人未完成时，不能靠把他排除在到达均值之外宣称耗时目标达成', () => {
    const level = LEVELS[1], snapshot = levelSnapshot(level);
    const baseline = simulate(snapshot, level.baseline);
    const partial = { ...baseline, metrics: { ...baseline.metrics, completed: 41, unfinished: 1, meanArrival: 1, lastArrival: 2 } };
    const goals = evaluate(level, baseline, partial);
    expect(goals.filter(g => g.unit === '秒').every(g => !g.met)).toBe(true);
  });
  it('原始布局在展墙拐角形成的密集队列也保持连续身体净空', () => {
    const level = LEVELS[0];
    for (const seed of [level.seed, 0]) {
      const run = simulate(levelSnapshot(level, seed), level.baseline);
      for (let tick = 0; tick + 1 < run.frames.length; tick++) {
        const current = run.frames[tick], next = run.frames[tick + 1];
        const active = current.agents.filter(a => !a.arrived);
        for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
          const a = active[i], b = active[j];
          expect(sweptDistance(a, next.agents[a.id - 1], b, next.agents[b.id - 1]), `${seed}/${current.time}/${a.id},${b.id}`).toBeGreaterThanOrEqual(.459);
        }
      }
    }
  });
  it.each(references)('关卡 $level 存在跨三个初态成立的真实解法', reference => {
      const level = LEVELS.find(l => l.id === reference.level)!;
      for (const seed of [level.seed, 17, 8201]) {
        const snapshot = levelSnapshot(level, seed);
        const design = reference.design as Design;
        validateLevelDesign(level, snapshot, design);
        const baseline = simulate(snapshot, level.baseline);
        const run = simulate(snapshot, design);
        const goals = evaluate(level, baseline, run);
        expect(completed(goals), `${level.id}/${seed}: ${JSON.stringify(goals)}`).toBe(true);
      }
  });
  it('四个原始布局都能实际完成人群通行', () => {
    for (const level of LEVELS) {
      const snapshot = levelSnapshot(level);
      const run = simulate(snapshot, level.baseline);
      console.log('level-baseline', { id: level.id, count: run.metrics.completed, total: snapshot.agents.length,
        mean: +run.metrics.meanArrival!.toFixed(2), last: run.metrics.lastArrival, delay: +run.metrics.meanDelay.toFixed(2), time: run.duration });
      expect(run.metrics.completed).toBe(snapshot.agents.length);
      expect(run.metrics.unfinished).toBe(0);
    }
  });

  it('启用区间与正面改变谁收到信息，但不会抹去已经得到的知识', () => {
    const level = LEVELS[0];
    const snapshot = levelSnapshot(level);
    const full = simulate(snapshot, makeDesign([makeSign(SIGN_POSITIONS.early)]));
    const brief = simulate(snapshot, makeDesign([makeSign(SIGN_POSITIONS.early, { until: 0.1 })]));
    const late = simulate(snapshot, makeDesign([makeSign(SIGN_POSITIONS.early, { from: 98, until: 100 })]));
    const reverse = simulate(snapshot, makeDesign([makeSign(SIGN_POSITIONS.early, { normal: { x: 0, y: -1 } })]));
    expect(full.metrics.informed).toBeGreaterThan(brief.metrics.informed);
    expect(late.metrics.informed).toBe(0);
    expect(reverse.metrics.informed).toBeLessThan(full.metrics.informed);
    for (const learn of brief.events.filter(e => e.type === 'learn')) {
      expect(learn.time).toBeLessThan(0.1);
      expect(frameAt(brief, learn.time + 3).agents[learn.agentId - 1].knowsB).toBe(true);
    }
  });

  it('限流出口的实际放行间隔遵守设定，门前等待来自真实记录', () => {
    const level = LEVELS[1];
    const run = simulate(levelSnapshot(level), makeDesign([makeSign(SIGN_POSITIONS.early)]));
    for (const exit of ['A', 'B'] as const) {
      const arrivals = run.events.filter(e => e.type === 'arrive' && e.exit === exit);
      for (let i = 1; i < arrivals.length; i++) expect(arrivals[i].time - arrivals[i - 1].time + 0.001).toBeGreaterThanOrEqual(level.scene.exits[exit].interval);
    }
    expect(run.events.some(e => e.type === 'queue')).toBe(true);
    expect(run.agents.some(a => a.gateWait > 0)).toBe(true);
  });

  it('默认有效信息干预的逐帧运动与事件保持一致', () => {
    const level = LEVELS[0];
    const snapshot = levelSnapshot(level);
    const design = makeDesign([makeSign(SIGN_POSITIONS.early)]);
    const run = simulate(snapshot, design);
    const walls = designWalls(snapshot.scene, design);
    expect(run.metrics.completed).toBe(snapshot.agents.length);
    for (let tick = 0; tick < run.frames.length; tick++) {
      const frame = run.frames[tick];
      for (const learn of run.events.filter(e => e.type === 'learn' && Math.abs(e.time - frame.time) < 0.001)) {
        const a = frame.agents[learn.agentId - 1];
        expect(a.knowsB).toBe(true);
        expect(distance(a, learn.position)).toBeLessThan(1e-8);
      }
      const active = frame.agents.filter(a => !a.arrived);
      for (let i = 0; i < active.length; i++) {
        expect(isWalkable(active[i], walls, 0.229)).toBe(true);
        for (let j = i + 1; j < active.length; j++) {
          expect(distance(active[i], active[j])).toBeGreaterThanOrEqual(0.459);
          if (tick + 1 < run.frames.length) {
            const next = run.frames[tick + 1];
            expect(sweptDistance(active[i], next.agents[active[i].id - 1], active[j], next.agents[active[j].id - 1])).toBeGreaterThanOrEqual(0.459);
          }
        }
      }
    }
    expect(run.frames[1].time).toBe(STEP);
    expect(run).toEqual(simulate(snapshot, design));
  });

  it('导流栏实质改变可行路径和运动，且工具预算不可绕过', () => {
    const level = LEVELS[3];
    const snapshot = levelSnapshot(level);
    const barrierDesign = makeDesign([makeSign({ x: 11, y: 9 })], { position: { x: 11.8, y: 6.8 }, vertical: true });
    validateLevelDesign(level, snapshot, barrierDesign);
    const withBarrier = simulate(snapshot, barrierDesign);
    const withoutBarrier = simulate(snapshot, { ...barrierDesign, barrier: null });
    expect(withBarrier.fingerprint).not.toBe(withoutBarrier.fingerprint);
    expect(() => validateLevelDesign(level, snapshot, { ...level.baseline, barrier: barrierDesign.barrier })).toThrow();
  });
});
