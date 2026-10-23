import { clamp } from './core/geometry';
import { makeSign, MODEL, MAX_TIME } from './core/scene';
import { frameAt } from './core/simulation';
import type { DecisionEvent, Design, Run, Snapshot } from './core/types';
import { LEVELS, levelById, levelSnapshot, type Level } from './game/content';
import { completed, evaluate, validateLevelDesign, type GoalResult, type MetricId } from './game/evaluation';
import { diagnose, observationAt, observationCopy, type Evidence } from './game/evidence';
import { appendAttempt, buildReport, CHECKPOINT_KEY, copyLegacy, decodeImport, decodeProgress, encodeDesign, encodeCampaign, readProgress, writeProgress,
  LEGACY_KEY, type CampaignProgress, type LegacyExperiment, type Session } from './game/storage';
import type { SimulationRequest, SimulationResponse, Verification } from './game/worker';
import { element as el, escape as esc, number as n, pad } from './ui/format';
import { Stage, type SelectedTool } from './ui/stage';
import { Sound } from './ui/sound';
import { template } from './ui/template';
import { arrivalChart } from './ui/arrivals';
import { chapterMap } from './ui/chapter-map';
import { createGuidance, compareTrials, designChanges, variableName, type Guidance, type TrialComparison } from './game/guidance';
import { compareSchemes, explainMetric, summaryMetrics, type MetricExplanation } from './game/interpretation';
import { createInquiry, observeInquiry, inquiryRows, inquiryMetrics, inquiryMatches, inquiryLabels, predictionLabels, type Prediction, type InquiryMetric } from './game/inquiry';
import { nextMapObservation } from './game/map-evidence';
import SimulationWorker from './game/worker.ts?worker&inline';

type Phase = 'edit' | 'play' | 'review';
type Success = Extract<SimulationResponse, { type: 'result' | 'verified' }>;
const root = document.querySelector<HTMLDivElement>('#app')!;
const audio = new Sound();
const loadedProgress = readProgress(() => localStorage);
let progress: CampaignProgress = loadedProgress.progress;
let storageError = loadedProgress.error;
let storagePaused = loadedProgress.blocked;
const storageNotice = loadedProgress.notice;
let importReadId = 0;
let level: Level = LEVELS[0];
let snapshot: Snapshot = levelSnapshot(level);
let design: Design = structuredClone(level.baseline);
let baseline: Run | null = null;
let candidate: Run | null = null;
let phase: Phase = 'edit';
let home = true;
let busy = false;
let playing = false;
let time = 0;
let speed = 3;
let selected = 1;
let tool: SelectedTool = { kind: 'sign', id: 1 };
let placing: 'sign' | 'barrier' | null = null;
let compare = true;
let coverage = true;
let density = false;
let causality = true;
let follow = false;
let undoDesigns: Design[] = [];
let redoDesigns: Design[] = [];
let editStart: Design | null = null;
let batchSerial = 0;
let baselineMode = false;
let side: 'review' | 'goals' | 'person' = 'review';
let personMode: 'now' | 'signs' | 'events' | 'compare' = 'now';
let personEventPage = 0;
let observedSign = 1;
let goalPage = 0;
let historyPage = 0;
let proofPage = 0;
let mobilePanelOpen = false;
let lastDesignError = '';
let goals: GoalResult[] = [];
let evidence: Evidence | null = null;
let guidance: Guidance | null = null;
let guideOpen = false;
let guideDismissed = false;
let guideAnswerOpen = false;
let inquiryProposal: { design: Design; source: 'current'|'transfer'; reference: Run; label: string } | null = null;
let inquiryPage: 'predict'|'result'|'reflect' = 'predict';
let viewedInquiryId: number|null = null;
let armedInquiryId: number|null = null;
let freshInquiryId: number|null = null;
let trialComparison: TrialComparison | null = null;
let metricExplanation: MetricExplanation | null = null;
let metricPage = 0;
let comparedScheme: { index: number; originalSeed: number; run: Run } | null = null;
let comparisonPage = 0;
let transferSource: { levelId: string; index: number; seed: number } | null = null;
let verification: Verification[] = [];
let importedLegacy: LegacyExperiment | null = null;
let lastTick = -1;
let inspectorKey = '';
let notifyTimer = 0;
let requestId = 0;
let operationId = 0;
let pending: { id: number; resolve: (data: Success) => void; reject: (error: Error) => void } | null = null;
let worker: Worker | null = null;
let saveTimer = 0;
const motionReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clone = <T,>(value: T): T => structuredClone(value);

function createWorker() {
  const instance = new SimulationWorker();
  instance.onmessage = (event: MessageEvent<SimulationResponse>) => {
    const response = event.data;
    if (response.id !== pending?.id) return;
    if (response.type === 'progress') {
      el('calculationPhase').textContent = response.phase;
      el('calculationTime').textContent = response.simulatedTime >= MAX_TIME ? '推演完成' : `已推演至 ${n(response.simulatedTime)} 秒`;
    } else if (response.type === 'error') { const reject = pending.reject; pending = null; reject(new Error(response.message)); }
    else { const resolve = pending.resolve; pending = null; resolve(response); }
  };
  instance.onerror = event => {
    if(worker!==instance)return;
    const request=pending;pending=null;instance.terminate();worker=null;
    request?.reject(new Error(event.message || '推演线程未能运行，可重新尝试'));
  };
  return instance;
}
function calculate(type: SimulationRequest['type'], seed = snapshot.seed, proposal = design): Promise<Success> {
  cancelCalculation();
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending = { id, resolve, reject };
    try {
      worker ??= createWorker();
      worker.postMessage({ id, type, levelId: level.id, seed, design: clone(proposal) } satisfies SimulationRequest);
    } catch(error) {pending=null;worker?.terminate();worker=null;reject(error instanceof Error?error:new Error('推演线程无法启动'));}
  });
}
function cancelCalculation() {
  if (!pending) return;
  const reject = pending.reject;
  pending = null;
  worker?.terminate(); worker = null;
  reject(new Error('推演已取消，当前设计保留'));
}

root.innerHTML = template(MODEL);
const stage = new Stage(document.getElementById('stage')! as unknown as SVGSVGElement);
const activeRun = () => baselineMode ? baseline : candidate;
const duration = () => baselineMode ? baseline?.duration ?? 1 : Math.max(baseline?.duration ?? 0, candidate?.duration ?? 0, 1);
const actor = () => activeRun() ? frameAt(activeRun()!, time).agents.find(a => a.id === selected) : null;
const directHelp = () => LEVELS.indexOf(level)===0 || guideAnswerOpen;
const currentSession = (): Session => ({ levelId: level.id, seed: snapshot.seed, design: clone(design), selected,
  time: Math.min(time, MAX_TIME), review: candidate !== null && phase !== 'edit' && !baselineMode });

