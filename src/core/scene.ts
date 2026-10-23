import { distance, findPath, isWalkable } from './geometry';
import type { Barrier, Design, ExitId, Scenario, Scene, Sign, Snapshot, SpawnGroup, Vec } from './types';

export const MODEL = 'zhong-orca-contact-2';
export const STEP = 0.1;
export const MAX_TIME = 100;
export const DEFAULT_SEED = 4261;
export const RADIUS = 0.23;
export const CLEARANCE = 0.02;
export const BARRIER_LENGTH = 2.8;
export const BARRIER_WIDTH = 0.26;
export const BOUNDS = { minX: 0.7, maxX: 27.3, minY: 0.7, maxY: 17.3 };
export const SIGN_POSITIONS = { hidden: { x: 7.2, y: 5.2 }, early: { x: 11.9, y: 8.8 }, late: { x: 14.1, y: 4.9 } } as const;

export function makeScene(id: string, widths: [number, number] = [1.4, 2.6], intervals: [number, number] = [0, 0], inner?: RectInput[]): Scene {
  const exits = {
    A: { x: 25, y: 0.72, width: widths[0], interval: intervals[0], label: '东侧出口' },
    B: { x: 3, y: 0.72, width: widths[1], interval: intervals[1], label: '西侧出口' },
  };
  const { A, B } = exits;
  return {
    id, width: 28, height: 18, exits,
    walls: [
      { id: 'north-west', x: -1, y: -1, w: B.x - B.width / 2 + 1, h: 1.45 },
      { id: 'north-middle', x: B.x + B.width / 2, y: -1, w: A.x - A.width / 2 - B.x - B.width / 2, h: 1.45 },
      { id: 'north-east', x: A.x + A.width / 2, y: -1, w: 29 - A.x - A.width / 2, h: 1.45 },
      { id: 'west', x: -1, y: -1, w: 1.45, h: 20 },
      { id: 'east', x: 27.55, y: -1, w: 1.45, h: 20 },
      { id: 'south', x: -1, y: 17.55, w: 30, h: 1.45 },
      ...(inner ?? [
        { id: 'exhibit', x: 3.8, y: 6.3, w: 6.8, h: 0.8 },
        { id: 'divider', x: 15, y: 3.4, w: 0.6, h: 11.8 },
      ]),
    ],
  };
}
type RectInput = Scene['walls'][number];
export const SCENE = makeScene('hidden-exit-2');
export const DEFAULT_GROUPS: SpawnGroup[] = [{
  id: 'main', label: '展厅观众', color: '#62b7a0', origin: { x: 4, y: 10 }, columns: 8, rows: 4,
  gap: { x: 0.9, y: 1.3 }, speed: [1.05, 1.27], known: ['A'],
}];
export const BASE_SCENARIO: Scenario = { scene: SCENE, groups: DEFAULT_GROUPS };

export function makeSign(position: Vec, options: Partial<Omit<Sign, 'position'>> = {}): Sign {
  return { id: 1, position: { ...position }, normal: { x: 0, y: 1 }, range: 6.5,
    target: 'B', from: 0, until: MAX_TIME, ...options };
}
export const makeDesign = (signs: Sign[] = [makeSign(SIGN_POSITIONS.hidden)], barrier: Barrier | null = null): Design => ({ signs: structuredClone(signs), barrier: barrier ? structuredClone(barrier) : null });

export function barrierRect(barrier: Barrier): Scene['walls'][number] {
  const w = barrier.vertical ? BARRIER_WIDTH : BARRIER_LENGTH;
  const h = barrier.vertical ? BARRIER_LENGTH : BARRIER_WIDTH;
  return { id: 'player-barrier', x: barrier.position.x - w / 2, y: barrier.position.y - h / 2, w, h };
}
export function designWalls(scene: Scene, design: Design) { return design.barrier ? [...scene.walls, barrierRect(design.barrier)] : scene.walls; }
export function validSignPosition(position: Vec, scene: Scene = SCENE): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y)
    && position.x >= 1.2 && position.x <= 26.8 && position.y >= 1.8 && position.y <= 16.7
    && isWalkable(position, scene.walls, 0.4);
}

export function createSnapshot(seed = DEFAULT_SEED, scenario: Scenario = BASE_SCENARIO): Snapshot {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('初态编号须为非负的 32 位整数');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const agents: Snapshot['agents'] = [];
  for (const group of scenario.groups) {
    for (let i = 0; i < group.columns * group.rows; i++) agents.push({
      id: agents.length + 1, cohort: group.id,
      position: { x: group.origin.x + (i % group.columns) * group.gap.x + (random() - 0.5) * 0.06,
        y: group.origin.y + Math.floor(i / group.columns) * group.gap.y + (random() - 0.5) * 0.06 },
      speed: group.speed[0] + random() * (group.speed[1] - group.speed[0]), radius: RADIUS,
      knowsA: group.known.includes('A'), knowsB: group.known.includes('B'),
    });
  }
  return { seed, scene: structuredClone(scenario.scene), agents };
}

export function validatePhysicalDesign(snapshot: Snapshot, design: Design, checkPaths = true): void {
  if (design.signs.length > 2 || new Set(design.signs.map(s => s.id)).size !== design.signs.length) throw new Error('标识编号重复或数量超出范围');
  for (const sign of design.signs) {
    if (!validSignPosition(sign.position, { ...snapshot.scene, walls: designWalls(snapshot.scene, design) }) || !Number.isInteger(sign.id) || sign.id < 1 || sign.id > 2) throw new Error('标识需要放在展厅内，且与墙体、导流栏保持距离');
    if (!['A', 'B'].includes(sign.target) || ![0, 1, -1].includes(sign.normal.x) || ![0, 1, -1].includes(sign.normal.y)
      || Math.abs(sign.normal.x) + Math.abs(sign.normal.y) !== 1) throw new Error('标识的方向或目标无效');
    if (sign.range !== 6.5 || !Number.isFinite(sign.from) || !Number.isFinite(sign.until) || sign.from < 0 || sign.until > MAX_TIME || sign.from >= sign.until) throw new Error('启用区间需要处于推演时段内，且结束晚于开始');
  }
  const walls = designWalls(snapshot.scene, design);
  if (design.barrier) {
    if (!Number.isFinite(design.barrier.position.x) || !Number.isFinite(design.barrier.position.y) || typeof design.barrier.vertical !== 'boolean') throw new Error('导流栏参数无效');
    const rect = barrierRect(design.barrier);
    if (rect.x < 0.9 || rect.y < 1.3 || rect.x + rect.w > 27.1 || rect.y + rect.h > 17.1) throw new Error('导流栏需要完整位于展厅内部');
    if (snapshot.scene.walls.some(w => rect.x - 0.15 < w.x + w.w && rect.x + rect.w + 0.15 > w.x
      && rect.y - 0.15 < w.y + w.h && rect.y + rect.h + 0.15 > w.y)) throw new Error('导流栏与墙体过近，请留出间隙');
  }
  for (let i = 0; i < snapshot.agents.length; i++) {
    const a = snapshot.agents[i];
    if (!isWalkable(a.position, walls, a.radius + CLEARANCE)) throw new Error('工具占用了观众的出发位置');
    for (let j = i + 1; j < snapshot.agents.length; j++) if (distance(a.position, snapshot.agents[j].position) < a.radius + snapshot.agents[j].radius) throw new Error('人群初态发生重叠');
    const known: ExitId = a.knowsA ? 'A' : 'B';
    if (checkPaths) findPath(a.position, snapshot.scene.exits[known], walls, a.radius + CLEARANCE, BOUNDS);
  }
}
