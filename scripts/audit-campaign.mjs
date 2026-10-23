import { createServer } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { LEVELS, levelSnapshot, levelRuleId } = await server.ssrLoadModule('/src/game/content.ts');
  const { simulate } = await server.ssrLoadModule('/src/core/simulation.ts');
  const { evaluate, completed } = await server.ssrLoadModule('/src/game/evaluation.ts');
  const { designWalls, MODEL, STEP } = await server.ssrLoadModule('/src/core/scene.ts');
  const { distance, isWalkable, segmentClear, sweptDistance } = await server.ssrLoadModule('/src/core/geometry.ts');
  const references = JSON.parse(await readFile(resolve(root, 'tests/fixtures/campaign-designs.json'), 'utf8'));
  // Distinct from the three seeds exposed by the in-game verification action.
  const unseen = [0, 1, 2, 3, 10, 42, 617, 1024, 65535, 140113, 318091, 4294967295];
  const records = [], issues = [];
  let minPair = Infinity, physicsSteps = 0, issueCount = 0;
  const physics = (level, snapshot, run, kind) => {
    const walls = designWalls(snapshot.scene, run.design);
    const issue = (reason, tick, ids) => { issueCount++; if (issues.length < 20) issues.push({ level: level.id, seed: snapshot.seed, kind, reason, time: tick * STEP, ids }); };
    for (let tick = 0; tick < run.frames.length; tick++) {
      const frame = run.frames[tick], next = run.frames[tick + 1];
      const active = frame.agents.filter(a => !a.arrived);
      physicsSteps++;
      for (let i = 0; i < active.length; i++) {
        const a = active[i], end = next?.agents[a.id - 1];
        if (!isWalkable(a, walls, .229)) issue('wall-overlap', tick, [a.id]);
        if (end) {
          if (!segmentClear(a, end, walls, .229)) issue('wall-crossing', tick, [a.id]);
          if (distance(a, end) > snapshot.agents[a.id - 1].speed * STEP + .00001) issue('speed-limit', tick, [a.id]);
        }
        for (let j = i + 1; j < active.length; j++) {
          const b = active[j];
          const d = end ? sweptDistance(a, end, b, next.agents[b.id - 1]) : distance(a, b);
          minPair = Math.min(minPair, d);
          if (d < .459) issue('body-overlap', tick, [a.id, b.id]);
        }
      }
    }
  };
  for (const level of LEVELS) {
    const cases = [];
    const design = references.find(r => r.level === level.id).design;
    for (const seed of [level.seed, ...unseen]) {
      const snapshot = levelSnapshot(level, seed);
      let start = performance.now();
      const baseline = simulate(snapshot, level.baseline);
      const baselineMs = performance.now() - start;
      start = performance.now();
      const run = simulate(snapshot, design);
      const runMs = performance.now() - start;
      physics(level, snapshot, baseline, 'baseline'); physics(level, snapshot, run, 'reference');
      const goals = evaluate(level, baseline, run);
      const summary = r => ({ count: r.metrics.completed, mean: r.metrics.meanArrival, tail: r.metrics.lastArrival,
        delay: r.metrics.meanDelay, informed: r.metrics.informed, exits: r.metrics.exits, cohorts: r.metrics.cohorts, hash: r.fingerprint });
      cases.push({ seed, passed: completed(goals), baseline: summary(baseline), current: summary(run), goals,
        elapsedMs: { baseline: Math.round(baselineMs), current: Math.round(runMs) } });
    }
    const record = { level: level.id, rule: levelRuleId(level), design, passed: cases.filter(c => c.passed).length, total: cases.length, cases };
    records.push(record);
    console.log(JSON.stringify({ level: level.id, passed: record.passed, total: record.total, failures: cases.filter(c => !c.passed).map(c => c.seed) }));
  }
  const result = { model: MODEL, timestamp: new Date().toISOString(), scope: '程序运动检查和固定设计跨初态检查；不是现实行为或人类体验验证',
    seedsPerLevel: 13, physicsSteps, minimumSweptCenterDistance: minPair, bodyDiameter: .46, issueCount, issues, records };
  await writeFile(resolve(root, 'output/DEV-002-关卡审计.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ physicsSteps, minimumDistance: minPair, issueCount }));
  if (issues.length) process.exitCode = 1;
} finally { await server.close(); }