function notify(message: string, error = false) {
  clearTimeout(notifyTimer);
  el('toast').textContent = message;
  el('toast').className = `toast visible ${error ? 'error' : ''}`;
  notifyTimer = window.setTimeout(() => el('toast').classList.remove('visible'), error ? 6500 : 3500);
}
function captureProgress() {
  if (!home) { validateLevelDesign(level, snapshot, design); progress.activeLevel = level.id; progress.session = currentSession(); progress.chapters[level.id].draft = clone(design); }
}
function persist(manual = false) {
  captureProgress();
  writeProgress(() => localStorage, progress, { checkpoint: manual, blocked: storagePaused });
}
function scheduleSave() {
  clearTimeout(saveTimer);
  if(storagePaused)return;
  saveTimer = window.setTimeout(() => { try { persist(); } catch (error) { storagePaused=true;refreshChrome();notify(error instanceof Error ? error.message : '本机保存不可用，可另存进度', true); } }, 350);
}
function renderHome() {
  const done = LEVELS.filter(l => progress.chapters[l.id].solved).length;
  el('campaignCount').textContent = `${done} / 4 已达成`;
  el('beginButton').innerHTML = done === 4 ? '再看一次四个问题 <span>→</span>' : '从第一课开始 <span>→</span>';
  el('continueButton').hidden = progress.session === null;
  el('chapterCards').innerHTML = LEVELS.map(l => {
    const chapter = progress.chapters[l.id];
    return `<button class="chapter-card ${chapter.solved ? 'solved' : ''}" data-level="${l.id}"><span class="card-top"><span class="card-number">${l.number}</span><span class="chapter-status">${chapter.solved ? '✓ 已达成' : chapter.attempts.length ? `${chapter.attempts.at(-1)!.index} 次尝试` : '一个新的问题'}</span></span>${chapterMap(l)}<h3>${l.title}</h3><strong>${l.subtitle}</strong><p>${l.question}</p><span class="card-bottom">${l.tools} 份干预预算 <span>↗</span></span></button>`;
  }).join('');
  el('campaignReflection').hidden = done !== LEVELS.length;
  el('reflectionButton').hidden=done!==LEVELS.length;
  if (done === LEVELS.length) {
    const attempts = LEVELS.reduce((sum, l) => sum + (progress.chapters[l.id].attempts.at(-1)?.index ?? 0), 0);
    el('campaignReflection').innerHTML = `<p class="eyebrow">你留下的四份答案 · ${attempts} 次推演</p><h2>从引导一群人，到看见每个人。</h2><p>道路、消息、等待与相遇，组成了这四次设计。它们在各自初态下成立；换一批人，新的问题还会出现。</p><div class="reflection-cards">${LEVELS.map(l => {
      const first = progress.chapters[l.id].attempts.find(a => a.passed && a.rule === progress.chapters[l.id].rule)!;
      return `<button data-achievement="${l.id}"><span>${l.number} / ${l.title}</span><b>${l.insight}</b><small>首次达成 · 平均 ${n(first.mean)} 秒 · 最后 ${n(first.tail)} 秒</small><i>重看这份方案 ↗</i></button>`;
    }).join('')}</div>`;
  }
  try { el('legacyButton').hidden = localStorage.getItem(LEGACY_KEY) === null; } catch { el('legacyButton').hidden = true; }
}
function refreshChrome() {
  el('homeScreen').hidden = !home; el('gameScreen').hidden = home;
  el('headerCaption').textContent = home ? '信息 / 空间 / 群体' : `${level.number} / ${level.title}`;
  el('headerCaption').hidden = !home;
  el<HTMLButtonElement>('exportButton').disabled = busy;
  el('exportButton').textContent = home?'导出四课进度 ↗':'导出本课方案 ↗';
  el('exportButton').setAttribute('aria-label',home?'导出四课进度':'导出方案');
  el('importButton').textContent='导入方案或进度';el('importButton').setAttribute('aria-label','导入方案');
  el('saveButton').textContent=storagePaused?(innerWidth<700?'另存':'另存进度'):(innerWidth<700?'保存':'保存进度');el('saveButton').setAttribute('aria-label',storagePaused?'另存当前试玩进度':'保存进度');
  el('soundButton').innerHTML = `♪ <span>声音${progress.sound ? '开' : '关'}</span>`;
  el('soundButton').setAttribute('aria-pressed', String(progress.sound));
  el('soundButton').setAttribute('aria-label', progress.sound ? '关闭声音' : '开启声音');
}
function renderHeader() {
  el('chapterNumber').textContent = level.number; el('chapterSubtitle').textContent = level.subtitle;
  el('chapterTitle').textContent = level.title; el('chapterQuestion').textContent = level.question;
  el('seedLabel').textContent = `同一初态 ${snapshot.seed} · ${snapshot.agents.length} 人`;
  el('transferButton').textContent = freshInquiryId && phase!=='edit' ? '预测对照 ↗' : LEVELS.indexOf(level) ? '预测与迁移 ↗' : '学习线索 ↗';
  el('chapterNavigation').innerHTML = LEVELS.map(l => `<button data-level="${l.id}" class="${l.id === level.id ? 'active' : ''}" aria-label="进入第 ${l.number} 课 ${l.title}">${l.number}<span>${l.title}</span>${progress.chapters[l.id].solved ? '<i>✓</i>' : ''}</button>`).join('');
  el('boardLegend').innerHTML = level.groups.map(g => `<span><i style="background:${g.color}"></i>${g.label}</span>`).join('') + '<span><i class="information-ring"></i>得到新信息</span><span><i class="waiting-ring"></i>门前等待</span><span class="legend-extra">虚线与空心圆为原始运行。蓝线是实际读牌，绿色门口脉冲是实际放行，门闸条从放行记录恢复；淡橙晕为附近低速，不是排队总数。</span>';
}
function renderAction() {
  const used = design.signs.length + (design.barrier ? 1 : 0);
  el('budgetBadge').textContent = `${used} / ${level.tools} 份预算`;
  el('budgetBadge').hidden = phase !== 'edit';
  el('actionHeading').hidden = phase === 'play';
  el('actionKicker').textContent = busy ? '按同一组规则推演' : phase === 'edit' ? '调整导视与通路' : baselineMode ? '原始布局 · 建立你的判断' : phase === 'play' ? '正在回放方案' : completed(goals) ? '全部目标达成' : '仍有目标未达成';
  if (phase === 'edit') {
    el('primaryAction').innerHTML = `<button class="primary-button full" data-action="run" ${busy ? 'disabled' : ''}>推演我的方案 <span>→</span></button>`;
    el('secondaryActions').innerHTML = `<button class="quiet-button" data-action="watch-baseline" ${busy || !baseline ? 'disabled' : ''}>先观察原始布局</button><button class="quiet-button" data-action="reset" ${busy ? 'disabled' : ''}>重置设计</button>`;
  } else {
    el('primaryAction').innerHTML = `<button class="primary-button full" data-action="edit" ${busy ? 'disabled' : ''}>${phase === 'play' ? '暂停并回到设计' : baselineMode ? '开始我的设计' : completed(goals) ? '继续改进这个方案' : guidance && directHelp() ? `先只改${variableName[guidance.variable]}，再试一次` : '调整方案，再次检验'} <span>↗</span></button>`;
    const next = LEVELS[LEVELS.indexOf(level) + 1];
    el('secondaryActions').innerHTML = `<button class="quiet-button" data-action="verify" ${busy || !candidate || baselineMode || phase !== 'review' ? 'disabled' : ''}>换一批人复核</button>${next ? `<button class="quiet-button" data-level="${next.id}" ${busy ? 'disabled' : ''}>下一课 · ${next.title} →</button>` : '<button class="quiet-button" data-action="home">回看我的四份方案 →</button>'}`;
  }
  el('calculationOverlay').hidden = !busy;
  renderGuidance();
  el('stageInstruction').textContent = busy ? '' : placing ? `点击地面，放置${placing === 'sign' ? '导视牌' : '导流栏'}` : phase === 'edit' ? guideOpen && guidance && !guideDismissed ? directHelp() ? `橙色为上轮证据 · 先只改${variableName[guidance.variable]}，其他条件保持不变` : '橙色是上轮证据 · 先提出判断，再调整布局检验；可主动展开建议' : '拖动工具改变位置 · 发光一侧是标识正面 · R 旋转' : baselineMode ? '这是原始运行。点选一个人，观察他的经历。' : '蓝线为实际读牌 · 出口细条按放行记录恢复 · 点人追查经历';
  el('phaseLabel').textContent = busy ? '计算中' : phase === 'edit' ? '设计中' : baselineMode ? '原始布局' : playing ? '同初态回放中' : phase === 'review' ? '方案复盘' : '已暂停';
  el('phaseLight').className = playing || busy ? 'active' : '';
  el<HTMLButtonElement>('undoButton').disabled = busy || phase !== 'edit' || !undoDesigns.length;
  el<HTMLButtonElement>('redoButton').disabled = busy || phase !== 'edit' || !redoDesigns.length;
  el<HTMLButtonElement>('focusViewButton').disabled = busy || phase === 'edit';
  el('focusViewButton').setAttribute('aria-pressed', String(follow && phase !== 'edit'));
  el('focusViewButton').textContent = follow && phase !== 'edit' ? '↖ 回到全图' : '⊕ 近看这个人';
  el<HTMLButtonElement>('playButton').disabled = phase === 'edit' || busy || !activeRun();
  el('playButton').textContent = playing ? 'Ⅱ' : '▶';
  el('playButton').setAttribute('aria-label', playing ? '暂停回放' : '播放回放');
  el<HTMLInputElement>('timeline').disabled = phase === 'edit' || busy || !activeRun();
  el<HTMLInputElement>('timeline').max = String(duration());
  el<HTMLButtonElement>('resultButton').disabled = phase === 'edit' || busy || !activeRun();
  el('gameScreen').classList.toggle('panel-open',mobilePanelOpen);
  el<HTMLButtonElement>('arrivalButton').disabled=busy || phase!=='review' || !candidate || baselineMode;
  el<HTMLButtonElement>('compareSchemesButton').disabled = busy || phase !== 'review' || !candidate || baselineMode;
  el<HTMLButtonElement>('transferButton').disabled = busy;
  const observedRun=activeRun();
  el('mapObserveControls').hidden=busy||phase==='edit'||!observedRun||!observedRun.events.some(e=>e.type==='learn'||e.type==='queue');
  el<HTMLButtonElement>('observeLearn').disabled=!observedRun?.events.some(e=>e.type==='learn');
  el<HTMLButtonElement>('observeQueue').disabled=!observedRun?.events.some(e=>e.type==='queue');
  const mobile=el<HTMLButtonElement>('mobilePrimary');mobile.disabled=busy;mobile.dataset.action=phase==='edit'?'run':phase==='play'?'result':'edit';
  mobile.textContent=phase==='edit'?'推演我的方案 →':phase==='play'?'直接看结果 →':'再设计一次 ↗';
  el('panelToggle').textContent=phase==='edit'?'工具与目标 ↑':'目标与个体 ↑';
  root.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(button => button.classList.toggle('active', button.dataset.side === side));
}
function renderGuidance() {
  const shown = guidance && !busy && !baselineMode && phase !== 'play';
  el('guideAction').hidden = !shown;
  if (!shown || !guidance) return;
  if (guideDismissed) { el('guideAction').innerHTML = `<button class='quiet-button' data-action='guide-show'>显示上轮线索 ↗</button>`; return; }
  if(!directHelp()){
    const witness=guidance.map.exit?`追查 ${guidance.map.exit} 门等候`:'查看这次信息错过';
    el('guideAction').innerHTML=`<article class='next-trial'><div><b>先看证据，再作判断</b><button data-action='guide-dismiss' aria-label='收起试验提示'>×</button></div><p>${esc(guidance.title)}</p><div class='guide-links'><button data-action='evidence'>${witness} ↗</button><button data-action='guide-details'>展开修订建议 ↗</button></div></article>`;
    return;
  }
  const prompt = guidance.experiment.split('。')[0] + '。';
  const changes = designChanges(guidance.sourceDesign, design);
  el('guideAction').innerHTML = `<article class='next-trial'><div><b>只改 ${guidance.signId} 号牌 · ${variableName[guidance.variable]}</b><button data-action='guide-dismiss' aria-label='收起试验提示'>×</button></div><p>${esc(prompt)}</p><div class='guide-links'><button data-action='evidence'>地图证据 ↗</button><button data-action='guide-details'>完整提示 ↗</button>${phase === 'edit' && changes.length ? `<span>${changes.length === 1 ? '已改一项，可检验' : `已改 ${changes.length} 项`}</span>` : ''}</div></article>`;
}
function guidanceControlSelector(): string|null {
  if(!guidance)return null;
  return {position:'[data-action=tool-position]',orientation:'[data-action=rotate]',from:'[data-action=tool-timing]',until:'[data-action=tool-timing]',target:'#targetInput',tools:'[data-action=add-sign]'}[guidance.variable];
}

function comparisonMarkup() {
  if (!trialComparison) return '';
  const { changes, before, after } = trialComparison;
  return `<article class="trial-comparison"><p class="eyebrow">同初态 · 和上一次试验比较</p><b>${changes.length === 1 ? `只改了${esc(changes[0])}` : changes.length ? `这次调整了 ${changes.length} 项条件` : '设计保持不变，检验复现'}</b><div><span>获知人数</span><strong>${before.informed} → ${after.informed} 人</strong></div><div><span>平均到达</span><strong>${n(before.mean)} → ${n(after.mean)} 秒</strong></div><div><span>最后一人</span><strong>${n(before.tail)} → ${n(after.tail)} 秒</strong></div>${changes.length > 1 ? '<small>同时改变多项时，不能单独归因给其中一项。</small>' : ''}</article>`;
}
function goalMarkup(list: GoalResult[], result: boolean, inspect = false) {
  return list.map(goal => `<div class="goal-row ${result ? goal.met ? 'met' : 'unmet' : ''}"><span class="goal-icon">${result ? goal.met ? '✓' : '·' : '○'}</span><div><b>${goal.label}</b><p>${result ? `<strong>${n(goal.actual, goal.unit === '人' ? 0 : 1)} ${goal.unit}</strong><span> / </span>` : ''}${goal.unit === '人' ? '至少' : '不超过'} ${n(goal.target, goal.unit === '人' ? 0 : 1)} ${goal.unit}</p></div><button class='goal-help' aria-label='${esc(goal.label)}，${inspect ? '查看个体证据' : '查看计算说明'}' ${inspect ? `data-metric='${goal.id}'` : `data-goal-help='${esc(goal.explanation)}' data-goal-label='${esc(goal.label)}'`}>${inspect ? '↗' : '?'}</button></div>`).join('');
}

function gateRules() {
  return `<div class="gate-rules" aria-label="出口通行规则">${(['A', 'B'] as const).map(id => {
    const exit = snapshot.scene.exits[id];
    return `<span><b>${id}</b><small>${exit.interval ? `${n(exit.interval)} 秒 / 人` : '持续通行'}</small></span>`;
  }).join('')}</div>`;
}

