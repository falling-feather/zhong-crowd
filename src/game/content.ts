import { createSnapshot, DEFAULT_GROUPS, makeDesign, makeScene, makeSign, SCENE } from '../core/scene';
import type { Design, Scenario, SpawnGroup } from '../core/types';
import { hashText } from '../core/simulation';

export interface Level extends Scenario {
  id: string;
  number: string;
  title: string;
  subtitle: string;
  question: string;
  briefing: string;
  insight: string;
  transfer: { question: string; check: string };
  tools: number;
  maxSigns: number;
  allowBarrier: boolean;
  baseline: Design;
  seed: number;
  targets: { mean: number; tail: number; informed?: number; cohort?: string; cohortTail?: number; protectCohort?: string; protectMean?: number; delay?: number };
}

const group = (overrides: Partial<SpawnGroup> = {}): SpawnGroup => ({ ...structuredClone(DEFAULT_GROUPS[0]), ...overrides });
export const LEVELS: Level[] = [
  {
    id: 'sight', number: '01', title: '看见', subtitle: '信息的盲区',
    question: '一条存在的路，怎样进入人的选择？',
    briefing: '散场了。所有人只记得来时的 A，去往 B 的标识藏在展墙后。你有一块导视牌，试着让另一条路被看见。',
    insight: '道路存在，信息却不一定抵达。决定效果的是谁在什么时候看见它。',
    transfer: { question: '路在地图上存在，就会进入每个人的选择吗？', check: '先追到一次实际读取，再检查这个人是否改变出口。覆盖区域不是读取事件。' },
    scene: SCENE, groups: DEFAULT_GROUPS, tools: 1, maxSigns: 1, allowBarrier: false,
    baseline: makeDesign(), seed: 4261,
    targets: { mean: 0.88, tail: 1.03, informed: 16 },
  },
  {
    id: 'balance', number: '02', title: '分流', subtitle: '更近，也可能更慢',
    question: '当每个人都找到近路，会发生什么？',
    briefing: 'B 更近，但一次只能放行一人；A 较远，却通行得更快。把所有人都引向 B，可能只是把队伍搬了过去。位置、朝向与启用时段，决定谁先获得信息。',
    insight: '更多人知道近路，不等于所有人更快。有效的信息也需要合适的分配。',
    transfer: { question: '上一课让更多人看到B，这一课还能直接照搬吗？', check: 'B每1.8秒放行一人，A每0.3秒放行一人。对比告知人数和最后一人，检验近路的承载代价。' },
    scene: makeScene('balance', [2.8, 0.95], [0.3, 1.8]),
    groups: [group({ origin: { x: 4.2, y: 9.2 }, columns: 6, rows: 7, gap: { x: 1.02, y: 1.05 } })],
    tools: 1, maxSigns: 1, allowBarrier: false,
    baseline: makeDesign(), seed: 2057,
    targets: { mean: 0.92, tail: 1.02 },
  },
  {
    id: 'care', number: '03', title: '照顾', subtitle: '平均值之外的人',
    question: '多数人更快了，谁仍然留在最后？',
    briefing: '同一场散场里，有走得较快的一组，也有步速较慢的一组。平均时间下降还不够：试着让慢行组真正受益，同时不把代价全部交给别人。',
    insight: '一个好看的平均数，可能遮住一群人的等待。公平需要看见具体的人。',
    transfer: { question: '上一课的平均与尾部改善，是否也照顾到了慢行组？', check: '分别检查慢行组最后一人和快行组平均。可以接受少量整体效率损失，但不能隐藏承担代价的人。' },
    scene: makeScene('care', [2.6, 1.5], [0.3, 0.7]),
    groups: [
      group({ id: 'fast', label: '快行组', color: '#68b9a4', origin: { x: 7.8, y: 8.4 }, columns: 6, rows: 4, gap: { x: 0.9, y: 0.85 }, speed: [1.25, 1.4] }),
      group({ id: 'slow', label: '慢行组', color: '#e0ac72', origin: { x: 4.2, y: 13.4 }, columns: 4, rows: 3, gap: { x: 0.95, y: 1.0 }, speed: [0.76, 0.84] }),
    ],
    tools: 1, maxSigns: 1, allowBarrier: false,
    baseline: makeDesign(), seed: 3037,
    targets: { mean: 1, tail: 0.9, cohort: 'slow', cohortTail: 0.82, protectCohort: 'fast', protectMean: 1.08 },
  },
  {
    id: 'together', number: '04', title: '共处', subtitle: '没有唯一的最短路',
    question: '两股人流，如何共享同一个空间？',
    briefing: '西厅的人知道东侧 A，东厅的人知道西侧 B。两股人流会在中间交汇。你有两份干预预算：可放导视牌，也可用一段导流栏改变通路。把信息、时机与空间组织成一个方案。',
    insight: '设计环境，改变选择；理解相互影响，才能让不同的人共同通过。',
    transfer: { question: '只照顾一侧的有效标识，能让两股相向人流共同受益吗？', check: '分别检查西厅与东厅获得的信息，再看整体平均、最后一人和受限耗时。单侧改善只是起点。' },
    scene: makeScene('together', [1.7, 1.7], [0.5, 0.5], [
      { id: 'exhibit-west', x: 3.5, y: 6.3, w: 6.5, h: 0.8 },
      { id: 'exhibit-east', x: 18, y: 6.3, w: 6.5, h: 0.8 },
      { id: 'divider', x: 13.7, y: 4.1, w: 0.6, h: 10.7 },
    ]),
    groups: [
      group({ id: 'west', label: '西厅组', color: '#68b9a4', origin: { x: 4.2, y: 9 }, columns: 4, rows: 6, gap: { x: 0.95, y: 1.05 }, known: ['A'] }),
      group({ id: 'east', label: '东厅组', color: '#b8a3dc', origin: { x: 20.9, y: 9 }, columns: 4, rows: 6, gap: { x: 0.95, y: 1.05 }, known: ['B'] }),
    ],
    tools: 2, maxSigns: 2, allowBarrier: true,
    baseline: makeDesign([makeSign({ x: 6.7, y: 5.2 }), makeSign({ x: 21.3, y: 5.2 }, { id: 2, target: 'A' })]),
    seed: 4099,
    targets: { mean: 0.5, tail: 0.85, delay: 0.6 },
  },
];

export const levelById = (id: string) => LEVELS.find(level => level.id === id);
export const levelSnapshot = (level: Level, seed = level.seed) => createSnapshot(seed, level);

/** Scope only fields that change the simulation, budget or goals; wording and colors do not invalidate achievements. */
export const levelRuleId = (level: Level): string => hashText(JSON.stringify({ scene: level.scene,
  groups: level.groups.map(({ id, origin, columns, rows, gap, speed, known }) => ({ id, origin, columns, rows, gap, speed, known })),
  tools: level.tools, maxSigns: level.maxSigns, allowBarrier: level.allowBarrier, baseline: level.baseline, targets: level.targets }));
