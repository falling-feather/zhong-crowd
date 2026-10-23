import { MODEL, MAX_TIME } from '../core/scene';
import { simulate } from '../core/simulation';
import type { Design, Run } from '../core/types';
import { levelById, levelSnapshot } from './content';
import { completed, evaluate, validateLevelDesign, type GoalResult } from './evaluation';

export interface SimulationRequest { id: number; type: 'baseline' | 'run' | 'verify'; levelId: string; seed: number; design: Design }
export interface Verification { seed: number; passed: boolean; goals: GoalResult[]; baseline: string; fingerprint: string }
export type SimulationResponse =
  | { id: number; type: 'progress'; phase: string; simulatedTime: number }
  | { id: number; type: 'result'; baseline: Run; run: Run | null }
  | { id: number; type: 'verified'; proofs: Verification[] }
  | { id: number; type: 'error'; message: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent<SimulationRequest>) => void) | null; postMessage(data: SimulationResponse): void };
const baselines = new Map<string, Run>();
scope.onmessage = event => {
  const request = event.data;
  try {
    const level = levelById(request.levelId);
    if (!level) throw new Error('关卡不存在');
    const progress = (phase: string) => (ratio: number) => scope.postMessage({ id: request.id, type: 'progress', phase, simulatedTime: Math.min(MAX_TIME, Math.round(ratio * MAX_TIME * 10) / 10) });
    const getBaseline = (seed: number, phase: string) => {
      const key = `${MODEL}:${level.id}:${seed}`;
      let result = baselines.get(key);
      if (!result) {
        result = simulate(levelSnapshot(level, seed), level.baseline, progress(phase));
        baselines.set(key, result);
        if (baselines.size > 4) baselines.delete(baselines.keys().next().value!);
      }
      return result;
    };
    if (request.type === 'verify') {
      const seeds = [...new Set([request.seed, 17, 8201])];
      const proofs = seeds.map((seed, index): Verification => {
        const snapshot = levelSnapshot(level, seed);
        validateLevelDesign(level, snapshot, request.design);
        const baseline = getBaseline(seed, `复核 ${index + 1}/${seeds.length} · 原始布局`);
        const run = simulate(snapshot, request.design, progress(`复核 ${index + 1}/${seeds.length} · 当前方案`));
        const goals = evaluate(level, baseline, run);
        return { seed, passed: completed(goals), goals, baseline: baseline.fingerprint, fingerprint: run.fingerprint };
      });
      scope.postMessage({ id: request.id, type: 'verified', proofs });
    } else {
      const snapshot = levelSnapshot(level, request.seed);
      validateLevelDesign(level, snapshot, request.design);
      const baseline = getBaseline(request.seed, '原始布局');
      const run = request.type === 'run' ? simulate(snapshot, request.design, progress('当前方案')) : null;
      scope.postMessage({ id: request.id, type: 'result', baseline, run });
    }
  } catch (error) { scope.postMessage({ id: request.id, type: 'error', message: error instanceof Error ? error.message : '推演未能完成' }); }
};