function renderToolEditor() {
  const chosen = tool;
  const sign = chosen?.kind === 'sign' ? design.signs.find(s => s.id === chosen.id) : null;
  const barrier = chosen?.kind === 'barrier' ? design.barrier : null;
  const used = design.signs.length + (design.barrier ? 1 : 0);
  const normal = sign ? sign.normal.x === 1 ? '右' : sign.normal.x === -1 ? '左' : sign.normal.y === 1 ? '下' : '上' : '';
  return `<div class='mini-heading'><h3>我的工具</h3>${sign || barrier ? `<button class='delete-tool' data-action='remove-tool'>移除所选 ×</button>` : `<span>点击地图放置</span>`}</div><div class='tool-list'>${design.signs.map(item => `<button data-select-sign='${item.id}' class='tool-card ${chosen?.kind === 'sign' && chosen.id === item.id ? 'selected' : ''}'><i class='tool-symbol sign-symbol'>${item.target}</i><span>${item.id} 号导视牌</span></button>`).join('')}${design.barrier ? `<button data-action='select-barrier' class='tool-card ${barrier ? 'selected' : ''}'><i class='tool-symbol barrier-symbol'>▰</i><span>导流栏</span></button>` : ''}</div>
  ${used < level.tools ? `<div class='add-tools'><button data-action='add-sign' ${design.signs.length >= level.maxSigns || busy ? 'disabled' : ''}>＋ 导视牌</button>${level.allowBarrier ? `<button data-action='add-barrier' ${design.barrier || busy ? 'disabled' : ''}>＋ 导流栏</button>` : ''}</div>` : ''}
  ${sign || barrier ? `<section class='tool-properties'><div class='orientation-row'><span>${sign ? `正面朝${normal}` : barrier!.vertical ? '竖向放置' : '横向放置'}</span><button class='outline-button small' data-action='rotate'>↻ 旋转 <kbd>R</kbd></button></div>${sign ? `<label class='field-row'>信息指向<select id='targetInput' aria-label='标识目标出口'><option value='A' ${sign.target === 'A' ? 'selected' : ''}>出口 A</option><option value='B' ${sign.target === 'B' ? 'selected' : ''}>出口 B</option></select></label><div class='tool-settings-row'><button class='outline-button' data-action='tool-position'>精确位置 ↗</button><button class='outline-button' data-action='tool-timing'>显示 ${n(sign.from)}—${n(sign.until)} 秒 ↗</button></div>` : `<button class='outline-button full' data-action='tool-position'>精确位置设置 ↗</button>`}</section>` : `<p class='empty-properties'>点击已有工具，或在地图上放置新工具。</p>`}`;
}
function renderToolSettings() {
  const chosen = tool;
  const sign = chosen?.kind === 'sign' ? design.signs.find(s => s.id === chosen.id) : null;
  const subject = sign ?? (chosen?.kind === 'barrier' ? design.barrier : null);
  el('toolDialogTitle').textContent = sign ? `导视牌 ${sign.id} · 精细设置` : '导流栏 · 精细设置';
  el('timingPageButton').hidden = !sign;
  if (!subject) return;
  for (const [id,value] of [['toolX',subject.position.x],['toolY',subject.position.y],['fromInput',sign?.from ?? 0],['untilInput',sign?.until ?? MAX_TIME]] as const) {
    const input = el<HTMLInputElement>(id);
    if (input !== document.activeElement) input.value = n(value);
  }
}
function renderGoals() {
  const list = baseline ? evaluate(level, baseline, candidate ?? baseline) : [];
  const revealed = phase === 'review' && !!candidate && !baselineMode;
  const size = innerHeight < 650 ? 2 : innerHeight < 800 && guidance && !guideDismissed && phase !== 'play' && !baselineMode ? 3 : 4;
  const pages = Math.max(1, Math.ceil(list.length / size)); goalPage = clamp(goalPage,0,pages-1);
  return `<div class='goal-heading'><p class='eyebrow'>同初态 · ${snapshot.agents.length} 人</p><h3>${revealed ? `${goals.filter(g=>g.met).length} / ${goals.length} 项目标达成` : '这轮要检验什么？'}</h3></div><div class='mission-targets'>${list.length ? goalMarkup(list.slice(goalPage*size,(goalPage+1)*size),revealed,revealed) : `<p class='tiny-note'>正在建立原始布局…</p>`}</div>${pages>1 ? `<div class='pagination compact'><button data-action='goal-prev' aria-label='上一页目标'>←</button><span>第 ${goalPage*size+1}–${Math.min((goalPage+1)*size,list.length)} / ${list.length} 项</span><button data-action='goal-next' aria-label='下一页目标'>→</button></div>` : ''}${revealed ? '' : gateRules()}`;
}

function renderReview() {
  if (phase === 'edit') return `<fieldset class='tool-editor' ${busy?'disabled':''}>${renderToolEditor()}</fieldset>`;
  if (baselineMode) return `<div class='baseline-note'><p class='eyebrow'>原始布局</p><h3>这是所有改变之前。</h3><p>观察谁走哪条路，哪里出现等待。点击一个人，查看他的知识与选择。</p><button class='outline-button' data-side='goals'>本课目标 ↗</button></div>`;
  if (!candidate) return `<p class='side-note'>推演后，这里会留下方案结果。</p>`;
  if (phase !== 'review') return `<div class='watch-note'><span class='watch-dot'></span><h3>让选择展开。</h3><p>注意信息在哪里被读到、谁转向另一条路、哪里开始等待。</p><button class='outline-button' data-action='person-tab'>查看一个人的经历 ↗</button></div>`;
  const fingerprint=candidate.fingerprint;
  const inquiry=progress.chapters[level.id].inquiries.find(r=>r.id===freshInquiryId&&r.result?.fingerprint===fingerprint);
  return `${trialComparison ? comparisonMarkup() : ''}${inquiry?`<button class='inquiry-result-link' data-action='inquiry-result'>对照我运行前的预测 ↗</button>`:''}${evidence ? `<article class='evidence-card'><h3>${esc(guidance?.title ?? evidence.title)}</h3>${trialComparison ? '' : `<p>${esc(guidance?.observation ?? evidence.detail)}</p>`}<button data-action='evidence'>回到地图上的那一刻 →</button></article>` : ''}<p class='lesson-note'>${level.insight}</p>`;
}

function eventCopy(event: DecisionEvent) {
  if (event.type === 'learn') return { title: `读到 ${event.learnedExit} 的导视信息`, text: `导视牌 ${event.signId} · 相距 ${n(event.distanceToSign)} 米，正面、视域和无遮挡条件成立。` };
  if (event.type === 'choose' && event.source === 'initial') return { title: `沿已知的 ${event.exit} 出发`, text: '初始知识决定了他此时可以选择的出口。' };
  if (event.type === 'choose') return { title: `改变选择，前往 ${event.exit}`, text: `当时剩余路径 A ${n(event.costA)} 米 / B ${n(event.costB)} 米。` };
  if (event.type === 'queue') return { title: `进入 ${event.exit} 门前等待`, text: '已到达门槛，等待本出口下一次放行。' };
  if (event.type === 'blocked') return { title: '运动受到邻人约束', text: `速度持续较低；实际局部约束涉及 ${event.peers?.map(pad).join('、') ?? '邻近'} 号。` };
  return { title: `通过出口 ${event.exit}`, text: '完成放行，本次通行结束。' };
}
function renderPerson() {
  const initial = snapshot.agents[selected-1], cohort = level.groups.find(g=>g.id===initial.cohort)!;
  const run = phase==='edit' ? null : activeRun();
  const current = run ? frameAt(run,time).agents[selected-1] : null;
  const result = run?.agents[selected-1], original = baseline?.agents[selected-1];
  const events = run?.events.filter(e=>e.agentId===selected && e.time<=time+.001) ?? [];
  const learn = events.find(e=>e.type==='learn'), choosing=events.find(e=>e.type==='choose' && e.source==='sign'), last=events.at(-1);
  let explanation = `我出发时知道 ${[initial.knowsA?'A':'',initial.knowsB?'B':''].filter(Boolean).join(' 和 ')}。`;
  if(last?.type==='arrive') explanation=`我在 ${n(last.time)} 秒通过了 ${last.exit}。${learn?'此前获得过新的导视信息。':'这一路没有获得新的出口信息。'}`;
  else if(current?.queued) explanation=`我已到达 ${current.exit} 门槛，正在等待下一次放行。`;
  else if(choosing) explanation=`我在 ${n(choosing.time)} 秒知道另一条路，比较剩余路程后选择了 ${choosing.exit}。`;
  else if(learn) explanation=`我读到了 ${learn.learnedExit}，但剩余路程没有优势，所以保持原来的选择。`;
  else if(run) explanation+='此刻还没有收到另一出口的信息。';
  const picker=`<div class='person-picker'><span class='person-avatar' style='--person-color:${cohort.color}'>○</span><label>正在查看<select id='personInput' aria-label='选择查看的个体'>${snapshot.agents.map(a=>`<option value='${a.id}' ${a.id===selected?'selected':''}>第 ${pad(a.id)} 号 · ${esc(level.groups.find(g=>g.id===a.cohort)!.label)}</option>`).join('')}</select></label><span class='person-state'>${current?.arrived?'已离开':current?.queued?'等待中':phase==='edit'?'未出发':'通行中'}</span></div><div class='person-subtabs'><button data-person-mode='now' class='${personMode==='now'?'active':''}'>此刻</button><button data-person-mode='signs' class='${personMode==='signs'?'active':''}'>标识</button><button data-person-mode='events' class='${personMode==='events'?'active':''}'>事件 ${events.length}</button><button data-person-mode='compare' class='${personMode==='compare'?'active':''}'>对照</button></div>`;
  if(personMode==='events') {
    const size=2,pages=Math.max(1,Math.ceil(events.length/size)); personEventPage=clamp(personEventPage,0,pages-1);
    return picker+`<ol class='person-events'>${events.slice(personEventPage*size,(personEventPage+1)*size).map(event=>{const copy=eventCopy(event);return `<li class='event-${event.type}'><button data-time='${event.time}'><time>${n(event.time)}s</time><span><b>${copy.title}</b><small>${copy.text}</small></span></button></li>`;}).join('') || `<li class='empty-event'>尚未发生的事件不会提前显示。</li>`}</ol><div class='pagination compact'><button data-action='event-prev'>← 上页</button><span>${personEventPage+1} / ${pages}</span><button data-action='event-next'>下页 →</button></div>`;
  }
  if(personMode==='compare') return picker+(phase==='review' && result ? `<div class='person-comparison'><div><span>到达用时</span><b>${n(original?.arrivalTime)} → ${n(result.arrivalTime)} 秒</b></div><div><span>实际行程</span><b>${n(original?.distance)} → ${n(result.distance)} 米</b></div><div><span>受限耗时</span><b>${n(original?.delay)} → ${n(result.delay)} 秒</b></div><div><span>门前等待</span><b>${n(original?.gateWait)} → ${n(result.gateWait)} 秒</b></div></div><p class='side-note'>左为原始布局，右为本轮完整结果。</p>` : `<p class='side-note'>完整对照在本轮回放结束后揭示。此刻和事件页只读取当前回放时刻。</p>`);
  const knows=current?[current.knowsA?'A':'',current.knowsB?'B':''].filter(Boolean).join(' + '):[initial.knowsA?'A':'',initial.knowsB?'B':''].filter(Boolean).join(' + ');
  const observations=run?observationAt(snapshot,run,selected,time):[];
  if(!observations.some(o=>o.signId===observedSign)) observedSign=observations[0]?.signId??1;
  if(personMode==='signs') return picker+`<div class='person-facts'><div><span>此刻已知</span><b>${knows}</b></div><div><span>时刻</span><b><span id='personClock'>${n(time)}</span> 秒</b></div></div>${observations.length>1?`<label class='observation-picker'>查看标识<select id='observationSign' aria-label='检查哪块标识'>${observations.map(o=>`<option value='${o.signId}' ${o.signId===observedSign?'selected':''}>${o.signId} 号 · ${o.target}</option>`).join('')}</select></label>`:''}<p class='observation-note' id='personObservation'>${observationCopy(observations.filter(o=>o.signId===observedSign))||'此刻没有仍在场的标识读取对象。'}</p>`;
  return picker+`<div class='person-facts'><div><span>此刻已知</span><b>${knows}</b></div><div><span>当前目标</span><b>${current?.exit??(initial.knowsA?'A':'B')}</b></div><div><span>期望步速</span><b>${n(initial.speed,2)} 米/秒</b></div><div><span>回放时刻</span><b><span id='personClock'>${n(time)}</span> 秒</b></div></div><blockquote class='person-quote'>${explanation}</blockquote>${learn?`<button class='evidence-jump' data-time='${learn.time}'>回到获得信息时 · ${n(learn.time)} 秒 ↗</button>`:''}`;
}

