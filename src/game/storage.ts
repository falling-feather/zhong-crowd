import { MODEL, MAX_TIME, createSnapshot, makeDesign, makeSign } from '../core/scene';
import { LEVELS, levelById, levelSnapshot, levelRuleId, type Level } from './content';
import { validateLevelDesign, type GoalResult } from './evaluation';
import type { Design, Metrics, Run, Snapshot, Vec } from '../core/types';
import { inquiryMetrics, type InquiryRecord, type InquiryMetric, type InquiryValues, type Prediction } from './inquiry';

export const STORAGE_KEY = 'zhong.campaign.contact.v2';
export const CHECKPOINT_KEY = 'zhong.campaign.contact.checkpoint.v2';
export const PREVIOUS_KEY = 'zhong.campaign.v2';
export const LEGACY_KEY = 'zhong.lab.experiment.v1';
// Captured from the actual first contact-model curriculum, before goal revisions.
const LEGACY_CONTACT_RULES: Record<string, string> = { sight: '3b04c93d', balance: 'b983d59a', care: 'a73a651c', together: 'e0103f1c' };
export interface AttemptSummary {
  index: number;
  seed: number;
  design: Design;
  mean: number | null;
  tail: number | null;
  completed: number;
  passed: boolean;
  fingerprint: string;
  rule: string;
}
export interface ChapterProgress { draft: Design; attempts: AttemptSummary[]; solved: boolean; rule: string; inquiries: InquiryRecord[] }
export interface Session { levelId: string; seed: number; design: Design; selected: number; time: number; review: boolean }
export interface CampaignProgress {
  schema: 2;
  model: typeof MODEL;
  activeLevel: string;
  chapters: Record<string, ChapterProgress>;
  session: Session | null;
  sound: boolean;
}
export interface LegacyExperiment { kind: 'legacy'; seed: number; position: Vec; metrics: { before: number | null; after: number | null } | null }
export type Imported = { kind: 'current'; session: Session; sourceModel?: string } | { kind: 'campaign'; progress: CampaignProgress } | LegacyExperiment;

