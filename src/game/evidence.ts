import { readability } from '../core/geometry';
import { designWalls } from '../core/scene';
import { frameAt } from '../core/simulation';
import type { AgentResult, Run, Snapshot } from '../core/types';
import type { Level } from './content';
import { completed, evaluate } from './evaluation';

export interface Evidence { kind: 'success' | 'information' | 'queue' | 'care' | 'protect' | 'interaction'; title: string; detail: string; agentId: number; time: number; action: string }
const n = (value: number) => value.toFixed(1);

export function observationAt(snapshot: Snapshot, run: Run, agentId: number, time: number) {
  const frame = frameAt(run, time);
  const person = frame.agents.find(a => a.id === agentId);
  if (!person || person.arrived) return [];
  const walls = designWalls(snapshot.scene, run.design);
  return run.design.signs.map(sign => ({ signId: sign.id, target: sign.target,
    known: sign.target === 'A' ? person.knowsA : person.knowsB,
    ...readability(person, { x: person.hx, y: person.hy }, sign, walls, frame.time) }));
}

export function observationCopy(observations: ReturnType<typeof observationAt>): string {
  const reasons = { inactive: '此刻未启用', range: '尚在可读距离之外', back: '经过了标识背面', view: '标识不在他的视域内', wall: '视线被墙体挡住', readable: '此刻可读条件成立' };
  return observations.map(o => `导视牌 ${o.signId} · 距离 ${n(o.distance)} 米：${reasons[o.reason]}。${o.known ? `他已经知道出口 ${o.target}。` : `他还不知道出口 ${o.target}。`}`).join(' ');
}

export function closestObservation(snapshot: Snapshot, run: Run, agentId: number) {
  const walls = designWalls(snapshot.scene, run.design);
  let best: { time: number; sign: number; reason: ReturnType<typeof readability>['reason']; distance: number } | null = null;
  for (let tick = 0; tick < run.frames.length; tick += 2) {
    const frame = run.frames[tick];
    const agent = frame.agents.find(a => a.id === agentId);
    if (!agent || agent.arrived) continue;
    for (const sign of run.design.signs) {
      const result = readability(agent, { x: agent.hx, y: agent.hy }, sign, walls, frame.time);
      if (!best || result.distance < best.distance) best = { time: frame.time, sign: sign.id, ...result };
    }
  }
  return best;
}

