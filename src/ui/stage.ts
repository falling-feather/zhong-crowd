import { add, clamp, readability, segmentClear } from '../core/geometry';
import { barrierRect, designWalls } from '../core/scene';
import { frameAt } from '../core/simulation';
import type { Design, Frame, Run, Snapshot, Vec } from '../core/types';
import type { Level } from '../game/content';
import type { Guidance } from '../game/guidance';
import { mapEvidence, READING_WINDOW } from '../game/map-evidence';
import { escape, pad } from './format';

export type SelectedTool = { kind: 'sign'; id: number } | { kind: 'barrier' } | null;
export interface StageState {
  design: Design;
  run: Run | null;
  baseline: Run | null;
  time: number;
  selected: number;
  tool: SelectedTool;
  editing: boolean;
  compare: boolean;
  coverage: boolean;
  density: boolean;
  placing: 'sign' | 'barrier' | null;
  overview: boolean;
  follow: boolean;
  guide: Guidance | null;
  causality: boolean;
}
export class Stage {
  private level!: Level;
  private snapshot!: Snapshot;
  private state!: StageState;
  private drag: SelectedTool = null;
  private coneCache = new Map<string, string>();
  onSelectTool: (tool: SelectedTool) => void = () => {};
  onMoveTool: (tool: Exclude<SelectedTool, null>, point: Vec, final: boolean) => void = () => {};
  onPlace: (kind: 'sign' | 'barrier', point: Vec) => void = () => {};
  onSelectAgent: (id: number) => void = () => {};
  onRotate: () => void = () => {};
  onRemove: () => void = () => {};