export function newProgress(): CampaignProgress {
  return { schema: 2, model: MODEL, activeLevel: LEVELS[0].id, session: null, sound: false,
    chapters: Object.fromEntries(LEVELS.map(level => [level.id, { draft: structuredClone(level.baseline), attempts: [], solved: false, rule: levelRuleId(level), inquiries:[] }])) };
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const timeValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME;

function readJson(text: string): unknown {
  if (text.length > 5_000_000) throw new Error('实验文件过大，请使用本游戏导出的方案文件');
  try { return JSON.parse(text); } catch { throw new Error('文件不是有效的 JSON，当前进度未改变'); }
}
function readDesign(value: unknown, level: Level, seed: number): Design {
  if (!record(value) || !Array.isArray(value.signs) || value.signs.length > 2 || !(value.barrier === null || record(value.barrier))) throw new Error('方案工具格式无效');
  for (const sign of value.signs) if (!record(sign) || !record(sign.position) || !record(sign.normal)) throw new Error('导视牌数据不完整');
  if (value.barrier !== null && (!record(value.barrier) || !record(value.barrier.position))) throw new Error('导流栏数据不完整');
  const design = structuredClone(value) as unknown as Design;
  validateLevelDesign(level, levelSnapshot(level, seed), design);
  return design;
}
function readSession(value: unknown): Session {
  if (!record(value) || typeof value.levelId !== 'string' || !integer(value.seed, 0, 0xffffffff)
    || !integer(value.selected, 1, 64) || !timeValue(value.time) || typeof value.review !== 'boolean') throw new Error('实验状态无效');
  const level = levelById(value.levelId);
  if (!level) throw new Error('没有找到这份方案对应的关卡');
  const snapshot = levelSnapshot(level, value.seed);
  if (value.selected > snapshot.agents.length) throw new Error('个体编号超出这节课的人数');
  return { levelId: level.id, seed: value.seed, design: readDesign(value.design, level, value.seed), selected: value.selected, time: value.time, review: value.review };
}
function readInquiryValues(value: unknown): InquiryValues {
  if(!record(value))throw new Error('预测记录的指标不完整');
  const result: InquiryValues={mean:null,tail:null,care:null,protect:null};
  for(const key of Object.keys(result) as InquiryMetric[]){
    const actual=value[key];if(actual!==null&&!timeValue(actual))throw new Error('预测记录的指标无效');
    result[key]=actual;
  }
  return result;
}
function readInquiry(value: unknown,level: Level): InquiryRecord {
  if(!record(value)||!integer(value.id,1,1_000_000)||value.model!==MODEL||typeof value.rule!=='string'||!/^[a-f0-9]{8}$/.test(value.rule)||
    !integer(value.seed,0,0xffffffff)||!record(value.reference)||!record(value.predictions)||typeof value.reflection!=='string'||value.reflection.length>240)
    throw new Error('预测记录格式无效');
  const reference=value.reference;
  if(typeof reference.label!=='string'||reference.label.length>80||typeof reference.fingerprint!=='string'||!/^[a-f0-9]{8}$/.test(reference.fingerprint)||typeof reference.completed!=='boolean')
    throw new Error('预测记录的参照方案无效');
  const predictions: Record<InquiryMetric,Prediction|null>={mean:null,tail:null,care:null,protect:null};
  for(const metric of Object.keys(predictions) as InquiryMetric[]){
    const choice=value.predictions[metric];
    if(choice!==null&&choice!=='lower'&&choice!=='similar'&&choice!=='higher')throw new Error('预测方向无效');
    predictions[metric]=choice;
  }
  if(inquiryMetrics(level).some(metric=>predictions[metric]===null))throw new Error('预测方向不完整');
  let result: InquiryRecord['result']=null;
  if(value.result!==null){
    const actual=value.result;
    if(!record(actual)||typeof actual.fingerprint!=='string'||!/^[a-f0-9]{8}$/.test(actual.fingerprint)||typeof actual.completed!=='boolean')throw new Error('预测的结果记录无效');
    result={fingerprint:actual.fingerprint,completed:actual.completed,values:readInquiryValues(actual.values)};
  }
  return {id:value.id,model:MODEL,rule:value.rule,seed:value.seed,design:readDesign(value.design,level,value.seed),
    reference:{label:reference.label,design:readDesign(reference.design,level,value.seed),fingerprint:reference.fingerprint,completed:reference.completed,values:readInquiryValues(reference.values)},
    predictions,result,reflection:value.reflection};
}

export const encodeProgress = (progress: CampaignProgress) => JSON.stringify(progress);
export function readProgress(getStore: () => Pick<Storage, 'getItem'>): { progress: CampaignProgress; blocked: boolean; error: string; notice: string } {
  try {
    const store = getStore(), raw = store.getItem(STORAGE_KEY);
    let progress = newProgress(), notice = '';
    if (raw !== null) progress = decodeProgress(raw);
    else {
      const previous = store.getItem(PREVIOUS_KEY);
      if (previous !== null) { progress = migratePreviousProgress(previous); notice = '运动规则已更新：沿用设计布局，新成绩需重新推演；早期进度原件保留。'; }
    }
    if (!notice && LEVELS.some(level => !progress.chapters[level.id].solved && progress.chapters[level.id].attempts.some(a => a.passed && a.rule !== progress.chapters[level.id].rule))) {
      notice = '部分关卡目标已更新。布局与旧成绩保留，旧目标方案可重新复核。';
    }
    return { progress, blocked: false, error: '', notice };
  } catch (error) {
    return { progress: newProgress(), blocked: true, notice: '', error: `${error instanceof Error ? error.message : '本机进度无法读取'}。自动保存已暂停，当前试玩可另存文件。` };
  }
}
export function writeProgress(getStore: () => Pick<Storage, 'setItem'>, progress: CampaignProgress, options: { checkpoint?: boolean; blocked?: boolean } = {}) {
  if (options.blocked) throw new Error('原记录未改写，自动保存已暂停；请另存当前进度文件');
  const store = getStore(), data = encodeProgress(progress);
  store.setItem(STORAGE_KEY, data);
  if (options.checkpoint) {
    try { store.setItem(CHECKPOINT_KEY, data); }
    catch (error) { throw new Error('当前进度已保存，但手动检查点未能更新；可导出进度文件', { cause: error }); }
  }
}
export function migratePreviousProgress(text: string): CampaignProgress {
  const data = readJson(text);
  if (!record(data) || data.schema !== 2 || data.model !== 'zhong-orca-2') throw new Error('早期四课进度格式无法读取，原记录仍保留');
  const previous = decodeProgress(JSON.stringify({ ...data, model: MODEL }));
  const next = newProgress();
  next.activeLevel = previous.activeLevel; next.sound = previous.sound;
  for (const level of LEVELS) next.chapters[level.id].draft = previous.chapters[level.id].draft;
  if (previous.session) next.session = { ...previous.session, time: 0, review: false };
  return next;
}
export function decodeProgress(text: string): CampaignProgress {
  const data = readJson(text);
  if (!record(data) || data.schema !== 2 || data.model !== MODEL || !record(data.chapters)
    || typeof data.activeLevel !== 'string' || !levelById(data.activeLevel) || typeof data.sound !== 'boolean') throw new Error('进度格式或规则版本不兼容，原数据已保留');
  const result = newProgress();
  result.activeLevel = data.activeLevel;
  result.sound = data.sound;
  result.session = data.session === null ? null : readSession(data.session);
  for (const level of LEVELS) {
    const chapter = data.chapters[level.id];
    if (!record(chapter) || !Array.isArray(chapter.attempts) || chapter.attempts.length > 12 || typeof chapter.solved !== 'boolean') throw new Error('章节记录不完整');
    const previousRule = chapter.rule === undefined ? LEGACY_CONTACT_RULES[level.id] : chapter.rule;
    if (typeof previousRule !== 'string' || !/^[0-9a-f]{8}$/.test(previousRule)) throw new Error('章节规则标识无效');
    const attempts: AttemptSummary[] = chapter.attempts.map(attempt => {
      if (!record(attempt) || !integer(attempt.index, 1, 1_000_000) || !integer(attempt.seed, 0, 0xffffffff)
        || !(attempt.mean === null || timeValue(attempt.mean)) || !(attempt.tail === null || timeValue(attempt.tail))
        || !integer(attempt.completed, 0, 64) || typeof attempt.passed !== 'boolean'
        || typeof attempt.fingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(attempt.fingerprint)) throw new Error('方案历史数据无效');
      const rule = attempt.rule === undefined ? previousRule : attempt.rule;
      if (typeof rule !== 'string' || !/^[0-9a-f]{8}$/.test(rule)) throw new Error('历史方案规则标识无效');
      return { index: attempt.index, seed: attempt.seed, design: readDesign(attempt.design, level, attempt.seed),
        mean: attempt.mean, tail: attempt.tail, completed: attempt.completed, passed: attempt.passed, fingerprint: attempt.fingerprint, rule };
    });
    const currentRule = levelRuleId(level);
    if(chapter.inquiries!==undefined&&(!Array.isArray(chapter.inquiries)||chapter.inquiries.length>8))throw new Error('预测记录数量无效');
    const inquiries: InquiryRecord[]=(chapter.inquiries as unknown[]|undefined??[]).map(value=>readInquiry(value,level));
    if(inquiries.some((item,index)=>index>0&&item.id<=inquiries[index-1].id))throw new Error('预测记录编号无效');
    result.chapters[level.id] = { draft: readDesign(chapter.draft, level, level.seed), attempts,
      solved: attempts.some(a => a.passed && a.rule === currentRule), rule: currentRule, inquiries };
  }
  return result;
}

export function decodeImport(text: string): Imported {
  const data = readJson(text);
  if (!record(data)) throw new Error('方案文件格式无效');
  if (data.format === 'zhong-experiment' && data.schema === 1 && data.model === 'zhong-disc-1') {
    if (!integer(data.seed, 0, 0xffffffff) || !record(data.position)
      || typeof data.position.x !== 'number' || typeof data.position.y !== 'number') throw new Error('旧实验的位置或初态不完整');
    const position = { x: data.position.x, y: data.position.y };
    const design = makeDesign([makeSign(position)]);
    validateLevelDesign(LEVELS[0], levelSnapshot(LEVELS[0], data.seed), design);
    let metrics: LegacyExperiment['metrics'] = null;
    if (record(data.report) && record(data.report.baseline) && record(data.report.changed)
      && record(data.report.baseline.metrics) && record(data.report.changed.metrics)) {
      const before = data.report.baseline.metrics.meanArrival;
      const after = data.report.changed.metrics.meanArrival;
      metrics = { before: before === null || timeValue(before) ? before : null, after: after === null || timeValue(after) ? after : null };
    }
    return { kind: 'legacy', seed: data.seed, position, metrics };
  }
  if (data.format === 'zhong-campaign' && data.schema === 2 && data.model === MODEL) return { kind: 'campaign', progress: decodeProgress(JSON.stringify(data.progress)) };
  if (data.format !== 'zhong-design' || data.schema !== 2 || (data.model !== MODEL && data.model !== 'zhong-orca-2')) throw new Error('方案与当前规则版本不兼容');
  const session = readSession(data.session);
  return data.model === MODEL ? { kind: 'current', session }
    : { kind: 'current', sourceModel: data.model, session: { ...session, time: 0, review: false } };
}

export function buildReport(level: Level, snapshot: Snapshot, baseline: Run, run: Run, goals: GoalResult[]) {
  const summarize = (r: Run) => ({ metrics: r.metrics, agents: r.agents, events: r.events, fingerprint: r.fingerprint });
  return { model: MODEL, level: { id: level.id, title: level.title, question: level.question, rule: levelRuleId(level) }, initial: snapshot,
    baselineDesign: level.baseline, design: run.design, goals,
    statement: '交互策略游戏的规则推演。含简化的出口放行间隔及圆盘运动，未校准真实行人行为，不作为安全预测。',
    baseline: summarize(baseline), changed: summarize(run) };
}
export function encodeDesign(session: Session, report: ReturnType<typeof buildReport> | null, inquiries: InquiryRecord[] = []) {
  return JSON.stringify({ format: 'zhong-design', schema: 2, model: MODEL, session, report, inquiries }, null, 2);
}
export const encodeCampaign = (progress: CampaignProgress) => JSON.stringify({ format: 'zhong-campaign', schema: 2, model: MODEL, progress }, null, 2);

export function appendAttempt(chapter: ChapterProgress, seed: number, design: Design, metrics: Metrics, fingerprint: string, passed: boolean) {
  const index = (chapter.attempts.at(-1)?.index ?? 0) + 1;
  chapter.attempts.push({ index, seed, design: structuredClone(design), mean: metrics.meanArrival, tail: metrics.lastArrival,
    completed: metrics.completed, passed, fingerprint, rule: chapter.rule });
  if (chapter.attempts.length > 12) {
    // Preserve the first achievement, without comparing raw times across different seeds.
    const best = chapter.attempts.find(attempt => attempt.passed && attempt.rule === chapter.rule) ?? chapter.attempts.find(attempt => attempt.passed);
    const remove = chapter.attempts.findIndex(attempt => attempt !== best && attempt !== chapter.attempts.at(-1));
    chapter.attempts.splice(remove, 1);
  }
  chapter.draft = structuredClone(design);
  chapter.solved ||= passed;
}

export function copyLegacy(legacy: LegacyExperiment): Session {
  const session: Session = { levelId: LEVELS[0].id, seed: legacy.seed, design: makeDesign([makeSign(legacy.position)]), selected: 1, time: 0, review: false };
  // Validate the new layout; no old numeric results are silently reinterpreted under the new model.
  validateLevelDesign(LEVELS[0], createSnapshot(session.seed), session.design);
  return session;
}
