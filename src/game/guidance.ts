import { readability, segmentClear } from '../core/geometry';
import { designWalls } from '../core/scene';
import { frameAt } from '../core/simulation';
import type { Design, ExitId, Run, Snapshot, Vec } from '../core/types';
import type { Level } from './content';
import { diagnose } from './evidence';
import { completed, evaluate } from './evaluation';

export type GuideVariable = 'position' | 'orientation' | 'from' | 'until' | 'target' | 'tools';
export const variableName: Record<GuideVariable, string> = { position: '位置', orientation: '朝向', from: '启用时刻', until: '关闭时刻', target: '目标出口', tools: '工具' };
export interface Guidance {
  title: string; observation: string; variable: GuideVariable; signId: number; experiment: string; check: string;
  agentId: number; time: number; sourceDesign: Design;
  map: { point: Vec; sign: Vec | null; wallId?: string; exit?: ExitId; path: Vec[]; label: string };
}
export interface TrialComparison { changes: string[]; before: { informed: number; mean: number | null; tail: number | null }; after: { informed: number; mean: number | null; tail: number | null } }

export function designChanges(before: Design, after: Design): string[] {
  const changes: string[] = [];
  if (before.signs.map(s => s.id).join() !== after.signs.map(s => s.id).join() || !!before.barrier !== !!after.barrier) changes.push('工具数量');
  for (const a of before.signs) {
    const b = after.signs.find(s => s.id === a.id); if (!b) continue;
    const prefix = `${a.id} 号导视牌的`;
    if (a.position.x !== b.position.x || a.position.y !== b.position.y) changes.push(`${prefix}位置`);
    if (a.normal.x !== b.normal.x || a.normal.y !== b.normal.y) changes.push(`${prefix}朝向`);
    if (a.from !== b.from) changes.push(`${prefix}启用时刻`);
    if (a.until !== b.until) changes.push(`${prefix}关闭时刻`);
    if (a.target !== b.target) changes.push(`${prefix}目标出口`);
  }
  if (before.barrier && after.barrier) {
    if (before.barrier.position.x !== after.barrier.position.x || before.barrier.position.y !== after.barrier.position.y) changes.push('导流栏的位置');
    if (before.barrier.vertical !== after.barrier.vertical) changes.push('导流栏的朝向');
  }
  return changes;
}
export function compareTrials(before: Run, after: Run): TrialComparison {
  const metrics = (run: Run) => ({ informed: run.metrics.informed, mean: run.metrics.meanArrival, tail: run.metrics.lastArrival });
  return { changes: designChanges(before.design, after.design), before: metrics(before), after: metrics(after) };
}

/** Find a recorded opportunity with the fewest failed reading conditions. No suggested winning coordinates. */
function missedOpportunity(snapshot: Snapshot, run: Run, cohort?: string) {
  const walls = designWalls(snapshot.scene, run.design);
  let best: { agentId: number; time: number; point: Vec; sign: Design['signs'][number]; reason: ReturnType<typeof readability>['reason']; count: number; priority: number; distance: number } | null = null;
  for (let tick = 0; tick < run.frames.length; tick += 2) {
    const frame = run.frames[tick];
    for (const person of frame.agents) {
      if (person.arrived || (cohort && snapshot.agents[person.id - 1].cohort !== cohort)) continue;
      for (const sign of run.design.signs) {
        if (sign.target === 'A' ? person.knowsA : person.knowsB) continue;
        const result = readability(person, { x: person.hx, y: person.hy }, sign, walls, frame.time);
        const count = Object.values(result.conditions).filter(v => !v).length;
        const priority = ({ wall: 0, back: 1, inactive: 2, range: 3, view: 4, readable: 5 })[result.reason];
        if (!count) continue;
        if (!best || count < best.count || (count === best.count && (priority < best.priority || (priority === best.priority && result.distance < best.distance)))) {
          best = { agentId: person.id, time: frame.time, point: { x: person.x, y: person.y }, sign,
            reason: result.reason, count, priority, distance: result.distance };
        }
      }
    }
  }
  return best;
}