export function diagnose(level: Level, snapshot: Snapshot, baseline: Run, run: Run): Evidence {
  const goals = evaluate(level, baseline, run);
  const finished = completed(goals);
  const original = new Map(baseline.agents.map(a => [a.id, a]));
  const improvement = (a: AgentResult) => (original.get(a.id)!.arrivalTime ?? baseline.duration) - (a.arrivalTime ?? run.duration);
  const changed = run.agents.filter(a => a.initialExit !== a.exit).sort((a, b) => improvement(b) - improvement(a));
  if (finished) {
    const person = changed[0] ?? [...run.agents].sort((a, b) => improvement(b) - improvement(a))[0];
    const learned = run.events.find(e => e.agentId === person.id && e.type === 'learn');
    return { kind: 'success', title: person.initialExit!==person.exit ? `第 ${person.id} 号，从 ${person.initialExit} 改去 ${person.exit}` : `第 ${person.id} 号的实际经历`,
      detail: `第 ${person.id} 号比原始布局${improvement(person) >= 0 ? '早' : '晚'} ${n(Math.abs(improvement(person)))} 秒离开。检查他的经历，再换一批人复核，看看这份方案是否依赖某个初态。`,
      agentId: person.id, time: learned?.time ?? Math.min(10, run.duration), action: '回看改变发生时' };
  }
  if (run.metrics.unfinished) {
    const person = run.agents.filter(a => a.arrivalTime === null).sort((a, b) => b.delay - a.delay)[0];
    const state = run.frames.at(-1)!.agents.find(a => a.id === person.id)!;
    const event = run.events.find(e => e.agentId === person.id && e.type === (state.queued ? 'queue' : 'blocked'));
    return { kind: state.queued ? 'queue' : 'interaction', title: `本轮仍有 ${run.metrics.unfinished} 人未通过`,
      detail: `截止 ${n(run.duration)} 秒，第 ${person.id} 号仍未通过出口 ${person.exit}。当前受限 ${n(person.delay)} 秒，含门槛等待 ${n(person.gateWait)} 秒。先检查留下的人；仅已离开者的低均值不能代替全员完成。`,
      agentId: person.id, time: event?.time ?? Math.max(0, run.duration - 1), action: '先看仍未通过的人' };
  }
  const protect = goals.find(g => g.id === 'protect' && !g.met);
  if (protect) {
    const person = run.agents.filter(a => a.cohort === level.targets.protectCohort).sort((a, b) => improvement(a) - improvement(b))[0];
    const event = run.events.find(e => e.agentId === person.id && e.type === 'learn')
      ?? run.events.find(e => e.agentId === person.id && e.type === 'blocked');
    return { kind: 'protect', title: '这份改善，让快行组承担了过多代价',
      detail: `快行组平均 ${n(protect.actual)} 秒，超过保护上限 ${n(protect.target)} 秒。第 ${person.id} 号比原始布局多用 ${n(-improvement(person))} 秒。检查告知对象和时段，同时保留慢行组的尾部目标。`,
      agentId: person.id, time: event?.time ?? 0, action: '追看承担代价的人' };
  }
  const care = goals.find(g => g.id === 'care' && !g.met);
  if (care) {
    const person = [...run.agents].filter(a => a.cohort === level.targets.cohort).sort((a, b) => (b.arrivalTime ?? run.duration) - (a.arrivalTime ?? run.duration))[0];
    const event = run.events.find(e => e.agentId === person.id && (e.type === 'queue' || e.type === 'blocked'))
      ?? run.events.find(e => e.agentId === person.id && e.type === 'learn');
    return { kind: 'care', title: '平均数之外，他还在等待',
      detail: `第 ${person.id} 号来自慢行组，${person.arrivalTime === null ? '尚未离开' : `${n(person.arrivalTime)} 秒才离开`}。${person.learnedAt === null ? '他没有收到另一出口的信息。' : `他在 ${n(person.learnedAt)} 秒收到信息，但到达仍未达到本关目标。`}先检查这名观众，再调整覆盖对象。`,
      agentId: person.id, time: event?.time ?? Math.min(run.duration, 10), action: '看看最后的人经历了什么' };
  }
  const queued = [...run.agents].sort((a, b) => b.gateWait - a.gateWait)[0];
  if (queued.gateWait >= 1) {
    const person = run.agents.filter(a => a.exit === queued.exit).sort((a, b) => b.delay - a.delay)[0];
    const event = run.events.find(e => e.agentId === person.id && e.type === 'blocked')
      ?? run.events.find(e => e.agentId === person.id && e.type === 'queue');
    const count = run.agents.filter(a => a.exit === person.exit).length;
    const interval = snapshot.scene.exits[person.exit].interval;
    return { kind: 'queue', title: '信息抵达了，通路却承受不了',
      detail: `出口 ${person.exit} 每 ${n(interval)} 秒放行一人，本轮却有 ${count} 人选择它。第 ${person.id} 号的受限耗时为 ${n(person.delay)} 秒，其中门槛等待 ${n(person.gateWait)} 秒。改变告知对象或启用时段，让两条路分担通行。`,
      agentId: person.id, time: event?.time ?? Math.min(10, run.duration), action: '回到拥挤形成的那一刻' };
  }
  if (!run.metrics.informed && run.design.signs.length) {
    const people = snapshot.agents.map(a => ({ id: a.id, observation: closestObservation(snapshot, run, a.id) })).filter(p => p.observation !== null)
      .sort((a, b) => a.observation!.distance - b.observation!.distance);
    const selected = people[0];
    const reasons = { inactive: '标识当时未启用', range: '尚未进入可读距离', back: '经过的是标识背面', view: '标识不在他的视域内', wall: '视线被墙体挡住', readable: '该出口当时已在他的知识中' };
    return { kind: 'information', title: '标识存在，信息没有进入选择',
      detail: selected ? `第 ${selected.id} 号最近经过标识时，${reasons[selected.observation!.reason]}。可读范围只说明一部分条件；朝向、时段与个体视野也很重要。` : '先放置一块导视牌，再观察观众经过的位置。',
      agentId: selected?.id ?? snapshot.agents[0].id, time: selected?.observation?.time ?? 0, action: '查看一次错过的信息' };
  }
  const person = [...run.agents].sort((a, b) => b.delay - a.delay)[0];
  const event = run.events.find(e => e.agentId === person.id && e.type === 'blocked');
  return { kind: 'interaction', title: '再看一看彼此影响的地方',
    detail: `第 ${person.id} 号的受限耗时为 ${n(person.delay)} 秒。对照他的原始路线、获得的信息和相遇记录，找出下一次应改变的位置。`,
    agentId: person.id, time: event?.time ?? person.learnedAt ?? Math.min(10, run.duration), action: '追看这个人的路线' };
}

export function actualKnowledge(run: Run, id: number, time: number): string {
  const person = frameAt(run, time).agents.find(a => a.id === id);
  return person ? [person.knowsA ? 'A' : '', person.knowsB ? 'B' : ''].filter(Boolean).join(' + ') : '—';
}
