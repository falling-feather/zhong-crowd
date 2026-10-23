import { add, clamp, distance, findPath, length, pathLength, scale, segmentClear, sub, unit, canReadSign } from './geometry';
import { BOUNDS, CLEARANCE, designWalls, MAX_TIME, MODEL, STEP, validatePhysicalDesign } from './scene';
import { buildObstacles, solveVelocities, type MovingDisc } from './avoidance';
import { projectMotion } from './motion';
import type { AgentFrame, AgentResult, AgentSeed, DecisionEvent, Design, ExitId, Frame, Metrics, Run, Scene, Snapshot, Vec } from './types';

interface Agent extends AgentSeed {
  velocity: Vec;
  exit: ExitId;
  initialExit: ExitId;
  path: Vec[];
  arrivalTime: number | null;
  traveled: number;
  stopped: number;
  stopStreak: number;
  learnedAt: number | null;
  queueStart: number | null;
  queueExit: ExitId | null;
  gateWait: number;
  blockingStreak: number;
  sense: Vec;
}
export const roundTime = (n: number) => Math.round(n * 10) / 10;
const hasKnowledge = (a: AgentSeed, exit: ExitId) => exit === 'A' ? a.knowsA : a.knowsB;

function exitGoal(scene: Scene, id: ExitId, agent: AgentSeed): Vec {
  const exit = scene.exits[id];
  const lane = (agent.id * 0.61803398875) % 1 - 0.5;
  return { x: exit.x + lane * (exit.width - 2 * (agent.radius + CLEARANCE) - 0.1), y: exit.y };
}
function route(scene: Scene, agent: AgentSeed, exit: ExitId): Vec[] {
  return findPath(agent.position, exitGoal(scene, exit, agent), scene.walls, agent.radius + CLEARANCE, BOUNDS);
}
function preference(agent: Agent, scene: Scene): Vec {
  if (agent.queueExit) return { x: 0, y: 0 };
  // Retain each corner until the entire following segment has sufficient clearance.
  for (let i = agent.path.length - 1; i > 0; i--) if (segmentClear(agent.position, agent.path[i], scene.walls, agent.radius + CLEARANCE)) {
    agent.path.splice(0, i); break;
  }
  const delta = sub(agent.path[0], agent.position);
  const direction = unit(delta);
  const speed = Math.min(agent.speed, length(delta) / STEP);
  // Consistent passing-side preference removes exact antipodal symmetry; no random frame-time force.
  const bias = Math.min(0.012, speed * 0.01);
  const preferred = { x: direction.x * speed - direction.y * bias, y: direction.y * speed + direction.x * bias };
  return length(preferred) > agent.speed ? scale(unit(preferred), agent.speed) : preferred;
}
function inPortal(a: Agent, scene: Scene): boolean {
  const exit = scene.exits[a.exit];
  // The doorway admits the physical body. ORCA's extra comfort clearance is not
  // another gate edge: retaining it here stranded otherwise fitting bodies at the bounds.
  return a.position.y <= exit.y + 0.24 && Math.abs(a.position.x - exit.x) <= exit.width / 2 - a.radius + 1e-7;
}
export function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function simulate(snapshot: Snapshot, design: Design, progress?: (ratio: number) => void): Run {
  validatePhysicalDesign(snapshot, design);
  const scene = { ...snapshot.scene, walls: designWalls(snapshot.scene, design) };
  const obstacles = buildObstacles(scene.walls);
  const events: DecisionEvent[] = [];
  const agents: Agent[] = snapshot.agents.map(initial => {
    if (!initial.knowsA && !initial.knowsB) throw new Error('每名观众需要至少知道一个初始出口');
    const pathA = initial.knowsA ? route(scene, initial, 'A') : null;
    const pathB = initial.knowsB ? route(scene, initial, 'B') : null;
    const costA = pathA ? pathLength(initial.position, pathA) : Infinity;
    const costB = pathB ? pathLength(initial.position, pathB) : Infinity;
    const exit: ExitId = costB + 0.1 < costA ? 'B' : 'A';
    events.push({ agentId: initial.id, tick: 0, time: 0, type: 'choose', source: 'initial', position: { ...initial.position }, exit,
      costA: Number.isFinite(costA) ? costA : undefined, costB: Number.isFinite(costB) ? costB : undefined });
    return { ...initial, position: { ...initial.position }, velocity: { x: 0, y: 0 }, exit, initialExit: exit,
      path: exit === 'B' ? pathB! : pathA!, arrivalTime: null, traveled: 0, stopped: 0, stopStreak: 0,
      learnedAt: null, queueStart: null, queueExit: null, gateWait: 0, blockingStreak: 0, sense: { x: 0, y: -1 } };
  });
  const frames: Frame[] = [];
  const capture = (time: number) => frames.push({ time, agents: agents.map((a): AgentFrame => ({
    id: a.id, x: a.position.x, y: a.position.y, vx: a.velocity.x, vy: a.velocity.y,
    exit: a.exit, knowsA: a.knowsA, knowsB: a.knowsB, arrived: a.arrivalTime !== null, queued: a.queueExit !== null, hx: a.sense.x, hy: a.sense.y,
  })) });
  const signs = [...design.signs].sort((a, b) => a.id - b.id);
  const nextService: Record<ExitId, number> = { A: 0, B: 0 };
  let elapsed = 0;
  for (let tick = 0; tick < MAX_TIME / STEP; tick++) {
    const time = roundTime(tick * STEP);
    const nextTime = roundTime((tick + 1) * STEP);
    elapsed = nextTime;
    const discs: MovingDisc[] = [];
    for (const agent of agents) {
      if (agent.arrivalTime !== null) continue;
      if (agent.queueExit && !inPortal(agent, scene)) {
        agent.gateWait += time - agent.queueStart!;
        agent.queueStart = null; agent.queueExit = null;
      }
      const heading = agent.queueExit ? unit(sub(scene.exits[agent.exit], agent.position)) : preference(agent, scene);
      agent.sense = unit(heading);
      const learned: { signId: number; exit: ExitId; distance: number }[] = [];
      for (const sign of signs) {
        if (hasKnowledge(agent, sign.target) || !canReadSign(agent.position, heading, sign, scene.walls, time)) continue;
        if (sign.target === 'A') agent.knowsA = true; else agent.knowsB = true;
        agent.learnedAt ??= time;
        learned.push({ signId: sign.id, exit: sign.target, distance: distance(agent.position, sign.position) });
      }
      if (learned.length) {
        const pathA = agent.knowsA ? route(scene, agent, 'A') : null;
        const pathB = agent.knowsB ? route(scene, agent, 'B') : null;
        const costA = pathA ? pathLength(agent.position, pathA) : Infinity;
        const costB = pathB ? pathLength(agent.position, pathB) : Infinity;
        for (const learning of learned) events.push({ agentId: agent.id, tick, time, type: 'learn', position: { ...agent.position }, exit: agent.exit,
          learnedExit: learning.exit, signId: learning.signId, distanceToSign: learning.distance,
          costA: Number.isFinite(costA) ? costA : undefined, costB: Number.isFinite(costB) ? costB : undefined });
        const chosen: ExitId = costB + 0.1 < costA ? 'B' : 'A';
        if (chosen !== agent.exit) {
          if (agent.queueStart !== null) agent.gateWait += time - agent.queueStart;
          agent.queueExit = null; agent.queueStart = null;
          agent.exit = chosen; agent.path = chosen === 'A' ? pathA! : pathB!;
          events.push({ agentId: agent.id, tick, time, type: 'choose', source: 'sign', position: { ...agent.position }, exit: chosen, costA, costB });
        }
      }
      discs.push({ id: agent.id, position: agent.position, velocity: agent.velocity, radius: agent.radius + CLEARANCE,
        speed: agent.speed, preferred: preference(agent, scene) });
    }
    capture(time);
    const proposed = solveVelocities(discs, obstacles, STEP, BOUNDS);
    const motion = projectMotion(agents.filter(a => a.arrivalTime === null), proposed, scene.walls, STEP, BOUNDS);
    for (const agent of agents) {
      if (agent.arrivalTime !== null) continue;
      const movement = motion.get(agent.id)!;
      const end = add(agent.position, scale(movement.velocity, STEP));
      const traveled = distance(agent.position, end);
      agent.velocity = movement.velocity;
      agent.position = end;
      agent.traveled += traveled;
      if (traveled / STEP < agent.speed * 0.1) {
        agent.stopStreak++;
        if (agent.stopStreak === 10) agent.stopped += 1;
        else if (agent.stopStreak > 10) agent.stopped += STEP;
      } else agent.stopStreak = 0;
      if (traveled / STEP < agent.speed * 0.3 && movement.constrainedBy.length && !agent.queueExit) {
        agent.blockingStreak++;
        if (agent.blockingStreak === 10) events.push({ agentId: agent.id, tick: tick + 1, time: nextTime,
          type: 'blocked', position: { ...agent.position }, exit: agent.exit, peers: movement.constrainedBy.slice(0, 4) });
      } else agent.blockingStreak = 0;
    }
    for (const exit of ['A', 'B'] as const) {
      const waiting = agents.filter(a => a.arrivalTime === null && a.exit === exit && inPortal(a, scene))
        .sort((a, b) => (a.queueStart ?? nextTime) - (b.queueStart ?? nextTime) || a.id - b.id);
      for (const agent of waiting) {
        if (nextTime + 1e-7 >= nextService[exit]) {
          if (agent.queueStart !== null) agent.gateWait += nextTime - agent.queueStart;
          agent.arrivalTime = nextTime; agent.queueStart = null; agent.queueExit = null; agent.velocity = { x: 0, y: 0 };
          events.push({ agentId: agent.id, tick: tick + 1, time: nextTime, type: 'arrive', position: { ...agent.position }, exit });
          nextService[exit] = roundTime(nextTime + scene.exits[exit].interval);
        } else if (agent.queueStart === null) {
          agent.queueStart = nextTime; agent.queueExit = exit;
          events.push({ agentId: agent.id, tick: tick + 1, time: nextTime, type: 'queue', position: { ...agent.position }, exit });
        }
      }
    }
    if (tick % 30 === 0) progress?.(tick * STEP / MAX_TIME);
    if (agents.every(a => a.arrivalTime !== null)) break;
  }
  capture(elapsed);
  progress?.(1);
  const results: AgentResult[] = agents.map(a => ({
    id: a.id, cohort: a.cohort, exit: a.exit, initialExit: a.initialExit, arrivalTime: a.arrivalTime,
    distance: a.traveled, stopped: roundTime(a.stopped), delay: Math.max(0, (a.arrivalTime ?? elapsed) - a.traveled / a.speed),
    gateWait: roundTime(a.gateWait + (a.queueStart === null ? 0 : elapsed - a.queueStart)), learnedAt: a.learnedAt,
  }));
  const completed = results.filter(a => a.arrivalTime !== null);
  const cohorts: Metrics['cohorts'] = {};
  for (const cohort of new Set(results.map(a => a.cohort))) {
    const members = results.filter(a => a.cohort === cohort);
    const finished = members.filter(a => a.arrivalTime !== null);
    cohorts[cohort] = { count: members.length, completed: finished.length,
      mean: finished.length ? finished.reduce((sum, a) => sum + a.arrivalTime!, 0) / finished.length : null,
      tail: finished.length ? Math.max(...finished.map(a => a.arrivalTime!)) : null,
      delay: members.reduce((sum, a) => sum + a.delay, 0) / members.length };
  }
  const metrics: Metrics = {
    completed: completed.length, unfinished: results.length - completed.length,
    exits: { A: completed.filter(a => a.exit === 'A').length, B: completed.filter(a => a.exit === 'B').length },
    informed: results.filter(a => a.learnedAt !== null).length,
    rerouted: new Set(events.filter(e => e.type === 'choose' && e.source === 'sign').map(e => e.agentId)).size,
    meanArrival: completed.length ? completed.reduce((sum, a) => sum + a.arrivalTime!, 0) / completed.length : null,
    meanStopped: results.reduce((sum, a) => sum + a.stopped, 0) / results.length,
    meanDelay: results.reduce((sum, a) => sum + a.delay, 0) / results.length,
    lastArrival: completed.length ? Math.max(...completed.map(a => a.arrivalTime!)) : null, cohorts,
  };
  return { model: MODEL, design: structuredClone(design), duration: elapsed, frames, events, agents: results, metrics,
    fingerprint: hashText(JSON.stringify({ frames, events, results })) };
}

export function frameAt(run: Run, time: number): Frame {
  return run.frames[clamp(Math.floor((time + 1e-7) / STEP), 0, run.frames.length - 1)];
}
