import { validatePhysicalDesign } from '../core/scene';
import type { Design, Run, Snapshot } from '../core/types';
import type { Level } from './content';

export type MetricId = 'all' | 'mean' | 'tail' | 'information' | 'care' | 'protect' | 'interaction';
export interface GoalResult { id: MetricId; label: string; actual: number; target: number; unit: string; met: boolean; explanation: string }
const rounded = (n: number) => Math.round(n * 10) / 10;

export function validateLevelDesign(level: Level, snapshot: Snapshot, design: Design, checkPaths = true) {
  if (design.signs.length > level.maxSigns || (design.barrier !== null && !level.allowBarrier)) throw new Error('这节课没有提供这些工具');
  if (design.signs.length + (design.barrier ? 1 : 0) > level.tools) throw new Error(`本节仅有 ${level.tools} 份干预预算，请先移除一件工具`);
  validatePhysicalDesign(snapshot, design, checkPaths);
}

export function evaluate(level: Level, baseline: Run, run: Run): GoalResult[] {
  const total = baseline.agents.length;
  const results: GoalResult[] = [{ id: 'all', label: '每个人都能离开', actual: run.metrics.completed, target: total, unit: '人',
    met: run.metrics.completed === total, explanation: '到达出口门槛并完成放行才计为通过，未完成者不能从平均值里消失。' }];
  const less = (id: MetricId, label: string, actual: number | null, target: number, explanation: string) => {
    const value = actual === null ? Infinity : rounded(actual);
    results.push({ id, label, actual: value, target: rounded(target), unit: '秒',
      met: run.metrics.unfinished === 0 && Number.isFinite(value) && value <= rounded(target),
      explanation: run.metrics.unfinished ? '还有人未完成，本轮不能将仅已离开者的耗时视为全员达标。' : explanation });
  };
  if (level.targets.cohort) {
    const cohort = level.targets.cohort;
    less('care', '慢行组最后一人更早离开', run.metrics.cohorts[cohort]?.tail ?? null,
      (baseline.metrics.cohorts[cohort].tail ?? 0) * level.targets.cohortTail!, '看见具体人群的尾部用时，不用平均数替代他们的经历。');
    const protectedCohort = level.targets.protectCohort!;
    less('protect', '不把代价交给快行组', run.metrics.cohorts[protectedCohort]?.mean ?? null,
      baseline.metrics.cohorts[protectedCohort].mean! * level.targets.protectMean!, '快行组的平均用时最多比原始布局增加 8%。');
  } else {
    less('mean', `整体平均用时降低 ${Math.round((1 - level.targets.mean) * 100)}%`, run.metrics.meanArrival, baseline.metrics.meanArrival! * level.targets.mean,
      '与同一初态的原始布局比较；所有人通过后，平均用时才有完整意义。');
    if (level.targets.informed) results.push({ id: 'information', label: '让信息真正抵达', actual: run.metrics.informed,
      target: level.targets.informed, unit: '人', met: run.metrics.informed >= level.targets.informed,
      explanation: '从真实读取标识的事件计数，覆盖区域本身不等于人已经读到。' });
    else less('tail', '最后的人也没有被牺牲', run.metrics.lastArrival, baseline.metrics.lastArrival! * level.targets.tail,
      '最后一人的用时也必须达到目标，避免用多数人的改善遮住少数人的损失。');
  }
  if (level.targets.delay) less('interaction', '降低平均受限耗时', run.metrics.meanDelay, baseline.metrics.meanDelay * level.targets.delay,
    '实际用时减去按个人期望速度走完实际行程的用时，包含避让、减速和门前等待。');
  return results;
}

export const completed = (goals: GoalResult[]) => goals.length > 0 && goals.every(goal => goal.met);
