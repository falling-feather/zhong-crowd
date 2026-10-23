import { describe, expect, it } from 'vitest';
import { canReadSign, findPath, isWalkable, segmentClear, distance } from '../src/core/geometry';
import { createSnapshot, makeDesign, makeSign, SIGN_POSITIONS, STEP, MODEL } from '../src/core/scene';
import { simulate, frameAt } from '../src/core/simulation';
import { newProgress, decodeProgress, encodeProgress, decodeImport, copyLegacy, encodeDesign, encodeCampaign, buildReport, appendAttempt, migratePreviousProgress, readProgress, writeProgress, STORAGE_KEY, CHECKPOINT_KEY } from '../src/game/storage';
import { LEVELS, levelSnapshot, levelRuleId } from '../src/game/content';
import { completed, evaluate } from '../src/game/evaluation';
import legacyExample from './fixtures/示例实验.json';

const withSign = (sign = makeSign(SIGN_POSITIONS.early)) => makeDesign([sign]);
describe('规则更新的设计与成绩分离', () => {
  it('本机原记录无法读取时，后续试玩与自动保存不能覆盖原件', () => {
    const data = new Map([[STORAGE_KEY, '{damaged']]);
    const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const loaded = readProgress(() => store);
    expect(loaded.blocked).toBe(true);
    loaded.progress.chapters.sight.draft = withSign();
    expect(() => writeProgress(() => store, loaded.progress, { blocked: loaded.blocked })).toThrow();
    expect(data.get(STORAGE_KEY)).toBe('{damaged');
    expect(decodeImport(encodeCampaign(loaded.progress)).kind).toBe('campaign');
  });
  it('本机存储权限不可用时仍有可导出的有效试玩状态', () => {
    const loaded = readProgress(() => { throw new Error('storage unavailable'); });
    expect(loaded.blocked).toBe(true);
    expect(loaded.error).toContain('storage unavailable');
    expect(decodeProgress(encodeProgress(loaded.progress))).toEqual(newProgress());
  });
  it('有效本机进度可写入当前保存和手动检查点', () => {
    const data = new Map<string, string>();
    const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const loaded = readProgress(() => store);
    writeProgress(() => store, loaded.progress, { checkpoint: true });
    expect(data.get(STORAGE_KEY)).toBe(data.get(CHECKPOINT_KEY));
    expect(readProgress(() => store).progress).toEqual(loaded.progress);
  });
  it('最终课目标收紧时保留旧成绩和布局，前面三课的有效成绩继续成立', () => {
    const progress = newProgress();
    const first = simulate(levelSnapshot(LEVELS[0]), withSign());
    appendAttempt(progress.chapters.sight, 4261, withSign(), first.metrics, first.fingerprint, true);
    const lastLevel = LEVELS[3], snapshot = levelSnapshot(lastLevel);
    const design = makeDesign([makeSign({ x: 6.7, y: 5.2 }), makeSign({ x: 21.3, y: 8.5 }, { id: 2, target: 'A' })]);
    const run = simulate(snapshot, design);
    appendAttempt(progress.chapters.together, snapshot.seed, design, run.metrics, run.fingerprint, true);
    const old = JSON.parse(encodeProgress(progress));
    for (const chapter of Object.values(old.chapters) as Array<{ rule?: string; attempts: Array<{ rule?: string }> }>) {
      delete chapter.rule; for (const attempt of chapter.attempts) delete attempt.rule;
    }
    const restored = decodeProgress(JSON.stringify(old));
    expect(restored.chapters.sight.solved).toBe(true);
    expect(restored.chapters.together.solved).toBe(false);
    expect(restored.chapters.together.draft).toEqual(design);
    expect(restored.chapters.together.attempts[0].passed).toBe(true);
    expect(restored.chapters.together.attempts[0].rule).toBe('e0103f1c');
    expect(restored.chapters.together.rule).toBe(levelRuleId(lastLevel));
  });
  it('完整进度文件跨环境回读四课草稿、记录与暂停时刻', () => {
    const progress = newProgress();
    progress.chapters.sight.draft = withSign();
    progress.session = { levelId: 'sight', seed: 4261, design: withSign(), selected: 4, time: 10, review: true };
    const imported = decodeImport(encodeCampaign(progress));
    expect(imported.kind).toBe('campaign');
    if (imported.kind === 'campaign') expect(imported.progress).toEqual(progress);
  });
  it('保留早期四课的布局，但不让旧模型成绩变成当前通关证明', () => {
    const old = newProgress();
    const level = LEVELS[0];
    old.chapters.sight.draft = withSign();
    old.session = { levelId: 'sight', seed: 4261, design: withSign(), selected: 4, time: 10, review: true };
    old.chapters.sight.solved = true;
    const raw = JSON.stringify({ ...old, model: 'zhong-orca-2' });
    const next = migratePreviousProgress(raw);
    expect(next.chapters.sight.draft).toEqual(withSign());
    expect(next.chapters.sight.solved).toBe(false);
    expect(next.chapters.sight.attempts).toEqual([]);
    expect(next.session?.review).toBe(false);
    expect(next.session?.time).toBe(0);
    expect(JSON.parse(raw).model).toBe('zhong-orca-2');
    expect(next.model).toBe(MODEL);
    expect(next.chapters[level.id].draft).not.toBe(old.chapters[level.id].draft);
  });
  it('导入早期四课文件时仅复用设计并明确要求重新推演', () => {
    const session = { levelId: 'sight', seed: 4261, design: withSign(), selected: 4, time: 10, review: true };
    const imported = decodeImport(JSON.stringify({ format: 'zhong-design', schema: 2, model: 'zhong-orca-2', session }));
    expect(imported.kind).toBe('current');
    if (imported.kind !== 'current') return;
    expect(imported.session.review).toBe(false);
    expect(imported.sourceModel).toBe('zhong-orca-2');
  });
});
describe('几何与信息基础', () => {
  it('标识须同时满足距离、正面、个体视域和无遮挡条件', () => {
    const sign = makeSign({ x: 0, y: 0 });
    expect(canReadSign({ x: 0, y: 3 }, { x: 0, y: -1 }, sign, [])).toBe(true);
    expect(canReadSign({ x: 0, y: -3 }, { x: 0, y: 1 }, sign, [])).toBe(false);
    expect(canReadSign({ x: 0, y: 3 }, { x: 0, y: 1 }, sign, [])).toBe(false);
    expect(canReadSign({ x: 0, y: 10 }, { x: 0, y: -1 }, sign, [])).toBe(false);
    expect(canReadSign({ x: 0, y: 3 }, { x: 0, y: -1 }, sign, [{ id: 'wall', x: -1, y: 1, w: 2, h: 0.4 }])).toBe(false);
  });
  it('寻路绕过真实墙体，折线每段都满足圆盘净空', () => {
    const walls = [{ id: 'wall', x: 3, y: 1, w: 1, h: 5 }];
    const path = findPath({ x: 1, y: 3 }, { x: 7, y: 3 }, walls, 0.23);
    expect(path.length).toBeGreaterThan(1);
    let previous = { x: 1, y: 3 };
    for (const p of path) { expect(segmentClear(previous, p, walls, 0.23)).toBe(true); previous = p; }
    expect(previous).toEqual({ x: 7, y: 3 });
  });
});