function renderSide(force = false) {
  const current = actor();
  const displayed = phase === 'edit' ? null : activeRun();
  const eventCount = displayed?.events.filter(e => e.agentId === selected && e.time <= time + .001).length ?? 0;
  const key = `${phase}:${side}:${selected}:${eventCount}:${current?.arrived}:${current?.queued}:${current?.knowsA}:${current?.knowsB}:${baselineMode}:${personMode}:${personEventPage}:${observedSign}:${goalPage}`;
  const clock = document.getElementById('personClock');
  if (clock) clock.textContent = n(time);
  const observation = document.getElementById('personObservation');
  if (observation && displayed) observation.textContent = observationCopy(observationAt(snapshot, displayed, selected, time).filter(o=>o.signId===observedSign));
  if (!force && (side !== 'person' || key === inspectorKey)) return;
  inspectorKey = key;
  el('sideContent').innerHTML = side === 'person' ? renderPerson() : side === 'goals' ? renderGoals() : renderReview();
  if (phase === 'edit' && guideOpen && guidance && directHelp()) {
    const selector = guidanceControlSelector();
    if(selector)el('sideContent').querySelector(selector)?.classList.add('coach-target');
  }
}
function renderLive() {
  const run = activeRun();
  const frame = run && phase !== 'edit' ? frameAt(run, time) : null;
  const finished = frame?.agents.filter(a => a.arrived).length ?? 0;
  const oldFinished = baseline && phase !== 'edit' ? frameAt(baseline, time).agents.filter(a => a.arrived).length : 0;
  if (phase === 'review' && run && baseline) {
    el('liveStrip').innerHTML=summaryMetrics(level,baseline,run).map(metric=>`<button class='metric-button' data-metric='${metric.id}' aria-label='${metric.id==='all'?'通行人数':metric.label}，查看个体证据' ${baselineMode?'disabled':''}><span>${metric.label}${metric.id==='all'?'':` <small>原始 ${n(metric.baseline,metric.unit==='人'?0:1)}</small>`}</span><strong>${n(metric.actual,metric.unit==='人'?0:1)}<small>${metric.id==='all'?` / ${snapshot.agents.length}`:` ${metric.unit}`}</small></strong></button>`).join('');
  } else el('liveStrip').innerHTML = `<div><span>此刻通过</span><strong>${finished}<small> / ${snapshot.agents.length}</small></strong></div><div><span>原始布局同时刻</span><strong>${oldFinished}<small> 人</small></strong></div><div><span>新获知信息</span><strong>${frame ? frame.agents.filter((a, i) => (a.knowsA && !snapshot.agents[i].knowsA) || (a.knowsB && !snapshot.agents[i].knowsB)).length : 0}<small> 人</small></strong></div><div><span>门前等待</span><strong>${frame?.agents.filter(a => a.queued && !a.arrived).length ?? 0}<small> 人</small></strong></div>`;
}
function renderHistory() {
  const chapter = progress.chapters[level.id], attempts = [...chapter.attempts].reverse();
  const size = innerHeight < 650 ? 4 : 6, pages = Math.max(1,Math.ceil(attempts.length/size)); historyPage=clamp(historyPage,0,pages-1);
  el('historyCount').textContent = `· ${attempts.length} 份`;
  el('historyPageLabel').textContent=`${historyPage+1} / ${pages}`;
  el('historyList').innerHTML=attempts.length?attempts.slice(historyPage*size,(historyPage+1)*size).map(attempt=>`<article class='history-row'><span class='history-index'>${pad(attempt.index)}</span><span class='history-outcome ${attempt.passed && attempt.rule===chapter.rule?'passed':''}'>${attempt.rule!==chapter.rule?'旧目标记录':attempt.passed?'达成目标':'继续改进'}</span><span>均值 <b>${n(attempt.mean)}</b> 秒</span><span>最后 <b>${n(attempt.tail)}</b> 秒</span><small>初态 ${attempt.seed}</small><button data-history='${attempt.index}'>回放 / 沿用 ↗</button></article>`).join(''):`<p class='empty-history'>每一次推演都会留下方案。首次达成和最近的尝试会保留。</p>`;
  el<HTMLDialogElement>('historyDialog').querySelector<HTMLButtonElement>('[data-action=history-prev]')!.disabled=historyPage===0;
  el<HTMLDialogElement>('historyDialog').querySelector<HTMLButtonElement>('[data-action=history-next]')!.disabled=historyPage===pages-1;
}
function openMetric(id: MetricId) {
  if (!candidate || !baseline || baselineMode || phase !== 'review') return;
  metricExplanation = explainMetric(level, snapshot, baseline, candidate, id);
  metricPage = 0; playing = false; renderMetric();
  el<HTMLDialogElement>('metricDialog').showModal();
}
function renderMetric() {
  if (!metricExplanation) return;
  const report = metricExplanation, size = 2;
  const pages = Math.max(1, Math.ceil(report.people.length / size));
  metricPage = clamp(metricPage, 0, pages - 1);
  el('metricTitle').textContent = report.title;
  el('metricSummary').textContent = report.summary;
  el('metricDefinition').textContent = report.definition;
  el('metricPeople').innerHTML = report.people.slice(metricPage * size, (metricPage + 1) * size).map(person => {
    const current = person.current;
    const change = person.delta === null ? '至少一轮未完成' : `${person.delta > .05 ? '更晚' : person.delta < -.05 ? '更早' : '相近'} ${n(Math.abs(person.delta))} 秒`;
    return `<article class='metric-person'><header><b>${pad(person.id)} 号 · ${esc(person.label)}</b><span>${change}</span></header><p>原始 ${n(person.reference.arrivalTime)} / 本轮 ${n(current.arrivalTime)} 秒</p><p>${report.id === 'interaction' ? `实际行程 ${n(current.distance)} 米 / 按本人步速需 ${n(person.freeTravelTime)} 秒` : person.observation ? esc(person.observation) : `新信息 ${current.learnedAt === null ? '未读到' : `${n(current.learnedAt)} 秒读到`} / 目标 ${current.exit}`}</p><footer><span>受限 ${n(current.delay)} 秒，含门槛等待 ${n(current.gateWait)} 秒</span><button data-metric-person='${person.id}'>追到这一步 ↗</button></footer></article>`;
  }).join('');
  el('metricPageLabel').textContent = `${metricPage + 1} / ${pages} 页 · ${report.people.length} 人`;
  root.querySelector<HTMLButtonElement>('[data-action=metric-prev]')!.disabled = metricPage === 0;
  root.querySelector<HTMLButtonElement>('[data-action=metric-next]')!.disabled = metricPage === pages - 1;
}
function inspectMetricPerson(id: number) {
  const person = metricExplanation?.people.find(p => p.id === id);
  if (!person || !candidate) return;
  el<HTMLDialogElement>('metricDialog').close();
  selected = id; time = person.time; playing = false; baselineMode = false; side = 'person'; personMode = 'events';
  if (person.observation) { personMode = 'signs'; observedSign = person.signId ?? 1; }
  personEventPage = Math.max(0, Math.ceil(candidate.events.filter(e => e.agentId === id && e.time <= time + .001).length / 2) - 1);
  mobilePanelOpen = true; renderAll(); scheduleSave();
}
function openComparison() {
  if (!candidate || phase !== 'review' || baselineMode || busy) return;
  el<HTMLDialogElement>('historyDialog').close();
  const attempts = [...progress.chapters[level.id].attempts].reverse();
  const choice = attempts.find(a => designChanges(a.design, candidate!.design).length) ?? attempts[0];
  el<HTMLSelectElement>('comparisonAttempt').innerHTML = attempts.map(a => `<option value='${a.index}' ${a.index === choice?.index ? 'selected' : ''}>方案 ${a.index} · 原记录初态 ${a.seed}${a.rule !== progress.chapters[level.id].rule ? ' · 旧目标' : ''}</option>`).join('');
  el('comparisonStatus').textContent = `两份布局都按当前初态 ${snapshot.seed} 重新推演，原记录的成绩不会直接拿来比较。`;
  comparisonPage = 0; comparedScheme = null; renderComparison();
  el<HTMLDialogElement>('comparisonDialog').showModal();
}
function renderComparison() {
  const ready = !!comparedScheme && !!candidate;
  el<HTMLButtonElement>('compareRun').disabled = busy || !el<HTMLSelectElement>('comparisonAttempt').options.length;
  el('compareRun').textContent = busy ? '正在按同一初态计算…' : '在当前初态比较 →';
  el<HTMLSelectElement>('comparisonAttempt').disabled = busy;
  el('comparisonResult').hidden = !ready;
  el('comparisonNavigation').hidden = !ready;
  el<HTMLButtonElement>('comparisonExport').hidden = !ready;
  el<HTMLButtonElement>('comparisonExport').disabled = busy;
  if (!ready || !comparedScheme || !candidate) return;
  const reference = comparedScheme.run, current = candidate, pair = compareSchemes(reference, current);
  el('comparisonStatus').textContent = `初态 ${snapshot.seed} · 左为方案 ${comparedScheme.index}，右为本轮；参考方案原来记录在初态 ${comparedScheme.originalSeed}。`;
  if (comparisonPage === 0) {
    const rows: [string, number | null, number | null][] = [['完成通行（人）', reference.metrics.completed, current.metrics.completed],
      ['平均到达（秒）', reference.metrics.meanArrival, current.metrics.meanArrival], ['最后到达（秒）', reference.metrics.lastArrival, current.metrics.lastArrival],
      ['平均受限（秒）', reference.metrics.meanDelay, current.metrics.meanDelay]];
    if (level.targets.cohort) {
      rows.push(['慢行组最晚（秒）', reference.metrics.cohorts[level.targets.cohort].tail, current.metrics.cohorts[level.targets.cohort].tail]);
      rows.push(['快行组平均（秒）', reference.metrics.cohorts[level.targets.protectCohort!].mean, current.metrics.cohorts[level.targets.protectCohort!].mean]);
    }
    el('comparisonResult').innerHTML = `<table class='comparison-table'><thead><tr><th>同一批人</th><th>参考方案</th><th>本轮</th></tr></thead><tbody>${rows.map(([label,a,b]) => `<tr><th>${label}</th><td>${n(a, label.includes('人') ? 0 : 1)}</td><td>${n(b, label.includes('人') ? 0 : 1)}</td></tr>`).join('')}</tbody></table><p class='comparison-note'>${pair.benefited} 人更早 / ${pair.harmed} 人更晚 / ${pair.unchanged} 人相近${pair.unresolved ? ` / ${pair.unresolved} 人两轮均未完成` : ''}。先比较取舍，再判断哪份方案更合适。</p>`;
  } else {
    const order = [...pair.people].sort((a,b) => (b.delta ?? Infinity) - (a.delta ?? Infinity) || a.id-b.id);
    const pages = Math.ceil(order.length / 3), index = clamp(comparisonPage - 1, 0, pages - 1);
    comparisonPage = index + 1;
    el('comparisonResult').innerHTML = `<p class='comparison-note'>按本轮增加的用时排序，先看承担代价的人。正值表示更晚。</p>${order.slice(index*3,(index+1)*3).map(person => `<article class='comparison-person'><b>${pad(person.id)} 号</b><span>${n(person.reference.arrivalTime)} / ${n(person.current.arrivalTime)} 秒</span><strong>${person.delta === null ? '未完成' : `${person.delta > 0 ? '+' : ''}${n(person.delta)} 秒`}</strong><button data-comparison-person='${person.id}'>看本轮经历 ↗</button></article>`).join('')}`;
  }
  const totalPages = 1 + Math.ceil(pair.people.length / 3);
  el('comparisonPageLabel').textContent = comparisonPage === 0 ? `指标 / 个体 · 1 / ${totalPages}` : `个体 · ${comparisonPage+1} / ${totalPages}`;
  root.querySelector<HTMLButtonElement>('[data-action=comparison-prev]')!.disabled = comparisonPage === 0;
  root.querySelector<HTMLButtonElement>('[data-action=comparison-next]')!.disabled = comparisonPage === totalPages-1;
}
async function runComparison() {
  if (busy || !candidate) return;
  const attempt = progress.chapters[level.id].attempts.find(a => a.index === Number(el<HTMLSelectElement>('comparisonAttempt').value));
  if (!attempt) return;
  const operation = ++operationId;
  comparedScheme = null;
  busy = true; playing = false; renderAll(); renderComparison();
  try {
    const response = await calculate('run', snapshot.seed, attempt.design);
    if (operation !== operationId || response.type !== 'result' || !response.run) return;
    compareSchemes(response.run, candidate);
    comparedScheme = { index: attempt.index, originalSeed: attempt.seed, run: response.run };
    comparisonPage = 0;
  } catch (error) { if (operation === operationId) el('comparisonStatus').textContent = error instanceof Error ? error.message : '比较未能完成'; }
  finally { if (operation === operationId) { busy = false; renderAll(); renderComparison(); } }
}
function downloadComparison() {
  if (!comparedScheme || !candidate || !baseline || busy) return;
  const pair = compareSchemes(comparedScheme.run, candidate);
  const report = { ...buildReport(level, snapshot, baseline, candidate, goals), comparison: {
    seed: snapshot.seed, reference: { attempt: comparedScheme.index, originalSeed: comparedScheme.originalSeed,
      design: comparedScheme.run.design, metrics: comparedScheme.run.metrics, fingerprint: comparedScheme.run.fingerprint },
    current: { metrics: candidate.metrics, fingerprint: candidate.fingerprint },
    benefited: pair.benefited, harmed: pair.harmed, unchanged: pair.unchanged, unresolved: pair.unresolved,
    people: pair.people.map(person => ({ id: person.id, referenceArrival: person.reference.arrivalTime, currentArrival: person.current.arrivalTime, delta: person.delta })),
  } };
  downloadText(`众-${level.number}-方案比较-初态${snapshot.seed}.json`, encodeDesign(currentSession(), report,progress.chapters[level.id].inquiries));
}
function transferAttempt() {
  const previous = LEVELS[LEVELS.indexOf(level)-1];
  const attempt = previous ? [...progress.chapters[previous.id].attempts].reverse().find(a => a.passed && a.rule === progress.chapters[previous.id].rule) : null;
  return {previous,attempt};
}
function openTransfer() {
  const {previous,attempt}=transferAttempt();
  el('transferTitle').textContent = level.transfer.question;
  el('transferCheck').textContent = level.transfer.check;
  el('transferOrigin').textContent = previous ? attempt ? `带入《${previous.title}》已达成的方案 ${attempt.index}。只带布局，不带成绩或原初态，本课按初态 ${snapshot.seed} 重新检验。` : `先在《${previous.title}》留下一个达成方案，再带到这里检验。也可以直接开始本课。` : '先编辑一块牌，用原始布局和自己的方案建立第一份对照。';
  el('transferStatus').textContent = transferSource ? `迁移起点为《${levelById(transferSource.levelId)!.title}》方案 ${transferSource.index}（原初态${transferSource.seed}）；${candidate && phase !== 'edit' ? `本课目前 ${goals.filter(g=>g.met).length}/${goals.length} 项目标达成。` : '当前布局尚未推演。'}` : '';
  el<HTMLButtonElement>('applyTransfer').hidden = !previous;
  el<HTMLButtonElement>('applyTransfer').disabled = busy || !attempt;
  el<HTMLButtonElement>('predictTransfer').hidden=!previous;
  el<HTMLButtonElement>('predictTransfer').disabled=busy||!attempt;
  el<HTMLButtonElement>('viewInquiries').hidden=!progress.chapters[level.id].inquiries.length;
  el<HTMLDialogElement>('transferDialog').showModal();
}
function applyTransfer() {
  if (busy) return;
  const {previous,attempt}=transferAttempt();
  if (!attempt||!previous) return;
  try { validateLevelDesign(level, snapshot, attempt.design); }
  catch (error) { el('transferStatus').textContent = `上一课布局在这里不能直接使用：${error instanceof Error ? error.message : '工具或位置不兼容'}。先按本课地形重新设计。`; return; }
  el<HTMLDialogElement>('transferDialog').close(); returnToEditing();
  if (changeDesign(clone(attempt.design))) {
    transferSource = { levelId: previous.id, index: attempt.index, seed: attempt.seed };
    tool = design.signs[0] ? { kind:'sign', id:design.signs[0].id } : null;
    guidance = null; guideOpen = false; guideDismissed = false;
    renderAll(); notify('已带入上一课布局。目标与人群仍是本课，请推演检验。');
  }
}
function openInquiry(source:'current'|'transfer') {
  if(busy||!baseline)return;
  const carried=transferAttempt().attempt;
  if(source==='transfer'&&!carried)return;
  const proposal=source==='transfer'?carried!.design:design;
  try {validateLevelDesign(level,snapshot,proposal);}catch(error){notify(error instanceof Error?error.message:'布局需先调整',true);return;}
  const reference=source==='current'&&candidate&&candidate.metrics.unfinished===0?candidate:baseline;
  inquiryProposal={source,design:clone(proposal),reference,label:reference===candidate?'上一轮方案':'本课原始布局'};
  viewedInquiryId=null;inquiryPage='predict';
  el<HTMLDialogElement>('transferDialog').close();el<HTMLDialogElement>('inquiryDialog').close();renderInquiry();el<HTMLDialogElement>('inquiryDialog').showModal();
}
function openInquiryResult(id?:number) {
  const records=progress.chapters[level.id].inquiries;
  const record=records.find(r=>r.id===(id??freshInquiryId))??records.at(-1);if(!record)return;
  inquiryProposal=null;viewedInquiryId=record.id;inquiryPage='result';
  el<HTMLDialogElement>('transferDialog').close();renderInquiry();el<HTMLDialogElement>('inquiryDialog').showModal();
}
function renderInquiry() {
  const record=progress.chapters[level.id].inquiries.find(r=>r.id===viewedInquiryId);
  const predicting=inquiryPage==='predict'&&!!inquiryProposal;
  el('inquiryTitle').textContent=predicting?'运行前，你预计会怎样？':'保留原预测，对照这次结果';
  el('inquiryMeta').textContent=predicting?`初态 ${snapshot.seed} · 与${inquiryProposal!.label}比较。预测对应准备检验的布局，继续修改后应重新记录。`
    :record?`初态 ${record.seed} · 参照${record.reference.label} · ${record.id===freshInquiryId?'本次真实推演':'保存的实验记录'}`:'';
  el('inquiryPredictPage').hidden=!predicting;
  el('inquiryResultPage').hidden=inquiryPage!=='result';
  el('inquiryReflectPage').hidden=inquiryPage!=='reflect';
  el('inquiryTabs').hidden=predicting;
  root.querySelectorAll<HTMLButtonElement>('[data-inquiry-page]').forEach(b=>b.classList.toggle('active',b.dataset.inquiryPage===inquiryPage));
  if(predicting){
    el('inquiryChoices').innerHTML=inquiryMetrics(level).map(metric=>`<fieldset class='inquiry-choice'><legend>${inquiryLabels[metric]}</legend>${(['lower','similar','higher'] as Prediction[]).map(direction=>`<label><input type='radio' name='predict-${metric}' value='${direction}'>${predictionLabels[direction]}</label>`).join('')}</fieldset>`).join('');
    el('inquiryError').textContent='';return;
  }
  if(!record)return;
  el<HTMLSelectElement>('inquiryRecordSelect').innerHTML=[...progress.chapters[level.id].inquiries].reverse().map(item=>`<option value='${item.id}' ${item.id===record.id?'selected':''}>预测 ${item.id} · 初态 ${item.seed} · ${item.result?'已有结果':'尚未关联运行'}</option>`).join('');
  el('inquiryRows').innerHTML=inquiryRows(level,record).map(row=>`<tr><th>${row.label}</th><td>${row.prediction?predictionLabels[row.prediction]:'—'}</td><td>${n(row.before)} / ${n(row.after)} 秒<small>${row.actualDirection?`实际${predictionLabels[row.actualDirection]}`:record.result?'有未完成者，暂不判断方向':'尚未关联运行'}</small></td></tr>`).join('');
  el<HTMLTextAreaElement>('inquiryReflection').value=record.reflection;
  el('inquiryReflectionNote').textContent=record.reflection?'已保留你写下的判断。':'可写下你的解释、下一次想改什么。记录个人判断，不计算学习正确率。';
}
function saveInquiryPrediction() {
  if(!inquiryProposal||busy)return;
  const choices:Partial<Record<InquiryMetric,Prediction>>={};
  for(const metric of inquiryMetrics(level)){
    const choice=root.querySelector<HTMLInputElement>(`input[name=predict-${metric}]:checked`)?.value;
    if(choice==='lower'||choice==='similar'||choice==='higher')choices[metric]=choice;
  }
  const records=progress.chapters[level.id].inquiries;
  try {
    const record=createInquiry(level,snapshot.seed,(records.at(-1)?.id??0)+1,inquiryProposal.design,inquiryProposal.reference,inquiryProposal.label,choices);
    if(inquiryProposal.source==='transfer')applyTransfer();else if(phase!=='edit')returnToEditing();
    if(!inquiryMatches(record,level,snapshot.seed,design))throw new Error('布局没有成功带入，预测尚未记录');
    records.push(record);if(records.length>8)records.shift();armedInquiryId=record.id;freshInquiryId=null;
    el<HTMLDialogElement>('inquiryDialog').close();inquiryProposal=null;scheduleSave();renderAll();notify('已保留运行前的预测。现在推演，结果不会改写你的原判断。');
  } catch(error){el('inquiryError').textContent=error instanceof Error?error.message:'预测未能保存';}
}
function saveInquiryReflection() {
  const record=progress.chapters[level.id].inquiries.find(r=>r.id===viewedInquiryId);if(!record)return;
  record.reflection=el<HTMLTextAreaElement>('inquiryReflection').value.slice(0,240);
  scheduleSave();el('inquiryReflectionNote').textContent='已保留这次修正；原预测和真实结果没有改变。';
}
function observeMap(kind:'learn'|'queue') {
  const run=activeRun();if(!run||busy||phase==='edit')return;
  const event=nextMapObservation(snapshot,run,time,kind);if(!event)return;
  time=event.time;selected=event.agentId;playing=false;follow=false;guideOpen=false;causality=true;
  el<HTMLInputElement>('causalityToggle').checked=true;side='person';personMode=kind==='learn'?'signs':'events';observedSign=event.signId??1;
  personEventPage=Math.max(0,Math.ceil(run.events.filter(e=>e.agentId===selected&&e.time<=time+.001).length/2)-1);
  renderAll();scheduleSave();
}
function draw(force = false) {
  if (home) return;
  const tick = Math.floor(time * 10);
  if (!force && tick === lastTick) return;
  lastTick = tick;
  stage.render({ design: phase === 'edit' ? design : activeRun()?.design ?? design, run: phase === 'edit' ? null : activeRun(), baseline,
    time, selected, tool, editing: phase === 'edit' && !busy, compare: compare && !baselineMode, coverage, density, placing,
    causality, overview: phase === 'review' && time >= duration(), follow: follow && phase !== 'edit', guide: guideOpen && !guideDismissed && !baselineMode && phase !== 'play' ? guidance : null });
  el<HTMLInputElement>('timeline').value = String(time);
  el('clock').innerHTML = `${n(time)} <small>/ ${phase === 'edit' ? '—' : n(duration())} 秒</small>`;
  renderLive(); renderSide();
}
function renderAll() {
  refreshChrome();
  if (home) { renderHome(); return; }
  renderHeader(); renderAction(); renderSide(true); renderToolSettings(); renderHistory(); draw(true);
}

