import { beforeAll, describe, expect, it } from 'vitest';
import { LEVELS, levelSnapshot } from '../src/game/content';
import { makeDesign, makeSign } from '../src/core/scene';
import { simulate } from '../src/core/simulation';
import type { Run } from '../src/core/types';
import { createInquiry, observeInquiry, inquiryRows, inquiryMatches } from '../src/game/inquiry';
import { newProgress, decodeProgress } from '../src/game/storage';

describe('先预测、执行、对照，再修正判断', () => {
  const level = LEVELS[1], snapshot = levelSnapshot(level);
  const design = makeDesign([makeSign({ x: 7.2, y: 8.8 })]);
  let baseline: Run, failed: Run;
  beforeAll(() => { baseline = simulate(snapshot, level.baseline); failed = simulate(snapshot, design); });
  it('迁移预测保留玩家原判断，真实反例不会回写成事后正确答案', () => {
    const inquiry = createInquiry(level, snapshot.seed, 1, design, baseline, '本课原始布局', { mean:'lower',tail:'lower' });
    expect(inquiry.result).toBeNull();
    const observed = observeInquiry(inquiry, level, snapshot.seed, failed)!;
    expect(observed.predictions.mean).toBe('lower');
    expect(inquiryRows(level, observed).map(row => row.actualDirection)).toEqual(['higher','higher']);
    expect(observed.result!.fingerprint).toBe(failed.fingerprint);
    expect(observed.reflection).toBe('');
    expect(Object.keys(observed)).not.toContain('learningScore');
  });
  it('改变布局或初态后，不把旧预测套在新运行上', () => {
    const inquiry = createInquiry(level, snapshot.seed, 2, design, baseline, '本课原始布局', { mean:'lower',tail:'lower' });
    expect(inquiryMatches(inquiry, level, snapshot.seed, design)).toBe(true);
    expect(inquiryMatches(inquiry, level, 17, design)).toBe(false);
    const rotated = makeDesign([makeSign({ x:7.2,y:8.8 }, { normal:{x:-1,y:0} })]);
    expect(inquiryMatches(inquiry, level, snapshot.seed, rotated)).toBe(false);
    expect(observeInquiry(inquiry, level, 17, failed)).toBeNull();
    expect(()=>createInquiry(level,snapshot.seed,1_000_001,design,baseline,'原始布局',{mean:'lower',tail:'lower'})).toThrow('预测记录编号');
  });
  it('原进度没有预测字段时能接续，新记录保存后仍保留原预测和个人笔记', () => {
    const progress=newProgress();
    const inquiry=observeInquiry(createInquiry(level,snapshot.seed,1,design,baseline,'原始布局',{mean:'lower',tail:'lower'}),level,snapshot.seed,failed)!;
    inquiry.reflection='更多人去B，放行间隔成为新的约束';progress.chapters.balance.inquiries.push(inquiry);
    expect(decodeProgress(JSON.stringify(progress)).chapters.balance.inquiries[0]).toEqual(inquiry);
    const old=JSON.parse(JSON.stringify(newProgress()));
    for(const chapter of Object.values(old.chapters) as Record<string,unknown>[])delete chapter.inquiries;
    expect(decodeProgress(JSON.stringify(old)).chapters.balance.inquiries).toEqual([]);
    const bad=JSON.parse(JSON.stringify(progress));bad.chapters.balance.inquiries[0].predictions.mean='guaranteed-win';
    expect(()=>decodeProgress(JSON.stringify(bad))).toThrow('预测');
  });
  it('公平预测分别对照整体均值、慢行尾部、快行平均，不合成为学习分数', () => {
    const care = LEVELS[2], batch = levelSnapshot(care);
    const before = simulate(batch, makeDesign([makeSign({x:11.9,y:8.8},{until:20})]));
    const after = simulate(batch, makeDesign([makeSign({x:11.9,y:8.8},{from:3,until:20})]));
    const draft = createInquiry(care, batch.seed, 1, after.design, before, '上一轮方案', {mean:'lower',care:'lower',protect:'lower'});
    const observed = observeInquiry(draft, care, batch.seed, after)!;
    const rows = inquiryRows(care, observed);
    expect(rows.map(r=>r.actualDirection)).toEqual(['higher','lower','higher']);
    expect(rows[0].before).toBe(before.metrics.meanArrival);
    expect(rows[1].after).toBe(after.metrics.cohorts.slow.tail);
  });
});
