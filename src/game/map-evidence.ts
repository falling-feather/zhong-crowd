import { frameAt } from '../core/simulation';
import type { DecisionEvent, ExitId, Run, Snapshot } from '../core/types';

export const READING_WINDOW = 1.2;
export function mapEvidence(snapshot: Snapshot,run: Run,time: number) {
  const frame=frameAt(run,Math.max(0,time));
  const reads=run.events.filter(e=>e.type==='learn'&&e.time<=time+.00001&&e.time>=time-READING_WINDOW)
    .map(e=>({agentId:e.agentId,signId:e.signId!,exit:e.learnedExit!,time:e.time,point:e.position,age:Math.max(0,time-e.time)}));
  const gates=(['A','B'] as const).map(id=>{
    const gate=snapshot.scene.exits[id];
    const passes=run.events.filter(e=>e.type==='arrive'&&e.exit===id&&e.time<=time+.00001);
    const lastPassTime=passes.at(-1)?.time??null;
    const elapsed=lastPassTime===null?Infinity:Math.max(0,time-lastPassTime);
    const readyIn=lastPassTime===null||!gate.interval?0:Math.max(0,lastPassTime+gate.interval-time);
    const waitingIds=frame.agents.filter(a=>a.exit===id&&a.queued&&!a.arrived).map(a=>a.id);
    const slowIds=frame.agents.filter(a=>!a.arrived&&!a.queued&&a.exit===id&&Math.hypot(a.x-gate.x,a.y-gate.y)<4.5&&
      Math.hypot(a.vx,a.vy)<snapshot.agents.find(s=>s.id===a.id)!.speed*.3).map(a=>a.id);
    return {id,passes:passes.length,lastPassTime,lastPassPosition:passes.at(-1)?.position??null,readyIn,progress:!gate.interval?1:Math.min(1,elapsed/gate.interval),
      pulse:lastPassTime!==null&&elapsed<.65?1-elapsed/.65:0,waitingIds,slowIds};
  });
  return {reads,gates};
}
export function nextMapObservation(snapshot: Snapshot,run: Run,time: number,kind:'learn'|'queue'): DecisionEvent|null {
  let events=run.events.filter(e=>e.type===kind);
  if(kind==='queue'){
    const slowest=(['A','B'] as ExitId[]).filter(id=>events.some(e=>e.exit===id))
      .sort((a,b)=>snapshot.scene.exits[b].interval-snapshot.scene.exits[a].interval)[0];
    events=events.filter(e=>e.exit===slowest);
    // Choose an actual queue event when its nearby slowdown is most visible.
    // The witness time stays an event time; no synthetic queue or heat values are created.
    const scored=events.map(event=>{
      const gate=mapEvidence(snapshot,run,event.time).gates.find(g=>g.id===event.exit)!;
      return {event,score:gate.waitingIds.length*2+gate.slowIds.length};
    }).sort((a,b)=>b.score-a.score||a.event.time-b.event.time);
    return scored[0]?.event??null;
  }
  return events.find(e=>e.time>time+.05)??events[0]??null;
}