async function enterLevel(id: string, session?: Session) {
  const next = levelById(id);
  if (!next) return;
  const operation = ++operationId;
  root.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog=>dialog.close());
  cancelCalculation(); playing = false;
  level = next; snapshot = levelSnapshot(level, session?.seed ?? level.seed);
  design = clone(session?.design ?? progress.chapters[id].draft);
  selected = session?.selected ?? 1; time = 0; phase = 'edit'; home = false; baselineMode = false;
  follow = false; undoDesigns = []; redoDesigns = []; editStart = null; personMode = 'now'; personEventPage = 0; goalPage = 0; historyPage = 0; mobilePanelOpen = false;
  candidate = null; baseline = null; tool = design.signs[0] ? { kind: 'sign', id: design.signs[0].id } : design.barrier ? { kind: 'barrier' } : null;
  placing = null; side = 'review'; verification = []; goals = []; evidence = null; busy = true;
  comparedScheme = null; transferSource = null; metricExplanation = null;
  guidance = null; guideOpen = false; guideDismissed = false; guideAnswerOpen = false; trialComparison = null;
  inquiryProposal=null; viewedInquiryId=null; armedInquiryId=null; freshInquiryId=null;
  progress.activeLevel = level.id;
  stage.setLevel(level, snapshot); renderAll();
  try {
    const response = await calculate(session?.review ? 'run' : 'baseline');
    if (operation !== operationId || response.type !== 'result') return;
    baseline = response.baseline; candidate = response.run;
    if (candidate) {
      phase = 'review'; time = clamp(session?.time ?? 0, 0, duration());
      goals = evaluate(level, baseline, candidate); evidence = diagnose(level, snapshot, baseline, candidate);
      guidance = createGuidance(level, snapshot, baseline, candidate);
    }
  } catch (error) { if (operation === operationId) notify(error instanceof Error ? error.message : '未能进入关卡', true); }
  finally { if (operation === operationId) { busy = false; renderAll(); scheduleSave(); } }
}
function rememberDesign() {
  try { validateLevelDesign(level, snapshot, design); progress.chapters[level.id].draft = clone(design); scheduleSave(); }
  catch (error) { notify(error instanceof Error ? error.message : '这个布局还需要调整', true); }
}
function changeDesign(next: Design, final = true, errorFeedback = true) {
  if (busy || phase !== 'edit') return false;
  try {
    validateLevelDesign(level, snapshot, next, false);
    editStart ??= clone(design);
    design = next; verification = [];
    if (final) completeEdit();
    renderAll();
    return true;
  } catch (error) { lastDesignError = error instanceof Error ? error.message : '这里不能放置工具'; if(el<HTMLDialogElement>('toolDialog').open) el('toolError').textContent=lastDesignError; else if(final && errorFeedback) notify(lastDesignError,true); return false; }
}
function completeEdit() {
  if (editStart && JSON.stringify(editStart) !== JSON.stringify(design)) {
    undoDesigns.push(editStart);
    if (undoDesigns.length > 40) undoDesigns.shift();
    redoDesigns = [];
  }
  editStart = null; rememberDesign();
}
function undoDesign(redo = false) {
  if (busy || phase !== 'edit') return;
  const from = redo ? redoDesigns : undoDesigns, to = redo ? undoDesigns : redoDesigns;
  const previous = from.pop();
  if (!previous) return;
  to.push(clone(design)); design = previous; editStart = null; placing = null; verification = [];
  tool = design.signs[0] ? { kind: 'sign', id: design.signs[0].id } : design.barrier ? { kind: 'barrier' } : null;
  side = 'review'; rememberDesign(); renderAll();
}
function selectTool(next: SelectedTool) { tool = next; side = 'review'; placing = null; renderAll(); audio.cue('select'); }
function rotateTool() {
  const chosen = tool;
  if (!chosen) return;
  const next = clone(design);
  if (chosen.kind === 'sign') {
    const sign = next.signs.find(s => s.id === chosen.id)!;
    sign.normal = { x: -sign.normal.y, y: sign.normal.x };
  } else if (next.barrier) next.barrier.vertical = !next.barrier.vertical;
  changeDesign(next); audio.cue('select');
}
function removeTool() {
  const chosen = tool;
  if (!chosen) return;
  const next = clone(design);
  if (chosen.kind === 'sign') next.signs = next.signs.filter(s => s.id !== chosen.id); else next.barrier = null;
  tool = null; changeDesign(next);
}
function returnToEditing() {
  ++operationId; cancelCalculation(); busy = false; playing = false; phase = 'edit'; time = 0;
  baselineMode = false; side = 'review'; placing = null; mobilePanelOpen=true;renderAll(); scheduleSave();
  if (guidance && !guideDismissed) {
    guideOpen = true; follow = false; selected = guidance.agentId;
    tool = design.signs.some(s => s.id === guidance!.signId) ? { kind: 'sign', id: guidance.signId } : tool;
    renderAll();
    const control=directHelp()&&guidance.variable!=='orientation'?guidanceControlSelector():null;
    if(control)el('sideContent').querySelector<HTMLElement>(control)?.focus({preventScroll:true});
    else stage.svg.querySelector<SVGElement>(`[data-sign="${guidance.signId}"]`)?.focus({ preventScroll: true });
  }
}
async function runDesign(addHistory = true) {
  if (busy || home) return;
  try { validateLevelDesign(level, snapshot, design); } catch (error) { notify(error instanceof Error ? error.message : '请先调整布局', true); return; }
  const operation = ++operationId;
  const previousTrial = candidate;
  busy = true; playing = false; placing = null; mobilePanelOpen = false; renderAll(); audio.cue('run');
  try {
    const response = await calculate('run');
    if (operation !== operationId || response.type !== 'result' || !response.run) return;
    baseline = response.baseline; candidate = response.run; baselineMode = false; time = 0; phase = 'play'; side = 'review';
    goals = evaluate(level, baseline, candidate); evidence = diagnose(level, snapshot, baseline, candidate); verification = [];
    guidance = createGuidance(level, snapshot, baseline, candidate); guideOpen = false; guideDismissed = false;
    guideAnswerOpen=false;freshInquiryId=null;
    const records=progress.chapters[level.id].inquiries,index=records.findIndex(r=>r.id===armedInquiryId);
    if(index>=0){
      const observed=observeInquiry(records[index],level,snapshot.seed,candidate);
      if(observed){records[index]=observed;freshInquiryId=observed.id;}
      else notify('布局或初态已变化，本次结果没有套用旧预测。可为当前布局重新记录。');
    }
    armedInquiryId=null;
    trialComparison = previousTrial ? compareTrials(previousTrial, candidate) : null;
    if (addHistory) appendAttempt(progress.chapters[level.id], snapshot.seed, design, candidate.metrics, candidate.fingerprint, completed(goals));
    playing = !motionReduced;
    if (!playing) { phase = 'review'; time = duration(); }
    scheduleSave();
  } catch (error) { if (operation === operationId) { notify(error instanceof Error ? error.message : '推演未完成', true); phase = 'edit'; } }
  finally { if (operation === operationId) { busy = false; renderAll();  } }
}
function finishPlayback() {
  playing = false; phase = 'review'; side = 'goals'; goalPage = 0; renderAll();
  if (!baselineMode) audio.cue(completed(goals) ? 'success' : 'review');
  scheduleSave();
}
function showEvidence() {
  if (!evidence || !candidate) return;
  if(phase==='edit' && designChanges(candidate.design,design).length){guideOpen=true;guideDismissed=false;renderAll();notify('橙色保留上轮证据。当前调整保持不变，可推演检验。');return;}
  baselineMode = false; selected = guidance?.agentId ?? evidence.agentId; time = clamp(guidance ? guidance.time : evidence.time + .1, 0, duration());
  guideOpen = guidance !== null; guideDismissed = false; follow = false;
  playing = false; side = 'person'; personMode=guidance?(guidance.map.exit?'events':'signs'):'now';observedSign=guidance?.signId??1;personEventPage=guidance?.map.exit?Math.max(0,Math.ceil(candidate.events.filter(e=>e.agentId===selected&&e.time<=time+.001).length/2)-1):0;mobilePanelOpen=true;phase = 'review'; renderAll();
  scheduleSave();
}
function inspectArrival(id: number) {
  if (!candidate) return;
  const result = candidate.agents.find(a => a.id === id);
  if (!result) return;
  selected = id; side = 'person'; personMode='now'; mobilePanelOpen=true;playing = false; baselineMode = false;
  const event = candidate.events.find(e => e.agentId === id && (e.type === 'learn' || e.type === 'blocked'));
  time = event?.time ?? Math.max(0, (result.arrivalTime ?? candidate.duration) - 3);
  renderAll();
  scheduleSave();
}
async function verifyDesign() {
  if (busy || !candidate) return;
  const operation = ++operationId;
  busy = true; playing = false; renderAll();
  try {
    const response = await calculate('verify');
    if (operation === operationId && response.type === 'verified') { verification = response.proofs; showVerification(); }
  } catch (error) { if (operation === operationId) notify(error instanceof Error ? error.message : '复核未完成', true); }
  finally { if (operation === operationId) { busy = false; renderAll(); } }
}
function renderProof() {
  proofPage=clamp(proofPage,0,Math.max(0,verification.length-1));
  const proof=verification[proofPage];
  el('proofPageLabel').textContent=`${proofPage+1} / ${verification.length}`;
  el('verificationList').innerHTML=proof?`<article class='verification-case ${proof.passed?'passed':''}'><div><b>初态 ${proof.seed}</b><span>${proof.passed?'✓ 达到目标':'仍需改进'}</span></div>${goalMarkup(proof.goals,true)}<button class='quiet-button' data-verify-seed='${proof.seed}'>进入这组初态，查看原因 ↗</button></article>`:'';
}
function showVerification() {
  el('verificationTitle').textContent=`${verification.filter(v=>v.passed).length} / ${verification.length} 组初态成立`;
  el<HTMLInputElement>('verificationSeed').value=String(snapshot.seed);el('verificationError').textContent=''; proofPage=0;renderProof();
  el<HTMLDialogElement>('verificationDialog').showModal();
}
function setDialogPage(id:string,page:string) {
  const dialog=el<HTMLDialogElement>(id);
  dialog.querySelectorAll<HTMLElement>('[data-dialog-content]').forEach(section=>section.hidden=section.dataset.dialogContent!==page);
  dialog.querySelectorAll<HTMLButtonElement>('[data-dialog-page]').forEach(button=>button.classList.toggle('active',button.dataset.dialogPage===`${id}:${page}`));
}
function openToolSettings(page:'position'|'timing') {
  if(!tool || busy || phase!=='edit')return;
  renderToolSettings();el('toolError').textContent='';setDialogPage('toolDialog',page);el<HTMLDialogElement>('toolDialog').showModal();
}
function openGuidance() {
  if(!guidance)return;
  guideAnswerOpen=true;renderAll();
  el('guideEditButton').textContent=guidance.variable==='tools'?'回到设计，添加工具 →':`去调整 ${guidance.signId} 号牌的${variableName[guidance.variable]} →`;
  el('guideDialogTitle').textContent=guidance.title;el('guideReason').textContent=guidance.observation;
  el('guideExperiment').textContent=guidance.experiment;el('guideCheck').textContent=guidance.check;
  setDialogPage('guidanceDialog','experiment');el<HTMLDialogElement>('guidanceDialog').showModal();
}
function openBrief() {
  el('briefNumber').textContent = `课题 ${level.number} / ${level.title}`; el('briefTitle').textContent = level.question;
  el('briefBody').textContent = level.briefing;
  el('briefRules').innerHTML = `<b>${level.tools} 份干预预算</b><p>导视牌可调整位置、正面与启用时段。${level.allowBarrier ? '也可用导流栏改变通路。' : ''}每一轮都与同一批人的原始布局比较。</p>`;
  el<HTMLDialogElement>('briefDialog').showModal();
}
function showLegacy(legacy: LegacyExperiment) {
  importedLegacy = legacy;
  el('legacyContent').innerHTML = `<div class="legacy-record"><span>原始初态 <b>${legacy.seed}</b></span><span>标识位置 <b>${n(legacy.position.x)}, ${n(legacy.position.y)}</b></span><span>当时已存的平均用时 <b>${n(legacy.metrics?.before)} → ${n(legacy.metrics?.after)} 秒</b></span></div>`;
  el<HTMLDialogElement>('legacyDialog').showModal();
}
function downloadText(filename: string, data: string) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadDesign() {
  try {
    if (!home) validateLevelDesign(level, snapshot, design);
    const report = !home && baseline && candidate && !baselineMode && phase !== 'edit' ? buildReport(level, snapshot, baseline, candidate, goals) : null;
    const data = home ? encodeCampaign(progress) : encodeDesign(currentSession(), report,progress.chapters[level.id].inquiries);
    downloadText(home ? '众-四课进度.json' : `众-${level.number}-${level.title}-初态${snapshot.seed}.json`, data);
    notify(home ? '已导出四课布局、尝试记录与回放位置，可换电脑接续。' : report ? '已导出方案、真实事件与目标证据。' : '已导出设计草稿，可在本游戏重新导入。');
  } catch (error) { notify(error instanceof Error ? error.message : '方案未能导出', true); }
}

