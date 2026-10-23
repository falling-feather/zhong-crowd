import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { LEVELS, levelSnapshot, levelRuleId } = await server.ssrLoadModule('/src/game/content.ts');
  const { MODEL, makeDesign, makeSign } = await server.ssrLoadModule('/src/core/scene.ts');
  const { simulate } = await server.ssrLoadModule('/src/core/simulation.ts');
  const { evaluate, completed, validateLevelDesign } = await server.ssrLoadModule('/src/game/evaluation.ts');
  const { createGuidance, designChanges } = await server.ssrLoadModule('/src/game/guidance.ts');
  const { compareSchemes, explainMetric } = await server.ssrLoadModule('/src/game/interpretation.ts');
  const { createInquiry, observeInquiry, inquiryRows } = await server.ssrLoadModule('/src/game/inquiry.ts');
  const { mapEvidence, nextMapObservation } = await server.ssrLoadModule('/src/game/map-evidence.ts');
  const cases = [
    { failed: LEVELS[0].baseline, revised: makeDesign([makeSign({ x: 7.2, y: 8.8 })]), variable: 'position' },
    { failed: makeDesign([makeSign({ x: 7.2, y: 8.8 })]), revised: makeDesign([makeSign({ x: 7.2, y: 8.8 }, { normal: { x: -1, y: 0 } })]), variable: 'orientation' },
    { failed: makeDesign([makeSign({ x: 11.9, y: 8.8 }, { until: .1 })]), revised: makeDesign([makeSign({ x: 11.9, y: 8.8 }, { until: 20 })]), variable: 'until' },
    { failed: makeDesign([makeSign({ x: 6.7, y: 5.2 }), makeSign({ x: 21.3, y: 8.5 }, { id: 2, target: 'A' })]),
      revised: makeDesign([makeSign({ x: 6.7, y: 8.5 }), makeSign({ x: 21.3, y: 8.5 }, { id: 2, target: 'A' })]), variable: 'position' },
  ];
  const metrics = run => ({ completed: run.metrics.completed, mean: run.metrics.meanArrival, tail: run.metrics.lastArrival,
    informed: run.metrics.informed, delay: run.metrics.meanDelay, cohorts: run.metrics.cohorts, fingerprint: run.fingerprint });
  const baselines = new Map();
  const getBaseline = (level, seed) => {
    const key = `${level.id}/${seed}`;
    if (!baselines.has(key)) baselines.set(key, simulate(levelSnapshot(level, seed), level.baseline));
    return baselines.get(key);
  };
  const chains = [], transfers = [], predictionExamples = [], mapWitnesses = [];
  for (const [index, level] of LEVELS.entries()) {
    const { failed: failedDesign, revised: revisedDesign, variable } = cases[index], snapshot = levelSnapshot(level);
    const baseline = getBaseline(level, level.seed);
    validateLevelDesign(level, snapshot, failedDesign); validateLevelDesign(level, snapshot, revisedDesign);
    const transferPrediction=level.id==='balance'?createInquiry(level,level.seed,1,failedDesign,baseline,'本课原始布局',{mean:'lower',tail:'lower'}):null;
    const failed = simulate(snapshot, failedDesign);
    const revisionPrediction=level.id==='balance'?createInquiry(level,level.seed,2,revisedDesign,failed,'上一轮方案',{mean:'lower',tail:'lower'}):null;
    const revised = simulate(snapshot, revisedDesign);
    if(transferPrediction&&revisionPrediction){
      const first=observeInquiry(transferPrediction,level,level.seed,failed),second=observeInquiry(revisionPrediction,level,level.seed,revised);
      assert.deepEqual(inquiryRows(level,first).map(r=>r.actualDirection),['higher','higher']);
      assert.deepEqual(inquiryRows(level,second).map(r=>r.actualDirection),['lower','lower']);
      predictionExamples.push({level:level.id,records:[first,second],scope:'开发者固定假设，不是玩家学习成效'});
    }
    if(level.id==='sight'||level.id==='balance'){
      const kind=level.id==='sight'?'learn':'queue',run=kind==='learn'?revised:failed;
      const event=nextMapObservation(snapshot,run,run.duration,kind),shown=mapEvidence(snapshot,run,event.time);
      assert.ok(run.events.includes(event));
      mapWitnesses.push({level:level.id,seed:level.seed,fingerprint:run.fingerprint,event,reads:shown.reads,gates:shown.gates});
    }
    const beforeGoals = evaluate(level, baseline, failed), afterGoals = evaluate(level, baseline, revised);
    assert.equal(completed(beforeGoals), false, `${level.id}: failure example must really fail`);
    assert.equal(completed(afterGoals), true, `${level.id}: revision must really pass`);
    const guide = createGuidance(level, snapshot, baseline, failed);
    assert.equal(guide.variable, variable);
    assert.equal(designChanges(failedDesign, revisedDesign).length, 1);
    const witness = failed.frames.find(frame => frame.time === guide.time).agents.find(a => a.id === guide.agentId);
    assert.deepEqual(guide.map.point, { x: witness.x, y: witness.y });
    const explanations = afterGoals.map(goal => {
      const explanation = explainMetric(level, snapshot, baseline, revised, goal.id), person = explanation.people[0];
      assert.deepEqual(person.current, revised.agents.find(a => a.id === person.id));
      return { metric: goal.id, title: explanation.title, witness: { id: person.id, time: person.time, event: person.event?.type ?? null,
        arrival: person.current.arrivalTime, delay: person.current.delay, gateWait: person.current.gateWait } };
    });
    const verification = [level.seed, 17, 8201].map(seed => {
      const run = seed === level.seed ? revised : simulate(levelSnapshot(level, seed), revisedDesign);
      const original = getBaseline(level, seed), goals = evaluate(level, original, run);
      compareSchemes(original, run);
      return { seed, passed: completed(goals), baseline: original.fingerprint, fingerprint: run.fingerprint, goals };
    });
    chains.push({ level: level.id, seed: level.seed, rule: levelRuleId(level), baseline: metrics(baseline), failed: { design: failedDesign, metrics: metrics(failed), goals: beforeGoals },
      diagnosis: { title: guide.title, observation: guide.observation, variable: guide.variable, signId: guide.signId, agentId: guide.agentId, time: guide.time, experiment: guide.experiment },
      revised: { design: revisedDesign, metrics: metrics(revised), goals: afterGoals }, changes: designChanges(failedDesign, revisedDesign), explanations, verification });
    if (index) {
      const carried = cases[index - 1].revised;
      validateLevelDesign(level, snapshot, carried);
      const run = simulate(snapshot, carried), goals = evaluate(level, baseline, run);
      transfers.push({ from: LEVELS[index-1].id, to: level.id, seed: level.seed, design: carried, metrics: metrics(run), goals, passed: completed(goals) });
    }
  }
  const care = LEVELS[2], snapshot = levelSnapshot(care), baseline = getBaseline(care, care.seed);
  const first = simulate(snapshot, makeDesign([makeSign({ x: 11.9, y: 8.8 }, { until: 20 })]));
  const selectiveDesign=makeDesign([makeSign({ x: 11.9, y: 8.8 }, { from: 3, until: 20 })]);
  const fairnessPrediction=createInquiry(care,care.seed,1,selectiveDesign,first,'上一轮方案',{mean:'lower',care:'lower',protect:'lower'});
  const selective = simulate(snapshot, selectiveDesign);
  const fairnessObservation=observeInquiry(fairnessPrediction,care,care.seed,selective);
  assert.deepEqual(inquiryRows(care,fairnessObservation).map(r=>r.actualDirection),['higher','lower','higher']);
  predictionExamples.push({level:care.id,records:[fairnessObservation],scope:'开发者固定假设，不是玩家学习成效'});
  assert.ok(selective.metrics.meanArrival > first.metrics.meanArrival);
  assert.ok(selective.metrics.cohorts.slow.tail < first.metrics.cohorts.slow.tail);
  assert.ok(completed(evaluate(care, baseline, first)) && completed(evaluate(care, baseline, selective)));
  const pair = compareSchemes(first, selective);
  const protectionFailure = simulate(snapshot, makeDesign([makeSign({ x: 14, y: 7.5 }, { normal: { x: -1, y: 0 } })]));
  const protectionRevision = simulate(snapshot, makeDesign([makeSign({ x: 14, y: 7.5 }, { normal: { x: -1, y: 0 }, from: 3 })]));
  const guide = createGuidance(care, snapshot, baseline, protectionFailure);
  assert.equal(guide.variable, 'from');
  assert.ok(guide.title.includes('代价'));
  const report = { model: MODEL, generatedAt: new Date().toISOString(), scope: '规则内的开发者固定案例，不是玩家学习成效或现实行为校准', chains, transfers, predictionExamples, mapWitnesses,
    fairness: { level: 'care', seed: care.seed, first: { design: first.design, metrics: metrics(first) }, selective: { design: selective.design, metrics: metrics(selective) },
      changed: designChanges(first.design, selective.design), benefited: pair.benefited, harmed: pair.harmed, unchanged: pair.unchanged,
      protection: { failed: metrics(protectionFailure), diagnosis: { title: guide.title, variable: guide.variable, agentId: guide.agentId, time: guide.time }, revised: metrics(protectionRevision) } } };
  await writeFile(resolve('output/DEV-004-教学链路与公平取舍.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ chains: chains.length, allRevisionsPass: true, proofs: chains.map(c => ({ level:c.level, passed:c.verification.filter(v=>v.passed).length, total:c.verification.length })),
    transfers: transfers.map(t => ({ from:t.from,to:t.to,passed:t.passed })), fairness:{ mean:[first.metrics.meanArrival,selective.metrics.meanArrival],slowTail:[first.metrics.cohorts.slow.tail,selective.metrics.cohorts.slow.tail],benefited:pair.benefited,harmed:pair.harmed} }));
} finally { await server.close(); }