describe('模拟与解释回归', () => {
  const snapshot = createSnapshot(4261);
  const intervention = () => simulate(snapshot, withSign());
  it('近墙角仍须获得后段净空，不能提前切墙而永久互锁', () => {
    const corner = createSnapshot();
    corner.agents = [{ ...corner.agents[0], position: { x: 14.749, y: 3.205 }, speed: 1.1 }];
    const run = simulate(corner, withSign(makeSign(SIGN_POSITIONS.hidden)));
    expect(run.metrics.completed).toBe(1);
    expect(run.duration).toBeLessThan(30);
  });
  it('到达出口门槛即通过，不要求精确对准个人目标点', () => {
    const snapshot = createSnapshot();
    snapshot.agents = [{ ...snapshot.agents[0], id: 14, position: { x: 3.72, y: 0.73 }, speed: 1.1, knowsB: true }];
    const run = simulate(snapshot, withSign(makeSign(SIGN_POSITIONS.hidden)));
    expect(run.metrics.completed).toBe(1);
    expect(run.duration).toBe(STEP);
  });
  it('相同初态与设计的轨迹、事件、指标和指纹完全重现', () => {
    const run = intervention();
    expect(run.model).toBe(MODEL);
    expect(run).toEqual(intervention());
    expect(snapshot).toEqual(createSnapshot(4261));
  });
  it('遮挡不会传递知识，每次信息改道都有实际感知和代价证据', () => {
    const baseline = simulate(snapshot, withSign(makeSign(SIGN_POSITIONS.hidden)));
    expect(baseline.metrics.informed).toBe(0);
    expect(baseline.metrics.exits.B).toBe(0);
    const run = intervention();
    expect(run.metrics.informed).toBeGreaterThan(0);
    for (const event of run.events.filter(e => e.type === 'choose' && e.source === 'sign')) {
      expect(run.events.some(e => e.agentId === event.agentId && e.type === 'learn' && e.tick <= event.tick)).toBe(true);
      expect(event.exit === 'B' ? event.costB! < event.costA! : event.costA! < event.costB!).toBe(true);
    }
  });
  it('原本已知所有出口的人，不因标识移动被强行改道', () => {
    const informed = createSnapshot();
    informed.agents.forEach(a => { a.knowsB = true; });
    const a = simulate(informed, withSign(makeSign(SIGN_POSITIONS.hidden)));
    const b = simulate(informed, withSign());
    expect(a.frames).toEqual(b.frames);
    expect(a.events).toEqual(b.events);
    expect(a.metrics).toEqual(b.metrics);
  });
  it('同一时刻的感知事件、位置与知识帧一致', () => {
    const run = intervention();
    for (const event of run.events.filter(e => e.type === 'learn')) {
      const a = frameAt(run, event.time).agents[event.agentId - 1];
      expect(event.learnedExit === 'B' ? a.knowsB : a.knowsA).toBe(true);
      expect(distance(a, event.position)).toBeLessThan(1e-8);
    }
  });
  it('人数守恒且默认运行的每帧圆盘均不重叠或穿墙', () => {
    const run = intervention();
    expect(run.metrics.completed + run.metrics.unfinished).toBe(32);
    expect(run.metrics.completed).toBe(32);
    for (const frame of run.frames) {
      const active = frame.agents.filter(a => !a.arrived);
      active.forEach((a, i) => {
        expect(isWalkable(a, snapshot.scene.walls, 0.229)).toBe(true);
        for (let j = i + 1; j < active.length; j++) expect(distance(a, active[j])).toBeGreaterThanOrEqual(0.459);
      });
    }
  });
  it('回放任意前后读取不会改变模拟结果', () => {
    const run = intervention();
    expect(frameAt(run, 0)).toEqual(run.frames[0]);
    expect(frameAt(run, run.duration + 99)).toEqual(run.frames.at(-1));
    const before = JSON.stringify(run.metrics);
    frameAt(run, 17.9); frameAt(run, 2.1);
    expect(JSON.stringify(run.metrics)).toBe(before);
    expect(run.fingerprint).toBe(intervention().fingerprint);
  });
});