stage.onSelectTool = selectTool;
stage.onMoveTool = (moving, point, final) => {
  const next = clone(design);
  if (moving.kind === 'sign') { const sign = next.signs.find(s => s.id === moving.id); if (sign) sign.position = point; }
  else if (next.barrier) next.barrier.position = point;
  if (!changeDesign(next, final) && final) { completeEdit(); renderAll(); }
};
stage.onRotate = rotateTool; stage.onRemove = removeTool;
stage.onSelectAgent = id => { selected = id; side = 'person'; personMode='now';mobilePanelOpen=true;playing = false; renderAll(); scheduleSave(); };
stage.onPlace = (kind, point) => {
  const next = clone(design);
  let nextTool: SelectedTool;
  if (kind === 'sign') {
    const id = next.signs.some(s => s.id === 1) ? 2 : 1;
    next.signs.push(makeSign(point, { id, target: id === 2 ? 'A' : 'B' })); nextTool = { kind: 'sign', id };
  } else { next.barrier = { position: point, vertical: false }; nextTool = { kind: 'barrier' }; }
  if (changeDesign(next)) { placing = null; tool = nextTool; renderAll(); audio.cue('select'); notify(kind==='sign'?'导视牌已放置，可拖动或旋转。':'导流栏已放置，可拖动或旋转。'); }
};

