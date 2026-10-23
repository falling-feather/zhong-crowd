import { describe, expect, it } from 'vitest';
import { LEVELS, levelSnapshot } from '../src/game/content';
import { simulate } from '../src/core/simulation';
import { makeDesign, makeSign } from '../src/core/scene';
import { createGuidance, compareTrials } from '../src/game/guidance';

describe('失败到下一轮试验的引导', () => {
  it('有人尚未完成时，不把耗时目标的前置条件失败说成快行组数值超限', () => {
    const level = structuredClone(LEVELS[2]);
    level.scene.exits.B.interval = 9;
    const snapshot = levelSnapshot(level), baseline = simulate(snapshot, level.baseline);
    const run = simulate(snapshot, makeDesign([makeSign({ x: 6.3, y: 11.7 })]));
    expect(run.metrics.unfinished).toBeGreaterThan(0);
    expect(run.metrics.cohorts.fast.mean).toBeLessThan(baseline.metrics.cohorts.fast.mean! * level.targets.protectMean!);
    const guide = createGuidance(level, snapshot, baseline, run)!;
    expect(guide.observation).toContain('未通过');
    expect(guide.observation).not.toContain('超过保护上限');
  });
  it('平均改善却让快行组付出过多代价时，先指出受损者，不继续泛泛扩大告知', () => {
    const level = LEVELS[2], snapshot = levelSnapshot(level), baseline = simulate(snapshot, level.baseline);
    const run = simulate(snapshot, makeDesign([makeSign({ x: 14, y: 7.5 }, { normal: { x: -1, y: 0 } })]));
    const guide = createGuidance(level, snapshot, baseline, run)!;
    expect(run.metrics.meanArrival).toBeLessThan(baseline.metrics.meanArrival!);
    expect(guide.title).toContain('代价');
    expect(run.agents.find(a => a.id === guide.agentId)!.cohort).toBe('fast');
    expect(guide.variable).toBe('from');
    expect(guide.experiment).toContain('延后');
    expect(guide.check).toContain('慢行组');
    const revised = simulate(snapshot, makeDesign([makeSign({ x: 14, y: 7.5 }, { normal: { x: -1, y: 0 }, from: 3 })]));
    expect(revised.metrics.cohorts.fast.mean).toBeLessThan(run.metrics.cohorts.fast.mean!);
  });
  it('最后一课已有一侧收到信息时，引导补上另一侧，而非让玩家反复旋转已有效的牌', () => {
    const level = LEVELS[3], snapshot = levelSnapshot(level), baseline = simulate(snapshot, level.baseline);
    const run = simulate(snapshot, makeDesign([makeSign({ x: 6.7, y: 5.2 }), makeSign({ x: 21.3, y: 8.5 }, { id: 2, target: 'A' })]));
    const guide = createGuidance(level, snapshot, baseline, run)!;
    expect(guide.signId).toBe(1);
    expect(guide.agentId).toBeLessThanOrEqual(24);
    expect(guide.variable).toBe('position');
    expect(guide.observation).toContain('西厅组');
  });
  it('第一课从实际错过的机会中找到墙体遮挡，并给单独的位置试验', () => {
    const level = LEVELS[0], snapshot = levelSnapshot(level), baseline = simulate(snapshot, level.baseline);
    const guide = createGuidance(level, snapshot, baseline, baseline)!;
    expect(guide.variable).toBe('position');
    expect(guide.map.wallId).toBe('exhibit');
    expect(guide.experiment).toContain('墙');
    expect(guide.map.path.length).toBeGreaterThan(1);
    const actual = baseline.frames[Math.round(guide.time * 10)].agents[guide.agentId - 1];
    expect(guide.map.point).toEqual({ x: actual.x, y: actual.y });
  });
  it('第二课的窄门超载后，明确只改朝向，观察告知人数和尾部时间', () => {
    const level = LEVELS[1], snapshot = levelSnapshot(level), baseline = simulate(snapshot, level.baseline);
    const run = simulate(snapshot, makeDesign([makeSign({ x: 6.3, y: 8.8 })]));
    const guide = createGuidance(level, snapshot, baseline, run)!;
    expect(guide.variable).toBe('orientation');
    expect(guide.map.exit).toBe('B');
    expect(guide.observation).toContain('32');
    expect(guide.check).toContain('人数');
    expect(guide.check).toContain('最后');
  });
  it('只旋转一块牌的后续试验按真实结果比较，而不再只说没有过关', () => {
    const level = LEVELS[1], snapshot = levelSnapshot(level);
    const first = simulate(snapshot, makeDesign([makeSign({ x: 6.3, y: 8.8 })]));
    const next = simulate(snapshot, makeDesign([makeSign({ x: 6.3, y: 8.8 }, { normal: { x: -1, y: 0 } })]));
    const comparison = compareTrials(first, next);
    expect(comparison.changes).toEqual(['1 号导视牌的朝向']);
    expect(comparison.before.informed).toBe(first.metrics.informed);
    expect(comparison.after.mean).toBe(next.metrics.meanArrival);
    expect(comparison.after.tail).toBe(next.metrics.lastArrival);
  });
});
