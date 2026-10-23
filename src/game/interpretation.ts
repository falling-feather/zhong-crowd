import type { AgentResult, DecisionEvent, Run, Snapshot } from '../core/types';
import type { Level } from './content';
import { evaluate, type MetricId } from './evaluation';
import { closestObservation, observationAt, observationCopy } from './evidence';

export interface PersonComparison {
  id: number;
  reference: AgentResult;
  current: AgentResult;
  /** Positive means the current run took longer. Null means at least one run is unfinished. */
  delta: number | null;
}
export interface SchemeComparison {
  people: PersonComparison[];
  benefited: number;
  harmed: number;
  unchanged: number;
  unresolved: number;
}
export interface MetricPerson extends PersonComparison {
  label: string;
  time: number;
  event: DecisionEvent | null;
  freeTravelTime: number;
  observation: string;
  signId?: number;
}
export interface MetricExplanation {
  id: MetricId;
  title: string;
  definition: string;
  summary: string;
  people: MetricPerson[];
}

export interface SummaryMetric {
  id: MetricId;
  label: string;
  actual: number|null;
  baseline: number|null;
  unit: '人'|'秒';
}

/** Presentation only: read established metrics; never recalculate or rank a design. */
export function summaryMetrics(level: Level,baseline: Run,run: Run): SummaryMetric[] {
  const item=(id:MetricId,label:string,actual:number|null,original:number|null,unit:'人'|'秒'='秒'):SummaryMetric=>({id,label,actual,baseline:original,unit});
  const common=[item('all','本轮通过',run.metrics.completed,baseline.metrics.completed,'人'),
    item('mean',run.metrics.unfinished?'已完成者平均':'平均到达',run.metrics.meanArrival,baseline.metrics.meanArrival)];
  if(level.targets.cohort){
    const slow=run.metrics.cohorts[level.targets.cohort],fast=run.metrics.cohorts[level.targets.protectCohort!];
    return [...common,item('care',slow.completed===slow.count?'慢行组最晚':'慢行已完成最晚',slow.tail,baseline.metrics.cohorts[level.targets.cohort].tail),
      item('protect',fast.completed===fast.count?'快行组平均':'快行已完成平均',fast.mean,baseline.metrics.cohorts[level.targets.protectCohort!].mean)];
  }
  const tail=item('tail',run.metrics.unfinished?'已完成者最晚':'最后一人',run.metrics.lastArrival,baseline.metrics.lastArrival);
  if(level.targets.informed)return [...common,item('information','新获知人数',run.metrics.informed,baseline.metrics.informed,'人'),tail];
  return [...common,tail,item('interaction','平均受限',run.metrics.meanDelay,baseline.metrics.meanDelay)];
}

/** Frame zero already includes sensing, so compare initial positions/cohorts, never acquired knowledge. */
export function compareSchemes(reference: Run, current: Run): SchemeComparison {
  const initial = new Map(reference.frames[0].agents.map(a => [a.id, a]));
  if (reference.model !== current.model || reference.agents.length !== current.agents.length ||
      current.frames[0].agents.some(a => {
        const before = initial.get(a.id);
        return !before || before.x !== a.x || before.y !== a.y ||
          reference.agents.find(p => p.id === a.id)?.cohort !== current.agents.find(p => p.id === a.id)?.cohort;
      })) throw new Error('两份记录的初始人群不同，请在同一初态重新推演后比较');
  const originals = new Map(reference.agents.map(a => [a.id, a]));
  const people = current.agents.map(person => {
    const original = originals.get(person.id)!;
    return { id: person.id, reference: original, current: person,
      delta: original.arrivalTime === null || person.arrivalTime === null ? null : person.arrivalTime - original.arrivalTime };
  });
  const counts = { benefited: 0, harmed: 0, unchanged: 0, unresolved: 0 };
  for (const person of people) {
    if (person.reference.arrivalTime === null && person.current.arrivalTime === null) counts.unresolved++;
    else if (person.reference.arrivalTime === null || (person.delta !== null && person.delta < -.05)) counts.benefited++;
    else if (person.current.arrivalTime === null || (person.delta !== null && person.delta > .05)) counts.harmed++;
    else counts.unchanged++;
  }
  return { people, ...counts };
}