function closeFileMenu() {
  const menu=el<HTMLDetailsElement>('fileMenu');
  const wasInside=!!document.activeElement&&menu.contains(document.activeElement);
  menu.open=false;
  if(wasInside)el('fileMenuSummary').focus({preventScroll:true});
}
root.addEventListener('click', async event => {
  const target = event.target as Element;
  root.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(menu=>{if(!menu.contains(target))menu.open=false;});
  if(target.id==='importFile'){++importReadId;(target as HTMLInputElement).value='';root.querySelector<HTMLButtonElement>('[data-action=confirm-import]')!.disabled=false;}
  if(!target.closest('.layer-menu'))root.querySelectorAll<HTMLDetailsElement>('.layer-menu[open]').forEach(menu=>menu.open=false);
  const closer = target.closest<HTMLElement>('[data-close]');
  if (closer) { if(closer.dataset.close==='importDialog')++importReadId;el<HTMLDialogElement>(closer.dataset.close!).close();return; }
  if (progress.sound && !audio.enabled && target.closest<HTMLElement>('[data-action]')?.dataset.action !== 'sound') {
    try { await audio.enable(true); } catch { progress.sound = false; refreshChrome(); notify('当前环境无法播放声音，游戏可继续操作。'); }
  }
  const levelButton = target.closest<HTMLElement>('[data-level]');
  if (levelButton) { await enterLevel(levelButton.dataset.level!); return; }
  const achievement = target.closest<HTMLElement>('[data-achievement]');
  if (achievement) {
    const id = achievement.dataset.achievement!;
    const attempt = progress.chapters[id].attempts.find(a => a.passed && a.rule === progress.chapters[id].rule);
    if (attempt) await enterLevel(id, { levelId: id, seed: attempt.seed, design: attempt.design, selected: 1, time: 0, review: true });
    return;
  }
  const sideButton = target.closest<HTMLElement>('[data-side]');
  if (sideButton) { side = sideButton.dataset.side as typeof side; renderAll(); return; }
  const signButton = target.closest<HTMLElement>('[data-select-sign]');
  if (signButton) { selectTool({ kind: 'sign', id: Number(signButton.dataset.selectSign) }); return; }
  const personTab=target.closest<HTMLElement>('[data-person-mode]');
  if(personTab){personMode=personTab.dataset.personMode as typeof personMode;personEventPage=0;renderSide(true);return;}
  const dialogTab=target.closest<HTMLElement>('[data-dialog-page]');
  if(dialogTab){const [id,page]=dialogTab.dataset.dialogPage!.split(':');setDialogPage(id,page);return;}
  const inquiryTab=target.closest<HTMLElement>('[data-inquiry-page]');
  if(inquiryTab){inquiryPage=inquiryTab.dataset.inquiryPage as typeof inquiryPage;renderInquiry();return;}
  const help=target.closest<HTMLElement>('[data-goal-help]');
  if(help){el('goalHelpTitle').textContent=help.dataset.goalLabel!;el('goalHelpBody').textContent=help.dataset.goalHelp!;el<HTMLDialogElement>('goalHelpDialog').showModal();return;}
  const metricButton = target.closest<HTMLElement>('[data-metric]');
  if (metricButton) { openMetric(metricButton.dataset.metric as MetricId); return; }
  const metricPerson = target.closest<HTMLElement>('[data-metric-person]');
  if (metricPerson) { inspectMetricPerson(Number(metricPerson.dataset.metricPerson)); return; }
  const comparisonPerson = target.closest<HTMLElement>('[data-comparison-person]');
  if (comparisonPerson) { el<HTMLDialogElement>('comparisonDialog').close(); inspectArrival(Number(comparisonPerson.dataset.comparisonPerson)); return; }
  const chartPerson = target.closest<HTMLElement>('[data-chart-person]');
  if (chartPerson && candidate) {
    el<HTMLDialogElement>('arrivalDialog').close();inspectArrival(Number(chartPerson.dataset.chartPerson)); return;
  }
  const eventButton = target.closest<HTMLElement>('[data-time]');
  if (eventButton) { time = clamp(Number(eventButton.dataset.time), 0, duration()); playing = false; draw(true); renderAction(); scheduleSave(); return; }
  const historyButton = target.closest<HTMLElement>('[data-history]');
  if (historyButton) {
    const attempt = progress.chapters[level.id].attempts.find(a => a.index === Number(historyButton.dataset.history));
    if (attempt) await enterLevel(level.id, { levelId: level.id, seed: attempt.seed, design: attempt.design, selected: 1, time: 0, review: true });
    return;
  }
  const verifyButton = target.closest<HTMLElement>('[data-verify-seed]');
  if (verifyButton) { el<HTMLDialogElement>('verificationDialog').close(); await enterLevel(level.id, { ...currentSession(), seed: Number(verifyButton.dataset.verifySeed), time: 0, review: true }); return; }
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (!action) return;
  if(action==='import'||action==='export')closeFileMenu();
  if (action === 'home') {
    ++operationId; cancelCalculation(); busy = false; playing = false;
    try { persist(); } catch (error) { notify(error instanceof Error ? error.message : '当前进度未能保存，可导出方案', true); }
    home = true; renderAll();
  } else if (action === 'begin') await enterLevel(LEVELS[0].id, { levelId: LEVELS[0].id, seed: LEVELS[0].seed, design: clone(LEVELS[0].baseline), selected: 1, time: 0, review: false });
  else if (action === 'continue') await enterLevel(progress.session?.levelId ?? progress.activeLevel, progress.session ?? undefined);
  else if (action === 'run') await runDesign();
  else if(action==='toggle-panel'){mobilePanelOpen=!mobilePanelOpen;renderAction();}
  else if(action==='history'){historyPage=0;renderHistory();el<HTMLDialogElement>('historyDialog').showModal();}
  else if(action==='metric-prev' || action==='metric-next'){metricPage+=action==='metric-next'?1:-1;renderMetric();}
  else if(action==='compare-schemes')openComparison();
  else if(action==='run-comparison')await runComparison();
  else if(action==='export-comparison')downloadComparison();
  else if(action==='comparison-prev' || action==='comparison-next'){comparisonPage+=action==='comparison-next'?1:-1;renderComparison();}
  else if(action==='transfer'){if(freshInquiryId&&phase==='review')openInquiryResult();else openTransfer();}
  else if(action==='apply-transfer')applyTransfer();
  else if(action==='predict-current')openInquiry('current');
  else if(action==='predict-transfer')openInquiry('transfer');
  else if(action==='save-prediction')saveInquiryPrediction();
  else if(action==='inquiry-result')openInquiryResult();
  else if(action==='save-reflection')saveInquiryReflection();
  else if(action==='inquiry-edit'){el<HTMLDialogElement>('inquiryDialog').close();returnToEditing();}
  else if(action==='observe-learn')observeMap('learn');
  else if(action==='observe-queue')observeMap('queue');
  else if(action==='history-prev' || action==='history-next'){historyPage+=action==='history-next'?1:-1;renderHistory();}
  else if(action==='event-prev' || action==='event-next'){personEventPage+=action==='event-next'?1:-1;renderSide(true);}
  else if(action==='goal-prev' || action==='goal-next'){goalPage+=action==='goal-next'?1:-1;renderSide(true);}
  else if(action==='proof-prev' || action==='proof-next'){proofPage+=action==='proof-next'?1:-1;renderProof();}
  else if(action==='arrivals' && candidate && baseline){el('arrivalPanel').innerHTML=arrivalChart(level,baseline,candidate);el<HTMLDialogElement>('arrivalDialog').showModal();}
  else if(action==='reflection')el<HTMLDialogElement>('reflectionDialog').showModal();
  else if(action==='tool-position' || action==='tool-timing')openToolSettings(action==='tool-position'?'position':'timing');
  else if(action==='apply-tool-settings'){if(commitToolFields())el<HTMLDialogElement>('toolDialog').close();}
  else if(action==='guide-details')openGuidance();
  else if(action==='guide-edit'){el<HTMLDialogElement>('guidanceDialog').close();returnToEditing();}
  else if(action==='open-seed'){el<HTMLDialogElement>('verificationDialog').close();el<HTMLDialogElement>('seedDialog').showModal();}
  else if(action==='back-to-proof'){el<HTMLDialogElement>('seedDialog').close();showVerification();}
  else if (action === 'edit') returnToEditing();
  else if (action === 'cancel') { ++operationId; cancelCalculation(); busy = false; playing = false; renderAll(); }
  else if (action === 'reset') { tool = level.baseline.signs[0] ? { kind: 'sign', id: level.baseline.signs[0].id } : null; changeDesign(clone(level.baseline)); }
  else if (action === 'rotate') rotateTool();
  else if (action === 'undo') undoDesign();
  else if (action === 'redo') undoDesign(true);
  else if (action === 'focus-view') {
    follow = !follow;
    const run = activeRun();
    if (follow && run) {
      side = 'person';
      if (actor()?.arrived) {
        const event = run.events.find(e => e.agentId === selected && e.type === 'learn');
        const result = run.agents.find(a => a.id === selected)!;
        time = event?.time ?? Math.max(0, (result.arrivalTime ?? run.duration) - 3); playing = false;
      }
    }
    renderAll(); scheduleSave();
  }
  else if (action === 'remove-tool') removeTool();
  else if (action === 'select-barrier') selectTool({ kind: 'barrier' });
  else if (action === 'add-sign' || action === 'add-barrier') { placing = action === 'add-sign' ? 'sign' : 'barrier'; notify(`点击地图，放置${placing === 'sign' ? '导视牌' : '导流栏'}。`); renderAction(); draw(true); }
  else if (action === 'play' && activeRun()) { if (time >= duration()) time = 0; playing = !playing; renderAction(); draw(true); scheduleSave(); }
  else if (action === 'result' && activeRun()) { time = duration(); finishPlayback(); }
  else if (action === 'watch-baseline' && baseline) { baselineMode = true; phase = 'play'; time = 0; side = 'person'; playing = !motionReduced; if (!playing) { phase = 'review'; time = duration(); } renderAll(); }
  else if (action === 'person-tab') { side = 'person'; personMode='now';mobilePanelOpen=true;renderAll(); }
  else if (action === 'evidence') showEvidence();
  else if (action === 'guide-dismiss') { guideDismissed = true; guideOpen = false; renderAll(); }
  else if (action === 'guide-show') { guideDismissed = false; guideOpen = true; renderAll(); }
  else if (action === 'verify') await verifyDesign();
  else if (action === 'new-batch' || action === 'specified-batch') {
    const seed = action === 'new-batch' ? (Math.imul(snapshot.seed ^ (++batchSerial * 2654435761), 1664525) + 1013904223) >>> 0
      : el<HTMLInputElement>('verificationSeed').valueAsNumber;
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) { el('verificationError').textContent = '请输入 0 至 4294967295 的整数编号'; return; }
    const session = { ...currentSession(), seed, time: 0, review: false };
    el<HTMLDialogElement>('verificationDialog').close();
    const expectedOperation = operationId + 1;
    await enterLevel(level.id, session);
    if (operationId === expectedOperation && !home) await runDesign();
  }
  else if (action === 'show-verification') showVerification();
  else if (action === 'brief') openBrief();
  else if (action === 'about') el<HTMLDialogElement>('aboutDialog').showModal();
  else if (action === 'save') { try { if(storagePaused){captureProgress();downloadText('众-四课进度.json',encodeCampaign(progress));notify('原本机记录保留，本轮进度已另存文件。');}else{persist(true);notify('进度、设计与回放位置已手动保存。');} } catch(error){notify(error instanceof Error?error.message:'进度未能保存，可导出文件',true);} }
  else if (action === 'restore') {
    try {
      const saved = localStorage.getItem(CHECKPOINT_KEY);
      if (!saved) throw new Error('还没有手动保存的进度');
      progress = decodeProgress(saved);storagePaused=false;storageError='';
      void audio.enable(false);
      if (progress.session) await enterLevel(progress.session.levelId, progress.session); else { home = true; renderAll(); }
      notify('已恢复上一次手动保存。');
    } catch (error) { notify(error instanceof Error ? error.message : '恢复失败，当前进度保留', true); }
  } else if (action === 'export') downloadDesign();
  else if (action === 'sound') {
    try { await audio.enable(!progress.sound); progress.sound = audio.enabled; refreshChrome(); scheduleSave(); }
    catch { progress.sound = false; notify('当前环境无法播放声音，游戏可继续操作。'); refreshChrome(); }
  } else if (action === 'import') { ++importReadId;el<HTMLInputElement>('importFile').value='';root.querySelector<HTMLButtonElement>('[data-action=confirm-import]')!.disabled=false;el('importError').textContent = ''; el<HTMLDialogElement>('importDialog').showModal(); }
  else if (action === 'confirm-import') {
    try {
      const imported = decodeImport(el<HTMLTextAreaElement>('importText').value);
      el<HTMLDialogElement>('importDialog').close();
      if (imported.kind === 'legacy') showLegacy(imported);
      else if (imported.kind === 'campaign') {
        progress = imported.progress;storagePaused=false;storageError='';
        void audio.enable(false);
        if (progress.session) await enterLevel(progress.session.levelId, progress.session);
        else { ++operationId; cancelCalculation(); busy = false; playing = false; home = true; renderAll(); }
        scheduleSave(); notify('已载入四课进度。当前回放由本机按同一规则重新计算。');
      }
      else { await enterLevel(imported.session.levelId, imported.session); if (imported.sourceModel) notify('已复制早期设计。运动规则已更新，旧成绩不计入当前结果，请重新推演。'); }
    } catch (error) { el('importError').textContent = error instanceof Error ? error.message : '导入失败，当前方案未改变'; }
  } else if (action === 'legacy') {
    try { const data = localStorage.getItem(LEGACY_KEY); if (!data) throw new Error('没有找到早期记录'); const imported = decodeImport(data); if (imported.kind === 'legacy') showLegacy(imported); }
    catch (error) { notify(error instanceof Error ? error.message : '早期记录无法读取', true); }
  } else if (action === 'copy-legacy' && importedLegacy) {
    el<HTMLDialogElement>('legacyDialog').close(); const session = copyLegacy(importedLegacy); await enterLevel(session.levelId, session);
    notify('已复制早期布局。新结果将按当前规则独立推演，旧记录保持原样。');
  }
});

