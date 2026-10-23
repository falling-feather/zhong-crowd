import { MODEL } from '../core/scene';
import { hashText } from '../core/simulation';
import type { Design, Run } from '../core/types';
import { levelRuleId, type Level } from './content';

export type InquiryMetric = 'mean' | 'tail' | 'care' | 'protect';
export type Prediction = 'lower' | 'similar' | 'higher';
export type InquiryValues = Record<InquiryMetric, number | null>;
export interface InquiryRecord {
  id: number;
  model: string;
  rule: string;
  seed: number;
  design: Design;
  reference: { label: string; design: Design; fingerprint: string; completed: boolean; values: InquiryValues };
  predictions: Record<InquiryMetric, Prediction | null>;
  result: { fingerprint: string; completed: boolean; values: InquiryValues } | null;
  reflection: string;
}
export const inquiryLabels: Record<InquiryMetric,string> = { mean:'整体平均',tail:'最后一人',care:'慢行组最后一人',protect:'快行组平均' };
export const predictionLabels: Record<Prediction,string> = { lower:'更早',similar:'相近',higher:'更晚' };
export const INQUIRY_TOLERANCE = .2;
export const inquiryMetrics = (level: Level): InquiryMetric[] => level.targets.cohort ? ['mean','care','protect'] : ['mean','tail'];
const values = (level: Level,run: Run): InquiryValues => ({mean:run.metrics.meanArrival,tail:run.metrics.lastArrival,
  care:run.metrics.cohorts[level.targets.cohort??'']?.tail??null,protect:run.metrics.cohorts[level.targets.protectCohort??'']?.mean??null});
function designKey(design: Design) {
  return hashText(JSON.stringify({signs:[...design.signs].sort((a,b)=>a.id-b.id).map(s=>[s.id,s.position.x,s.position.y,s.normal.x,s.normal.y,s.range,s.target,s.from,s.until]),
    barrier:design.barrier?[design.barrier.position.x,design.barrier.position.y,design.barrier.vertical]:null}));
}
export function createInquiry(level: Level, seed: number, id: number, design: Design, reference: Run, label: string,
  predictions: Partial<Record<InquiryMetric,Prediction>>): InquiryRecord {
  if(!Number.isSafeInteger(id)||id<1||id>1_000_000)throw new Error('预测记录编号已达到保存边界，请先导出记录');
  if(inquiryMetrics(level).some(metric=>!predictions[metric]))throw new Error('请先为每项选择预测，也可以直接检验而不记录预测');
  return {id,model:MODEL,rule:levelRuleId(level),seed,design:structuredClone(design),
    reference:{label,design:structuredClone(reference.design),fingerprint:reference.fingerprint,completed:reference.metrics.unfinished===0,values:values(level,reference)},
    predictions:{mean:null,tail:null,care:null,protect:null,...predictions},result:null,reflection:''};
}
export function inquiryMatches(record: InquiryRecord,level: Level,seed: number,design: Design) {
  return record.model===MODEL&&record.rule===levelRuleId(level)&&record.seed===seed&&designKey(record.design)===designKey(design);
}
export function observeInquiry(record: InquiryRecord,level: Level,seed: number,run: Run): InquiryRecord|null {
  if(record.result||run.model!==MODEL||!inquiryMatches(record,level,seed,run.design))return null;
  return {...structuredClone(record),result:{fingerprint:run.fingerprint,completed:run.metrics.unfinished===0,values:values(level,run)}};
}
export function inquiryRows(level: Level,record: InquiryRecord) {
  return inquiryMetrics(level).map(metric=>{
    const before=record.reference.values[metric],after=record.result?.values[metric]??null;
    const comparable=record.reference.completed&&record.result?.completed&&before!==null&&after!==null;
    const delta=comparable?Math.round((after-before)*10)/10:null;
    const actualDirection: Prediction|null=delta===null?null:delta < -INQUIRY_TOLERANCE?'lower':delta>INQUIRY_TOLERANCE?'higher':'similar';
    return {metric,label:inquiryLabels[metric],prediction:record.predictions[metric],before,after,delta,actualDirection};
  });
}