export function createGuidance(level: Level, snapshot: Snapshot, baseline: Run, run: Run): Guidance | null {
  if (completed(evaluate(level, baseline, run))) return null;
  const evidence = diagnose(level, snapshot, baseline, run);
  const differentKnowledge = new Set(level.groups.map(g => [...g.known].sort().join())).size > 1;
  const coverage = level.groups.map(group => ({ group, count: run.agents.filter(a => a.cohort === group.id && a.learnedAt !== null).length }));
  const underserved = differentKnowledge && coverage.some(g => g.count > 0) ? coverage.find(g => g.count === 0)?.group : undefined;
  const person = frameAt(run, evidence.time).agents[evidence.agentId - 1];
  const guide: Guidance = { title: evidence.title, observation: evidence.detail, variable: 'position', signId: run.design.signs[0]?.id ?? 1,
    experiment: '先只移动一块导视牌，让它更接近上轮实际经过的人流；朝向和启用时段先保持不变。',
    check: '下一轮先比较获知人数，再看平均与最后一人的用时。', agentId: evidence.agentId, time: evidence.time,
    sourceDesign: structuredClone(run.design), map: { point: { x: person.x, y: person.y }, sign: run.design.signs[0]?.position ?? null, path: [], label: '上轮经过这里的人' } };
  if (!run.design.signs.length) {
    guide.variable = 'tools'; guide.experiment = '先补一块导视牌，再让它正面对着来人。其余工具先不要增加。';
  } else if (evidence.kind === 'protect') {
    const learned = run.events.find(e => e.agentId === evidence.agentId && e.type === 'learn');
    const responsible = run.design.signs.find(s => s.id === learned?.signId);
    if (responsible) {
      guide.signId = responsible.id; guide.map.sign = responsible.position;
      const canDelayStart = responsible.until - responsible.from > .1;
      guide.variable = canDelayStart ? 'from' : 'orientation';
      guide.experiment = canDelayStart
        ? '下一轮只延后启用时刻，让先经过的快行组离开标识正面后再显示。位置、朝向与关闭时刻保持不变，先观察是否减少快行组承担的代价。'
        : '下一轮只旋转这块牌，让正面减少覆盖快行组经过的区域。当前显示时段太短，先保持时段不变。';
      guide.observation += `他在 ${learned!.time.toFixed(1)} 秒读到了 ${responsible.target} 的信息。`;
    } else {
      guide.experiment = '下一轮只移动这块牌，先缩小快行组经过区域的覆盖。位置变化会同时影响多人，应重新检验两组结果。';
    }
    guide.check = '先看快行组平均用时是否回到保护上限内，再看慢行组最后一人；一项改善不能抵消另一项未达标。';
  } else if (evidence.kind === 'queue' && run.metrics.informed > 0 && !underserved) {
    const result = run.agents.find(a => a.id === evidence.agentId)!;
    const relevant = run.events.filter(e => e.type === 'learn' && e.learnedExit === result.exit);
    const learned = relevant.find(e => e.agentId === result.id) ?? relevant[0];
    const responsible = run.design.signs.find(s => s.id === learned?.signId);
    if (responsible) { guide.signId = responsible.id; guide.map.sign = responsible.position; }
    const count = run.agents.filter(a => a.exit === result.exit).length;
    guide.variable = 'orientation'; guide.map.exit = result.exit;
    guide.title = `问题在 ${result.exit} 门前，而不在道路长度`;
    const rerouted = run.agents.filter(a => a.exit === result.exit && a.initialExit !== result.exit && a.learnedAt !== null).length;
    guide.observation = `${count} 人选择 ${result.exit}，这里每 ${snapshot.scene.exits[result.exit].interval.toFixed(1)} 秒才放行一人。${rerouted ? `其中 ${rerouted} 人获得新信息后改来这里。` : '当前信息分配与出口负荷需要一起检查。'}`;
    guide.experiment = '下一轮只把这块牌旋转 90°，位置和时段保持不变。看看正面换了一侧后，最初被告知的是哪些人。';
    guide.check = '先看获知人数怎样变，再比较最后一人的用时；人数增加却更晚，说明告知范围还应收窄。';
    guide.map.label = `上轮 ${count} 人汇入 ${result.exit}`;
  } else {
    const opportunity = missedOpportunity(snapshot, run, underserved?.id ?? (evidence.kind === 'care' ? level.targets.cohort : undefined));
    if (opportunity) {
      const { reason, sign, agentId, time, point } = opportunity;
      guide.signId = sign.id; guide.agentId = agentId; guide.time = time;
      guide.map.point = point; guide.map.sign = sign.position;
      guide.observation = `上轮第 ${agentId} 号在 ${time.toFixed(1)} 秒经过这里，距牌 ${opportunity.distance.toFixed(1)} 米，却没有收到 ${sign.target} 的信息。`;
      guide.map.label = `上轮第 ${agentId} 号在这里错过信息`;
      if (reason === 'wall') {
        guide.title = '来人和标识，被这面墙隔开了';
        guide.map.wallId = designWalls(snapshot.scene, run.design).find(wall => !segmentClear(point, sign.position, [wall]))?.id;
        guide.experiment = '下一轮只改位置：把牌移到标出的墙与人流同一侧。先保持正面和时段不变，沿橙色的上轮路线找一个能直接看见牌的位置。';
      } else if (reason === 'back') {
        guide.title = '他们经过的是标识背面'; guide.variable = 'orientation';
        guide.experiment = '下一轮只旋转这块牌，让明亮的一侧朝向橙色路线上的来人。位置与启用时段先不要改。';
      } else if (reason === 'inactive') {
        const early = time < sign.from; guide.variable = early ? 'from' : 'until';
        guide.title = early ? '他经过时，标识还没有开启' : '他经过时，标识已经关闭';
        guide.experiment = early ? `下一轮只提前启用时刻，让标识在 ${time.toFixed(1)} 秒之前就显示。位置和朝向保持不变。`
          : `下一轮只延后关闭时刻，让显示覆盖他在 ${time.toFixed(1)} 秒经过的这段时间。位置和朝向保持不变。`;
      } else if (reason === 'view') {
        guide.title = '经过了标识，却没有朝它看';
        guide.experiment = '下一轮只改位置：沿橙色路线，把牌移到来人前方，而不是已经走过的身后。朝向与时段先保持不变。';
      } else {
        guide.title = '信息还没有靠近他们经过的地方';
        guide.experiment = '下一轮只改位置：把牌向橙色的实际人流路线靠近一点。先不要同时旋转或修改时段。';
      }
      guide.check = evidence.kind === 'care' ? '先看慢行组有没有真正读到信息，再看慢行组最后一人的用时。' : '先看获知人数是否增加；有人读到以后，再判断到达用时。';
      if (underserved) {
        guide.title = '信息还只抵达了一侧的人';
        guide.observation = `已有 ${run.metrics.informed} 人获得新信息，但${underserved.label}仍无人获得。` + guide.observation;
        guide.check = `先看${underserved.label}是否也获得了另一出口的信息，再比较整体平均与最后一人的用时。`;
      }
    } else if (!run.metrics.informed && run.design.signs.every(s => snapshot.agents.every(a => s.target === 'A' ? a.knowsA : a.knowsB))) {
      guide.variable = 'target'; guide.title = '牌上仍是他们已经知道的出口';
      guide.experiment = '下一轮只把导视信息改成另一出口。位置、朝向和时段保持不变，再看是否出现新的选择。';
    }
  }
  if (run.metrics.unfinished) guide.observation = `截止 ${run.duration.toFixed(1)} 秒仍有 ${run.metrics.unfinished} 人未通过。` + guide.observation;
  guide.map.path = run.frames.filter((f, i) => i % 3 === 0 && f.time <= guide.time + 2).map(f => {
    const a = f.agents[guide.agentId - 1]; return { x: a.x, y: a.y };
  });
  return guide;
}