function commitToolFields() {
  const chosen = tool;
  if (!chosen || busy || phase !== 'edit') return false;
  const next = clone(design);
  const sign = chosen.kind === 'sign' ? next.signs.find(s => s.id === chosen.id) : null;
  const subject = sign ?? next.barrier;
  if (!subject) return false;
  const x = document.getElementById('toolX') as HTMLInputElement | null;
  const y = document.getElementById('toolY') as HTMLInputElement | null;
  if (x && y) subject.position = { x: x.valueAsNumber, y: y.valueAsNumber };
  if (sign) {
    const target = document.getElementById('targetInput') as HTMLSelectElement | null;
    const from = document.getElementById('fromInput') as HTMLInputElement | null;
    const until = document.getElementById('untilInput') as HTMLInputElement | null;
    if (target) sign.target = target.value as 'A' | 'B';
    if (from) sign.from = from.valueAsNumber;
    if (until) sign.until = until.valueAsNumber;
  }
  const accepted=changeDesign(next);
  el('toolError').textContent=accepted?'':lastDesignError;
  return accepted;
}
root.addEventListener('change', event => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'compareToggle') { compare = target.checked; draw(true); }
  else if (target.id === 'coverageToggle') { coverage = target.checked; draw(true); }
  else if (target.id === 'densityToggle') { density = target.checked; draw(true); }
  else if (target.id === 'causalityToggle') { causality=target.checked;draw(true); }
  else if (target.id === 'inquiryRecordSelect') {viewedInquiryId=Number(target.value);inquiryPage='result';renderInquiry();}
  else if (target.id === 'speedInput') speed = Number(target.value);
  else if (target.id === 'observationSign') {observedSign=Number(target.value);renderSide(true);}
  else if (target.id === 'personInput') { selected = Number(target.value); personEventPage=0; playing = false; draw(true); renderSide(true); renderAction(); scheduleSave(); }
  else if (target.id === 'comparisonAttempt') { comparedScheme = null; el('comparisonStatus').textContent = '已换参考布局，请按当前初态重新计算。'; renderComparison(); }
  else if (['targetInput', 'fromInput', 'untilInput', 'toolX', 'toolY'].includes(target.id)) commitToolFields();
  else if (target.id === 'importFile') void (async () => {
    const file=target.files?.[0];if(!file)return;
    const readId=++importReadId,confirm=root.querySelector<HTMLButtonElement>('[data-action=confirm-import]')!;
    el<HTMLTextAreaElement>('importText').value='';el('importError').textContent='';confirm.disabled=true;
    if(file.size>5_000_000){el('importError').textContent='请选择小于5 MB的方案JSON';confirm.disabled=false;return;}
    try {const text=await file.text();if(readId!==importReadId)return;el<HTMLTextAreaElement>('importText').value=text;confirm.disabled=false;}
    catch{if(readId===importReadId){el('importError').textContent='文件未能读取，当前方案未改变';confirm.disabled=false;}}
  })();
});
root.addEventListener('input',event=>{if((event.target as HTMLElement).id==='importText'){++importReadId;root.querySelector<HTMLButtonElement>('[data-action=confirm-import]')!.disabled=false;}});
el<HTMLInputElement>('timeline').addEventListener('input', event => { time = Number((event.target as HTMLInputElement).value); playing = false; draw(true); renderAction(); scheduleSave(); });
root.addEventListener('keydown', event => {
  const target = event.target as Element;
  if(event.key==='Escape'){
    const menu=root.querySelector<HTMLDetailsElement>('details[open]');
    if(menu){event.preventDefault();menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus({preventScroll:true});return;}
  }
  const point = target.closest<SVGElement>('[data-chart-person]');
  if (point?.tagName.toLowerCase() === 'g' && ['Enter', ' '].includes(event.key)) {
    event.preventDefault(); el<HTMLDialogElement>('arrivalDialog').close(); inspectArrival(Number(point.dataset.chartPerson)); return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    if (event.key === 'Enter' && ['fromInput', 'untilInput', 'toolX', 'toolY'].includes(target.id)) { event.preventDefault(); commitToolFields(); }
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoDesign(event.shiftKey); return; }
  if (target.closest('button, a, summary, [role="button"], [contenteditable="true"]')) return;
  if (event.key === ' ' && !home && phase !== 'edit') { event.preventDefault(); if (time >= duration()) time = 0; playing = !playing; renderAction(); scheduleSave(); }
  if (event.key === 'Escape' && placing) { placing = null; renderAction(); draw(true); }
});
let lastTime = 0;
function animate(timestamp: number) {
  const delta = lastTime ? Math.min((timestamp - lastTime) / 1000, .15) : 0; lastTime = timestamp;
  if (!home && playing && activeRun()) {
    time = Math.min(time + delta * speed, duration()); draw();
    if (time >= duration()) finishPlayback();
  }
  requestAnimationFrame(animate);
}
window.addEventListener('resize',()=>renderAll());
renderAll(); requestAnimationFrame(animate);
if (storageError) notify(storageError, true);
else if (storageNotice) notify(storageNotice);
