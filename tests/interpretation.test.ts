import { beforeAll, describe, expect, it } from 'vitest';
import { LEVELS, levelSnapshot } from '../src/game/content';
import { makeDesign, makeSign } from '../src/core/scene';
import { simulate } from '../src/core/simulation';
import type { Run } from '../src/core/types';
import { compareSchemes, explainMetric, summaryMetrics } from '../src/game/interpretation';

describe('从总指标追到实际个体', () => {
  const level = LEVELS[1], snapshot = levelSnapshot(level);
  let original: Run, crowded: Run, revised: Run;
  beforeAll(() => {
    original = simulate(snapshot, level.baseline);
    crowded = simulate(snapshot, makeDesign([makeSign({ x: 7.2, y: 8.8 })]));
    revised = simulate(snapshot, makeDesign([makeSign({ x: 7.2, y: 8.8 }, { normal: { x: -1, y: 0 } })]));
  });
  it('均值解释保留每个人的成对结果，受益者和受损者都能追查', () => {
    const report = explainMetric(level, snapshot, original, crowded, 'mean');
    expect(report.people).toHaveLength(snapshot.agents.length);
    const sums = report.people.reduce((sum, row) => sum + row.current.arrivalTime!, 0);
    expect(sums / report.people.length).toBeCloseTo(crowded.metrics.meanArrival!, 8);
    for (const row of report.people) {
      expect(row.current).toEqual(crowded.agents.find(a => a.id === row.id));
      expect(crowded.events.some(e => e.agentId === row.id && e.time === row.time)).toBe(true);
    }
    expect(report.people.some(p => p.delta !== null && p.delta > .05)).toBe(true);
  });
  it('尾部和受限时间分别指向实际最晚者与最高受限者', () => {
    const tail = explainMetric(level, snapshot, original, crowded, 'tail');
    expect(tail.people[0].current.arrivalTime).toBe(crowded.metrics.lastArrival);
    const delay = explainMetric(level, snapshot, original, crowded, 'interaction');
    expect(delay.people[0].current.delay).toBe(Math.max(...crowded.agents.map(a => a.delay)));
    expect(delay.people[0].freeTravelTime).toBeCloseTo(delay.people[0].current.distance / snapshot.agents[delay.people[0].id - 1].speed, 8);
  });
  it('任意两个方案比较统计同一批人的代价，禁止把不同初态直接配对', () => {
    const pair = compareSchemes(crowded, revised);
    expect(pair.benefited + pair.harmed + pair.unchanged + pair.unresolved).toBe(snapshot.agents.length);
    expect(pair.people.find(a => a.id === 1)?.reference).toEqual(crowded.agents[0]);
    const another = simulate(levelSnapshot(level, 17), revised.design);
    expect(() => compareSchemes(crowded, another)).toThrow('初始人群');
  });
  it('公平目标只检查对应群体，不用整体均值替代慢行尾部或快行代价', () => {
    const care = LEVELS[2], batch = levelSnapshot(care), baseline = simulate(batch, care.baseline);
    const run = simulate(batch, makeDesign([makeSign({ x: 11.9, y: 8.8 }, { until: 20 })]));
    const slow = explainMetric(care, batch, baseline, run, 'care');
    const fast = explainMetric(care, batch, baseline, run, 'protect');
    expect(slow.people.every(p => p.current.cohort === 'slow')).toBe(true);
    expect(fast.people.every(p => p.current.cohort === 'fast')).toBe(true);
    expect(slow.people[0].current.arrivalTime).toBe(run.metrics.cohorts.slow.tail);
  });
  it('更照顾慢行尾部的方案可以牺牲部分平均效率，比较必须同时展示这两项', () => {
    const care = LEVELS[2], batch = levelSnapshot(care);
    const sooner = simulate(batch, makeDesign([makeSign({ x: 11.9, y: 8.8 })]));
    const selective = simulate(batch, makeDesign([makeSign({ x: 11.9, y: 8.8 }, { from: 3 })]));
    expect(selective.metrics.meanArrival).toBeGreaterThan(sooner.metrics.meanArrival!);
    expect(selective.metrics.cohorts.slow.tail).toBeLessThan(sooner.metrics.cohorts.slow.tail!);
    const pair = compareSchemes(sooner, selective);
    expect(pair.harmed).toBeGreaterThan(0);
    expect(pair.benefited).toBeGreaterThan(0);
  });
  it('第三课主结果直接显示两组核心指标，不用整体尾部替代群体差异', () => {
    const care=LEVELS[2], batch=levelSnapshot(care), baseline=simulate(batch,care.baseline);
    const first=simulate(batch,makeDesign([makeSign({x:11.9,y:8.8},{until:20})]));
    const next=simulate(batch,makeDesign([makeSign({x:11.9,y:8.8},{from:3,until:20})]));
    const before=summaryMetrics(care,baseline,first),after=summaryMetrics(care,baseline,next);
    expect(after.map(item=>item.id)).toEqual(['all','mean','care','protect']);
    expect(after.find(item=>item.id==='mean')!.actual).toBeGreaterThan(before.find(item=>item.id==='mean')!.actual!);
    expect(after.find(item=>item.id==='care')!.actual).toBeLessThan(before.find(item=>item.id==='care')!.actual!);
    expect(after.find(item=>item.id==='protect')!.actual).toBeGreaterThan(before.find(item=>item.id==='protect')!.actual!);
    expect(after.find(item=>item.id==='care')!.baseline).toBe(baseline.metrics.cohorts.slow.tail);
  });
  it('有未完成者时，主结果带不把已完成者用时说成全员结果', () => {
    const care=structuredClone(LEVELS[2]);care.scene.exits.B.interval=9;
    const batch=levelSnapshot(care),baseline=simulate(batch,care.baseline);
    const run=simulate(batch,makeDesign([makeSign({x:6.3,y:11.7})]));
    expect(run.metrics.unfinished).toBeGreaterThan(0);
    const summary=summaryMetrics(care,baseline,run);
    expect(summary.find(item=>item.id==='mean')!.label).toContain('已完成');
    expect(summary.find(item=>item.id==='care')!.label).toContain('已完成');
    expect(summary.find(item=>item.id==='protect')!.label).not.toContain('已完成');
    expect(summary.find(item=>item.id==='all')!.actual).toBe(run.metrics.completed);
  });
  it('未读到信息的人回到真实经过检查读取条件，不虚构一条读取事件', () => {
    const first = LEVELS[0], batch = levelSnapshot(first), run = simulate(batch, first.baseline);
    const report = explainMetric(first, batch, run, run, 'information');
    const witness = report.people[0];
    expect(witness.current.learnedAt).toBeNull();
    expect(witness.observation).toContain('导视牌');
    expect(witness.signId).toBe(1);
    expect(run.frames.some(f => f.time === witness.time)).toBe(true);
    expect(run.events.some(e => e.agentId === witness.id && e.type === 'learn')).toBe(false);
  });
});