describe('进度、方案与旧数据', () => {
  it('多次后续尝试不会把首次达成的方案从进度中挤掉', () => {
    const progress = newProgress();
    const chapter = progress.chapters.sight;
    const design = withSign(makeSign({ x: 6.3, y: 8.8 }));
    const run = simulate(levelSnapshot(LEVELS[0]), design);
    appendAttempt(chapter, 4261, design, run.metrics, run.fingerprint, true);
    for (let i = 0; i < 15; i++) appendAttempt(chapter, 4261, design, { ...run.metrics, meanArrival: 40 + i }, run.fingerprint, false);
    expect(chapter.attempts.length).toBeLessThanOrEqual(12);
    expect(chapter.attempts.some(attempt => attempt.passed)).toBe(true);
    expect(decodeProgress(encodeProgress(progress)).chapters.sight.solved).toBe(true);
  });
  it('进度保存回读保留方案、历史和精确回放位置', () => {
    const progress = newProgress();
    const level = LEVELS[0];
    const snapshot = levelSnapshot(level);
    const baseline = simulate(snapshot, level.baseline);
    const design = withSign(makeSign({ x: 6.3, y: 8.8 }));
    const run = simulate(snapshot, design);
    const goals = evaluate(level, baseline, run);
    appendAttempt(progress.chapters.sight, snapshot.seed, design, run.metrics, run.fingerprint, completed(goals));
    progress.session = { levelId: level.id, seed: snapshot.seed, design, selected: 25, time: 3.5, review: true };
    expect(decodeProgress(encodeProgress(progress))).toEqual(progress);
    const report = buildReport(level, snapshot, baseline, run, goals);
    expect(report.changed.events).toEqual(run.events);
    expect(report.changed.fingerprint).toBe(run.fingerprint);
    const imported = decodeImport(encodeDesign(progress.session, report));
    expect(imported).toEqual({ kind: 'current', session: progress.session });
  });
  it('旧实验只能先作为旧记录读取，显式复制位置后才用新规则计算', () => {
    const text = JSON.stringify(legacyExample);
    const legacy = decodeImport(text);
    expect(legacy.kind).toBe('legacy');
    if (legacy.kind !== 'legacy') throw new Error('未识别旧存档');
    expect(legacy.metrics!.before).toBeCloseTo(22.209375);
    const session = copyLegacy(legacy);
    expect(session.design.signs[0].position).toEqual(legacy.position);
    expect(session.review).toBe(false);
    expect(decodeImport(encodeDesign(session, null)).kind).toBe('current');
    expect(JSON.stringify(legacyExample)).toBe(text);
  });
  it('拒绝损坏、陌生版本、墙内位置和超预算设计，保留当前数据', () => {
    expect(() => decodeImport('{')).toThrow();
    const session = { levelId: 'sight', seed: 4261, design: withSign(), selected: 1, time: 0, review: false };
    const valid = JSON.parse(encodeDesign(session, null));
    expect(() => decodeImport(JSON.stringify({ ...valid, model: 'unknown' }))).toThrow();
    expect(() => decodeImport(encodeDesign({ ...session, seed: -1 }, null))).toThrow();
    expect(() => decodeImport(encodeDesign({ ...session, design: withSign(makeSign({ x: 6, y: 6.7 })) }, null))).toThrow();
    expect(() => decodeImport(encodeDesign({ ...session, design: { ...withSign(), barrier: { position: { x: 12, y: 11 }, vertical: true } } }, null))).toThrow();
  });
});