function evidenceEvent(run: Run, id: number, metric: MetricId): DecisionEvent | null {
  const events = run.events.filter(e => e.agentId === id);
  const order: DecisionEvent['type'][] = metric === 'information'
    ? ['learn', 'choose', 'arrive'] : ['blocked', 'queue', 'learn', 'arrive', 'choose'];
  for (const type of order) {
    const event = events.find(e => e.type === type);
    if (event) return event;
  }
  return null;
}
const n = (value: number | null) => value === null ? '未完成' : `${value.toFixed(1)} 秒`;
const titles: Record<MetricId, string> = { all: '谁还没有离开', mean: '平均数由谁组成', tail: '最后离开的是谁', information: '信息抵达了谁',
  care: '慢行组最后的人', protect: '谁承担了改善的代价', interaction: '受限耗时发生在哪里' };
const definitions: Record<MetricId, string> = {
  all: '完成门槛放行才计为通过。', mean: '将已完成者的到达用时相加，除以已完成人数；未完成者另列，不能据此宣称全员达标。',
  tail: '取已完成者中最晚的到达时刻；仍有人未完成时，该值不代表全员最后到达。',
  information: '每名观众第一次实际读到新出口时计数一次。未读到者列出最接近标识的真实经过，便于核查读取条件。',
  care: '只取慢行组中最晚的到达时刻。', protect: '只统计快行组的平均到达用时，个体按增加的用时排序。',
  interaction: '每人的实际用时减去按本人期望步速走完实际行程所需时间，最小计零；未完成者统计到本轮截止。',
};

export function explainMetric(level: Level, snapshot: Snapshot, reference: Run, current: Run, id: MetricId): MetricExplanation {
  const pair = compareSchemes(reference, current);
  let people = pair.people;
  if (id === 'care') people = people.filter(p => p.current.cohort === level.targets.cohort);
  if (id === 'protect') people = people.filter(p => p.current.cohort === level.targets.protectCohort);
  const arrival = (p: PersonComparison) => p.current.arrivalTime ?? Infinity;
  if (id === 'tail' || id === 'care' || id === 'all') people.sort((a, b) => arrival(b) - arrival(a) || a.id - b.id);
  else if (id === 'interaction') people.sort((a, b) => b.current.delay - a.current.delay || a.id - b.id);
  else if (id === 'information') people.sort((a, b) => Number(a.current.learnedAt !== null) - Number(b.current.learnedAt !== null) || a.id - b.id);
  else people.sort((a, b) => (b.delta ?? Infinity) - (a.delta ?? Infinity) || a.id - b.id);
  const goal = evaluate(level, reference, current).find(g => g.id === id);
  const summaries: Record<MetricId, string> = {
    all: `本轮 ${current.metrics.completed} 人通过，${current.metrics.unfinished} 人未完成。未完成者不会从通关判断中消失。`,
    mean: `${current.metrics.unfinished ? '仅已离开者的平均为' : '全员平均为'} ${n(current.metrics.meanArrival)}；同初态原始布局为 ${n(reference.metrics.meanArrival)}。${pair.benefited} 人更早，${pair.harmed} 人更晚。`,
    tail: `本轮最晚 ${n(current.metrics.lastArrival)}，原始 ${n(reference.metrics.lastArrival)}。${current.metrics.unfinished ? '仍有人未完成，不能把这个值称为全员最后到达。' : '以下按实际到达时刻排序。'}`,
    information: `${current.metrics.informed} 人实际读到新信息，${snapshot.agents.length - current.metrics.informed} 人未读到新信息。读到信息和决定改道是不同事件。`,
    care: `慢行组最晚 ${n(current.metrics.cohorts[level.targets.cohort ?? '']?.tail ?? null)}。以下只列慢行组，整体均值不能替代他们的尾部用时。`,
    protect: `快行组平均 ${n(current.metrics.cohorts[level.targets.protectCohort ?? '']?.mean ?? null)}。以下按比原始布局增加的用时排序，先看承担代价的人。`,
    interaction: `本轮平均受限 ${n(current.metrics.meanDelay)}，原始 ${n(reference.metrics.meanDelay)}。受限包含减速、避让与门前等待，不能全部称作排队。`,
  };
  return { id, title: titles[id], definition: definitions[id] + (goal?.explanation ?? ''),
    summary: summaries[id], people: people.map(person => {
      const seed = snapshot.agents.find(a => a.id === person.id)!;
      const event = evidenceEvent(current, person.id, id);
      const missed = id === 'information' && person.current.learnedAt === null ? closestObservation(snapshot, current, person.id) : null;
      const time = missed?.time ?? event?.time ?? 0;
      return { ...person, label: level.groups.find(g => g.id === person.current.cohort)!.label, event,
        time, freeTravelTime: person.current.distance / seed.speed, signId: missed?.sign,
        observation: id === 'information' ? observationCopy(observationAt(snapshot, current, person.id, time).filter(o => !missed || o.signId === missed.sign)) : '' };
    }) };
}
