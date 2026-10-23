import type { Run } from '../core/types';
import type { Level } from '../game/content';
import { escape, number as n, pad } from './format';

/** Every point is a recorded arrival, rather than a smoothed or illustrative curve. */
export function arrivalChart(level: Level, baseline: Run, run: Run): string {
  const limit = Math.ceil(Math.max(baseline.duration, run.duration) / 10) * 10;
  const left = 76, right = 680, height = 38 + level.groups.length * 89;
  const x = (time: number) => left + time / limit * (right - left);
  const ticks = Array.from({ length: 6 }, (_, i) => limit * i / 5);
  const lanes = level.groups.map((group, index) => {
    const top = 27 + index * 89;
    const current = run.agents.filter(a => a.cohort === group.id);
    const before = baseline.metrics.cohorts[group.id];
    const after = run.metrics.cohorts[group.id];
    const point = (a: Run['agents'][number], original: boolean) => {
      if (a.arrivalTime === null) return '';
      const y = top + (original ? 31 : 53) + (a.id % 3 - 1) * 3.4;
      return `<g data-chart-person="${a.id}" role="button" tabindex="0" aria-label="查看第 ${pad(a.id)} 号，${escape(group.label)}，${original ? '原始' : '当前'}到达 ${n(a.arrivalTime)} 秒"><circle cx="${x(a.arrivalTime)}" cy="${y}" r="7" fill="transparent"/><circle cx="${x(a.arrivalTime)}" cy="${y}" r="3.7" fill="${original ? '#fcfcf6' : group.color}" stroke="${original ? '#87958b' : '#36584a'}" stroke-width="${original ? '1.2' : '.6'}"/><title>第 ${a.id} 号 · ${original ? '原始' : '当前'} ${n(a.arrivalTime)} 秒</title></g>`;
    };
    return `<text x="0" y="${top + 3}" class="chart-group">${escape(group.label)}</text><text x="${left}" y="${top + 3}" class="chart-summary">平均 ${n(before.mean)} → ${n(after.mean)} 秒 · 最后 ${n(before.tail)} → ${after.completed < after.count ? '仍有人未离开' : `${n(after.tail)} 秒`}</text><text x="28" y="${top + 35}" class="chart-label">原始</text><text x="28" y="${top + 57}" class="chart-label">当前</text>${baseline.agents.filter(a => a.cohort === group.id).map(a => point(a, true)).join('')}${current.map(a => point(a, false)).join('')}`;
  }).join('');
  const last = [...run.agents].sort((a, b) => (b.arrivalTime ?? Infinity) - (a.arrivalTime ?? Infinity))[0];
  return `<section class="arrival-panel panel"><div class="arrival-heading"><div><p class="eyebrow">从群体回到个人</p><h3>${level.id === 'care' ? '平均数里，谁还在等待？' : '每个点，都是一个人的到达。'}</h3></div><button class="quiet-button" data-chart-person="${last.id}">查看最后一人 ↗</button></div><svg viewBox="0 0 700 ${height}" role="group" aria-label="各组原始与当前到达分布，点击圆点追看个体"><g class="chart-grid">${ticks.map(t => `<line x1="${x(t)}" y1="12" x2="${x(t)}" y2="${height - 24}"/><text x="${x(t)}" y="${height - 7}" text-anchor="middle">${n(t, 0)}s</text>`).join('')}</g>${lanes}</svg><div class="arrival-mobile-summary">${level.groups.map(group => { const before = baseline.metrics.cohorts[group.id], after = run.metrics.cohorts[group.id]; const last = [...run.agents].filter(a => a.cohort === group.id).sort((a,b) => (b.arrivalTime ?? Infinity)-(a.arrivalTime ?? Infinity))[0]; return `<article><h4>${escape(group.label)}</h4><p>平均 ${n(before.mean)} → ${n(after.mean)} 秒</p><p>最后 ${n(before.tail)} → ${after.completed < after.count ? '未完成' : n(after.tail)} 秒</p><button data-chart-person="${last.id}">查看本组最后一人 ↗</button></article>`; }).join('')}</div><p class="arrival-note">空心是原始布局，实心是当前方案。横轴越往右，到达越晚；点选可以追看这个人的经历。${run.metrics.unfinished ? `本轮另有 ${run.metrics.unfinished} 人未在 ${n(run.duration)} 秒内离开，未列入到达均值。` : ''}</p></section>`;
}