  constructor(readonly svg: SVGSVGElement) {
    svg.addEventListener('pointerdown', event => {
      const target = event.target as Element;
      if (this.state.editing) {
        const sign = target.closest<SVGElement>('[data-sign]');
        const barrier = target.closest('[data-barrier]');
        const tool: SelectedTool = sign ? { kind: 'sign', id: Number(sign.dataset.sign) } : barrier ? { kind: 'barrier' } : null;
        if (tool) {
          this.drag = tool;
          this.onSelectTool(tool);
          svg.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        if (this.state.placing) { this.onPlace(this.state.placing, this.point(event)); return; }
      }
      const person = target.closest<SVGElement>('[data-person]');
      if (person) this.onSelectAgent(Number(person.dataset.person));
    });
    svg.addEventListener('pointermove', event => { if (this.drag) this.onMoveTool(this.drag, this.point(event), false); });
    svg.addEventListener('pointerup', event => {
      if (this.drag) {
        const tool = this.drag;
        this.drag = null;
        this.onMoveTool(tool, this.point(event), true);
        if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
      }
    });
    svg.addEventListener('pointercancel', () => { this.drag = null; });
    svg.addEventListener('keydown', event => {
      const target = event.target as Element;
      const sign = target.closest<SVGElement>('[data-sign]');
      const barrier = target.closest('[data-barrier]');
      const person = target.closest<SVGElement>('[data-person]');
      if (person && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); this.onSelectAgent(Number(person.dataset.person)); }
      if (!this.state.editing || (!sign && !barrier)) return;
      if (!['r', 'delete', 'backspace', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'enter'].includes(event.key.toLowerCase())) return;
      const tool: Exclude<SelectedTool, null> = sign ? { kind: 'sign', id: Number(sign.dataset.sign) } : { kind: 'barrier' };
      this.onSelectTool(tool);
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); this.onRotate(); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.onRemove(); }
      const direction = { ArrowLeft: { x: -0.2, y: 0 }, ArrowRight: { x: 0.2, y: 0 }, ArrowUp: { x: 0, y: -0.2 }, ArrowDown: { x: 0, y: 0.2 } }[event.key];
      if (direction) {
        event.preventDefault();
        const current = tool.kind === 'sign' ? this.state.design.signs.find(s => s.id === tool.id)!.position : this.state.design.barrier!.position;
        this.onMoveTool(tool, add(current, direction), true);
      }
    });
  }

  setLevel(level: Level, snapshot: Snapshot) {
    this.level = level;
    this.snapshot = snapshot;
    this.coneCache.clear();
    this.svg.setAttribute('viewBox', '-0.8 -3.2 29.6 22.3');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
    this.svg.innerHTML = `<defs>
      <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 H 0 V 1" fill="none" stroke="#d4d2c8" stroke-width=".018"/></pattern>
      <filter id="selectedGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation=".12"/></filter>
    </defs>
    <rect x="0" y="0" width="28" height="18" rx=".2" fill="#faf9f3"/>
    <rect x="0" y="0" width="28" height="18" fill="url(#grid)" opacity=".65"/>
    <g id="zones">${level.groups.map(group => `<rect x="${group.origin.x - .65}" y="${group.origin.y - .65}" width="${(group.columns - 1) * group.gap.x + 1.3}" height="${(group.rows - 1) * group.gap.y + 1.3}" rx=".4" fill="${group.color}" fill-opacity=".08" stroke="${group.color}" stroke-opacity=".35" stroke-width=".035" stroke-dasharray=".12 .12"/><text x="${group.origin.x}" y="${group.origin.y + (group.rows - 1) * group.gap.y + 1.15}" fill="#6f7871" font-size=".4" font-family="sans-serif">${escape(group.label)} · ${group.rows * group.columns} 人</text>`).join('')}</g>
    <g id="coverage"></g><g id="density"></g><g id="walls"></g><g id="exits"></g><g id="traces"></g><g id="ghosts"></g><g id="causalUnder" pointer-events="none"></g><g id="people"></g><g id="sight"></g><g id="tools"></g><g id="causalLabels" pointer-events="none"></g><g id="guide" pointer-events="none"></g>`;
  }

  private layer(id: string) { return this.svg.querySelector<SVGGElement>(`#${id}`)!; }
  private point(event: PointerEvent): Vec {
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return { x: 14, y: 9 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
  }
  private cone(sign: Design['signs'][number], walls: Snapshot['scene']['walls']) {
    const key = JSON.stringify({ sign, walls });
    if (this.coneCache.has(key)) return this.coneCache.get(key)!;
    const normal = Math.atan2(sign.normal.y, sign.normal.x);
    const points = [sign.position];
    for (let degrees = -65; degrees <= 65; degrees += 2) {
      const angle = normal + degrees * Math.PI / 180;
      const point = (d: number) => add(sign.position, { x: Math.cos(angle) * d, y: Math.sin(angle) * d });
      let low = 0, high = sign.range;
      if (segmentClear(sign.position, point(high), walls)) low = high;
      else for (let i = 0; i < 12; i++) {
        const mid = (low + high) / 2;
        if (segmentClear(sign.position, point(mid), walls)) low = mid; else high = mid;
      }
      points.push(point(low));
    }
    const result = points.map(p => `${p.x},${p.y}`).join(' ');
    this.coneCache.set(key, result);
    if (this.coneCache.size > 20) this.coneCache.delete(this.coneCache.keys().next().value!);
    return result;
  }
  private trace(run: Run, selected: number, time: number) {
    const points: string[] = [];
    for (let i = 0; i < run.frames.length && run.frames[i].time <= time; i += 3) {
      const person = run.frames[i].agents.find(a => a.id === selected)!;
      points.push(`${person.x},${person.y}`);
      if (person.arrived) break;
    }
    return points.join(' ');
  }

  render(state: StageState) {
    const focused = document.activeElement as Element | null;
    const focusedSign = focused?.closest<SVGElement>('[data-sign]')?.dataset.sign;
    const focusedPerson = focused?.closest<SVGElement>('[data-person]')?.dataset.person;
    const focusedBarrier = !!focused?.closest('[data-barrier]');
    this.state = state;
    const scene = this.snapshot.scene;
    const walls = designWalls(scene, state.design);
    const frame: Frame = state.run && !state.editing ? frameAt(state.run, state.time) : {
      time: 0, agents: this.snapshot.agents.map(a => ({ id: a.id, ...a.position, vx: 0, vy: 0, hx: 0, hy: -1,
        exit: a.knowsA ? 'A' : 'B', knowsA: a.knowsA, knowsB: a.knowsB, arrived: false, queued: false })),
    };
    const selectedAgent = frame.agents.find(a => a.id === state.selected);
    const causal = state.causality&&state.run&&!state.editing?mapEvidence(this.snapshot,state.run,state.time):null;
    if (state.follow && selectedAgent) {
      const width = 11.84, height = 8.92;
      this.svg.setAttribute('viewBox', `${clamp(selectedAgent.x - width / 2, -.8, 28.8 - width)} ${clamp(selectedAgent.y - height / 2, -3.2, 19.1 - height)} ${width} ${height}`);
    } else this.svg.setAttribute('viewBox', '-0.8 -3.2 29.6 22.3');
    const scale=Math.min(this.svg.clientWidth/this.svg.viewBox.baseVal.width,this.svg.clientHeight/this.svg.viewBox.baseVal.height);
    const mapFont=Math.max(.46,10/Math.max(1,scale));
    this.svg.classList.toggle('placing', state.placing !== null);
    this.layer('walls').innerHTML = scene.walls.map(wall => `<rect x="${wall.x}" y="${wall.y}" width="${wall.w}" height="${wall.h}" rx=".035" fill="#343b37"/><rect x="${wall.x}" y="${wall.y}" width="${wall.w}" height=".07" fill="#57605a"/>`).join('');
    this.layer('exits').innerHTML = (['A', 'B'] as const).map(id => {
      const exit=scene.exits[id],gate=causal?.gates.find(g=>g.id===id);
      const count=frame.agents.filter(a=>a.exit===id&&a.arrived).length;
      const waiting=frame.agents.filter(a=>a.exit===id&&a.queued&&!a.arrived).length;
      const width=Math.max(5.4,mapFont*9.7),center=clamp(exit.x,width/2-.6,scene.width+.6-width/2);
      const first=-2.95+mapFont*1.05+.1,second=first+mapFont*1.15,third=second+mapFont*1.15;
      const showClock=!!gate&&!!exit.interval&&this.svg.clientWidth>=500;
      return `<path d="M ${exit.x-exit.width/2} .32 H ${exit.x+exit.width/2}" fill="none" stroke="${gate?.pulse?'#3e9e86':waiting?'#d69d5f':'#67a991'}" stroke-width="${gate?.pulse?.18+gate.pulse*.2:.2}"/><g><path d="M ${exit.x} .25 V -.23 H ${center}" fill="none" stroke="#7b8980" stroke-width=".04"/><rect x="${center-width/2}" y="-2.95" width="${width}" height="2.6" rx=".1" fill="#343b37"/><text x="${center}" y="${first}" text-anchor="middle" font-size="${mapFont*1.05}" fill="#f5f3e8" font-family="sans-serif">${id} · ${state.editing?'出口':`${count}人通过${waiting?` / 等${waiting}`:''}`}</text><text x="${center}" y="${second}" text-anchor="middle" font-size="${mapFont}" fill="#d9e6d9" font-family="sans-serif">${exit.interval?`${exit.interval.toFixed(1)} 秒 / 人`:'连续通行'}</text>${showClock?`<text x="${center}" y="${third}" text-anchor="middle" font-size="${mapFont*.95}" fill="#edc793" font-family="sans-serif">${gate.readyIn>.05?`还需 ${gate.readyIn.toFixed(1)} 秒`:'可再次放行'}</text>`:''}${gate?`<rect x="${center-width/2+.2}" y="-.55" width="${width-.4}" height=".1" fill="#69746c"/><rect x="${center-width/2+.2}" y="-.55" width="${(width-.4)*gate.progress}" height=".1" fill="${gate.readyIn>0?'#e7aa65':'#7bc7ac'}"/>`:''}</g>`;
    }).join('');
    this.layer('coverage').innerHTML = state.coverage ? state.design.signs.map(sign => {
      const active = state.editing || (state.time >= sign.from && state.time < sign.until);
      return `<polygon points="${this.cone(sign, walls)}" fill="${sign.target === 'B' ? '#5d99e0' : '#ba98da'}" fill-opacity="${active ? '.13' : '.025'}" stroke="#6c9db5" stroke-opacity=".25" stroke-width=".025"/>`;
    }).join('') : '';
    this.layer('density').innerHTML = state.density && state.run && !state.editing ? this.density(state.run, state.time) : '';
    this.layer('ghosts').innerHTML = state.compare && state.baseline && state.run && !state.editing ? frameAt(state.baseline, state.time).agents.filter(a => !a.arrived)
      .map(a => `<circle cx="${a.x}" cy="${a.y}" r=".23" fill="none" stroke="#9aa8a0" stroke-width=".035" stroke-dasharray=".08 .06" opacity=".7"/>`).join('') : '';
    const collective = state.overview && state.run ? this.snapshot.agents.map(a => {
      const color = this.level.groups.find(g => g.id === a.cohort)!.color;
      return `<polyline points="${this.trace(state.run!, a.id, state.time)}" fill="none" stroke="${color}" stroke-width=".045" opacity=".35"/>${state.compare && state.baseline ? `<polyline points="${this.trace(state.baseline, a.id, state.time)}" fill="none" stroke="#a4aea3" stroke-width=".025" stroke-dasharray=".15 .16" opacity=".16"/>` : ''}`;
    }).join('') : '';
    this.layer('traces').innerHTML = state.run && !state.editing ? `${collective}<polyline points="${this.trace(state.run, state.selected, state.time)}" fill="none" stroke="#2b6a61" stroke-width=".075" opacity=".8"/>${state.compare && state.baseline ? `<polyline points="${this.trace(state.baseline, state.selected, state.time)}" fill="none" stroke="#97a89c" stroke-width=".055" stroke-dasharray=".2 .15"/>` : ''}` : '';
    this.layer('people').innerHTML = frame.agents.filter(a => !a.arrived).map(a => {
      const seed = this.snapshot.agents.find(s => s.id === a.id)!;
      const group = this.level.groups.find(g => g.id === seed.cohort)!;
      const learned = (a.knowsA && !seed.knowsA) || (a.knowsB && !seed.knowsB);
      const chosen = a.id === state.selected && !state.editing;
      const angle = Math.atan2(a.vy, a.vx);
      return `<g data-person="${a.id}" role="button" tabindex="0" aria-label="查看第 ${pad(a.id)} 号，${escape(group.label)}，目标 ${a.exit}" class="person-mark"><circle cx="${a.x}" cy="${a.y}" r=".46" fill="transparent"/><circle cx="${a.x}" cy="${a.y}" r="${chosen ? '.34' : '.235'}" fill="${group.color}" stroke="${chosen ? '#183d36' : '#f9f5e9'}" stroke-width="${chosen ? '.095' : '.045'}"/>${learned ? `<circle cx="${a.x}" cy="${a.y}" r=".31" fill="none" stroke="#427fbf" stroke-width=".045"/>` : ''}${a.queued ? `<circle cx="${a.x}" cy="${a.y}" r=".38" fill="none" stroke="#c38a4a" stroke-width=".04"/>` : ''}<path d="M ${a.x + Math.cos(angle) * .12} ${a.y + Math.sin(angle) * .12} l ${Math.cos(angle) * .13} ${Math.sin(angle) * .13}" stroke="#233f34" stroke-width=".045" stroke-linecap="round"/>${chosen ? `<text x="${a.x + .45}" y="${a.y - .3}" fill="#183e37" font-size=".4" font-weight="700" font-family="sans-serif">${pad(a.id)}</text>` : ''}</g>`;
    }).join('');
    this.layer('tools').innerHTML = state.design.signs.map(sign => {
      const selected = state.tool?.kind === 'sign' && state.tool.id === sign.id && state.editing;
      const active = state.editing || (state.time >= sign.from && state.time < sign.until);
      const angle = Math.atan2(sign.normal.y, sign.normal.x) * 180 / Math.PI;
      return `<g data-sign="${sign.id}" transform="translate(${sign.position.x} ${sign.position.y})" role="button" tabindex="${state.editing ? 0 : -1}" aria-disabled="${!state.editing}" aria-label="导视牌 ${sign.id}，指向 ${sign.target}，方向键移动，R旋转" class="tool-mark ${selected ? 'selected' : ''}" opacity="${active ? 1 : .45}">${selected ? '<circle r=".82" fill="none" stroke="#427fbf" stroke-width=".04" stroke-dasharray=".1 .1"/>' : ''}<circle r=".72" fill="#376fc5" opacity=".09"/><rect x="-.56" y="-.34" width="1.12" height=".68" rx=".12" fill="${sign.target === 'B' ? '#3976ba' : '#8665a7'}" stroke="#faf8f0" stroke-width=".06"/><text x="0" y=".16" text-anchor="middle" fill="#fff" font-size=".48" font-weight="700" font-family="sans-serif">${sign.target}</text><path d="M .59 -.25 V .25" transform="rotate(${angle})" fill="none" stroke="#c2edff" stroke-width=".13" stroke-linecap="round"/><title>正面朝向决定谁能读到；${sign.from} 至 ${sign.until} 秒启用</title></g>`;
    }).join('') + (state.design.barrier ? (() => {
      const rect = barrierRect(state.design.barrier);
      return `<g data-barrier="true" role="button" tabindex="${state.editing ? 0 : -1}" aria-disabled="${!state.editing}" aria-label="导流栏，方向键移动，R旋转" class="tool-mark"><rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx=".1" fill="#bd8b51" stroke="${state.tool?.kind === 'barrier' ? '#244d42' : '#fff5df'}" stroke-width=".08"/><circle cx="${state.design.barrier.position.x}" cy="${state.design.barrier.position.y}" r=".25" fill="#efd8b3"/></g>`;
    })() : '');
    this.layer('sight').innerHTML = selectedAgent && !selectedAgent.arrived && !state.editing
      ? state.design.signs.map(sign => {
        const condition = readability(selectedAgent, { x: selectedAgent.hx, y: selectedAgent.hy }, sign, walls, frame.time);
        return `<line x1="${selectedAgent.x}" y1="${selectedAgent.y}" x2="${sign.position.x}" y2="${sign.position.y}" stroke="${condition.reason === 'readable' ? '#4685b1' : '#b37e57'}" stroke-width=".035" stroke-dasharray=".12 .12" opacity=".6" pointer-events="none"/>`;
      }).join('') : '';
    this.layer('causalUnder').innerHTML = causal ? causal.reads.slice(-6).map(signal=>{
      const sign=state.run!.design.signs.find(s=>s.id===signal.signId)!;
      const strength=1-signal.age/READING_WINDOW,color=signal.exit==='B'?'#327dc1':'#8965ae';
      return `<line x1="${sign.position.x}" y1="${sign.position.y}" x2="${signal.point.x}" y2="${signal.point.y}" stroke="${color}" stroke-width=".07" opacity="${.35+.5*strength}"/><circle cx="${signal.point.x}" cy="${signal.point.y}" r="${.35+signal.age*.6}" fill="none" stroke="${color}" stroke-width=".07" opacity="${strength}"/>`;
    }).join('')+causal.gates.filter(g=>g.pulse>0&&g.lastPassPosition).map(g=>`<circle cx="${g.lastPassPosition!.x}" cy="${g.lastPassPosition!.y}" r="${.45+(1-g.pulse)*.4}" fill="#63b49c" fill-opacity="${g.pulse*.2}" stroke="#438b77" stroke-opacity="${g.pulse*.8}" stroke-width=".09"/>`).join('')+causal.gates.flatMap(g=>g.slowIds).map(id=>{
      const person=frame.agents.find(a=>a.id===id)!;
      return `<circle cx="${person.x}" cy="${person.y}" r=".42" fill="#d6984420" stroke="#c08a43" stroke-width=".035"/>`;
    }).join('') : '';
    this.layer('causalLabels').innerHTML = causal ? state.run!.design.signs.map(sign=>{
      const count=causal.reads.filter(r=>r.signId===sign.id).length;if(!count)return '';
      const font=Math.max(.6,mapFont),width=Math.max(5.8,font*8.7);
      const x=clamp(sign.position.x,width/2-.6,scene.width+.6-width/2),y=clamp(sign.position.y+1,1.2,16.6);
      return `<g><rect x="${x-width/2}" y="${y-.55}" width="${width}" height="1.1" rx=".08" fill="#f7fbff" stroke="#8bb2d2" stroke-width=".04"/><text x="${x}" y="${y+.22}" text-anchor="middle" fill="#2e6291" font-size="${font}" font-family="sans-serif">刚读到${sign.target}：${count}人</text><title>近${READING_WINDOW}秒内真实读取事件；最多显示最近6条连线</title></g>`;
    }).join('') : '';
    this.layer('guide').innerHTML = state.guide ? this.guideMarkup(state.guide) : '';
    const focusSelector = focusedSign ? `[data-sign="${focusedSign}"]` : focusedBarrier ? '[data-barrier]' : focusedPerson ? `[data-person="${focusedPerson}"]` : '';
    if (focusSelector) this.svg.querySelector<SVGElement>(focusSelector)?.focus({ preventScroll: true });
  }

  private guideMarkup(guide: Guidance) {
    const wall = this.snapshot.scene.walls.find(w => w.id === guide.map.wallId);
    const point = guide.map.exit ? { x: this.snapshot.scene.exits[guide.map.exit].x, y: 2.1 } : guide.map.point;
    const x = clamp(point.x + 3.8, 3.2, 24.8), y = clamp(point.y + .55, 2.2, 16);
    const label = guide.map.exit ? guide.map.label : `第 ${guide.agentId} 号 · 上轮 ${guide.time.toFixed(1)} 秒`;
    return `<polyline points="${guide.map.path.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#b87932" stroke-width=".09" stroke-dasharray=".18 .11" opacity=".85"/>${wall ? `<rect x="${wall.x - .08}" y="${wall.y - .08}" width="${wall.w + .16}" height="${wall.h + .16}" rx=".08" fill="none" stroke="#c08438" stroke-width=".12"/><text x="${wall.x + wall.w / 2}" y="${wall.y + wall.h + .55}" text-anchor="middle" fill="#895819" font-size=".4" font-family="sans-serif">上轮的遮挡墙</text>` : ''}${guide.map.sign ? `<line x1="${guide.map.point.x}" y1="${guide.map.point.y}" x2="${guide.map.sign.x}" y2="${guide.map.sign.y}" stroke="#ba7a30" stroke-width=".06" stroke-dasharray=".1 .11"/><circle cx="${guide.map.sign.x}" cy="${guide.map.sign.y}" r=".65" fill="none" stroke="#b87932" stroke-width=".06" stroke-dasharray=".13 .1"/>` : ''}<circle cx="${point.x}" cy="${point.y}" r=".58" fill="#f7e7c9" fill-opacity=".6" stroke="#ae6f25" stroke-width=".07"/><rect x="${x - 3.1}" y="${y - .52}" width="6.2" height=".9" rx=".15" fill="#fff4dd" stroke="#cda164" stroke-width=".035"/><text x="${x}" y="${y + .04}" text-anchor="middle" fill="#7e511d" font-size=".38" font-weight="600" font-family="sans-serif">${escape(label)}</text>`;
  }

  private density(run: Run, time: number) {
    const counts = new Map<string, number>();
    const tick = clamp(Math.floor(time * 10), 0, run.frames.length - 1);
    const from = Math.max(0, tick - 19);
    const samples = tick - from + 1;
    for (let i = from; i <= tick; i++) for (const person of run.frames[i].agents) if (!person.arrived) {
      const key = `${Math.floor(person.x)},${Math.floor(person.y)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1 / samples);
    }
    return [...counts].filter(([, count]) => count > .8).map(([key, count]) => {
      const [x, y] = key.split(',').map(Number);
      return `<rect x="${x}" y="${y}" width="1" height="1" rx=".12" fill="#d69d5e" opacity="${Math.min(.5, (count - .5) * .13)}"/>`;
    }).join('');
  }
}
