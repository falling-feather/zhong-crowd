import { beforeAll, describe, expect, it } from 'vitest';
import { LEVELS, levelSnapshot } from '../src/game/content';
import { makeDesign, makeSign } from '../src/core/scene';
import { simulate, frameAt } from '../src/core/simulation';
import type { Run } from '../src/core/types';
import { mapEvidence, nextMapObservation } from '../src/game/map-evidence';

describe('地图上的因果来自实际事件与帧', () => {
  const level = LEVELS[1], snapshot = levelSnapshot(level);
  let run: Run;
  beforeAll(() => { run = simulate(snapshot, makeDesign([makeSign({x:7.2,y:8.8})])); });
  it('读牌连线对应已发生的读取事件，不显示未来读取', () => {
    const event = run.events.find(e=>e.type==='learn')!;
    const data = mapEvidence(snapshot, run, event.time);
    expect(data.reads.length).toBeGreaterThan(0);
    for (const signal of data.reads) {
      expect(signal.time).toBeLessThanOrEqual(event.time);
      expect(run.events.some(e=>e.type==='learn'&&e.agentId===signal.agentId&&e.signId===signal.signId&&e.time===signal.time)).toBe(true);
    }
    expect(mapEvidence(snapshot,run,-.1).reads).toEqual([]);
  });
  it('排队人数只来自当前门槛状态，放行倒计时只由实际放行和规则推导', () => {
    const arrivals = run.events.filter(e=>e.type==='arrive'&&e.exit==='B');
    const time = arrivals[0].time + .1, data = mapEvidence(snapshot,run,time);
    const gate=data.gates.find(g=>g.id==='B')!;
    expect(gate.lastPassTime).toBe(arrivals[0].time);
    expect(gate.lastPassPosition).toEqual(arrivals[0].position);
    expect(gate.pulse).toBeGreaterThan(0);
    expect(mapEvidence(snapshot,run,0).gates.find(g=>g.id==='B')!.lastPassPosition).toBeNull();
    expect(gate.readyIn).toBeCloseTo(1.7,8);
    expect(gate.waitingIds).toEqual(frameAt(run,time).agents.filter(a=>a.queued&&!a.arrived&&a.exit==='B').map(a=>a.id));
    expect(arrivals[1].time-arrivals[0].time).toBeGreaterThanOrEqual(1.8-1e-8);
  });
  it('观察入口跳到实际读牌和慢门队列，不能编造一个观察时刻', () => {
    for(const kind of ['learn','queue'] as const){
      const event=nextMapObservation(snapshot,run,run.duration,kind)!;
      expect(run.events).toContain(event);
      expect(event.type).toBe(kind);
      if(kind==='queue')expect(event.exit).toBe('B');
    }
  });
});
