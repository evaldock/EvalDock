/** Display recorded scores without treating missing evidence as zero. */
const labels = [
  ['label.artifact-delivery/v1', '产物交付'],
  ['label.reasoning-planning/v1', '推理规划'],
  ['label.loop/v1', '执行闭环'],
  ['label.memory/v1', '记忆'],
  ['label.retrieval-grounding/v1', '检索依据'],
  ['label.collaboration/v1', '协作委派'],
  ['label.multimodal/v1', '多模态'],
  ['label.safety-boundary/v1', '安全边界'],
  ['label.efficiency-reliability/v1', '效率稳定性'],
  ['label.efficiency-cost/v1', '成本效率'],
  ['label.tool-code/v1', '代码工具'],
  ['label.tool-data/v1', '数据工具'],
  ['label.tool-document/v1', '文档工具'],
  ['label.tool-external/v1', 'API 工具'],
  ['label.tool-web/v1', '浏览器工具'],
];
const names = new Map(labels);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const stateNames = {uncovered:'未覆盖', pending:'待评分', unassessable:'证据不足', error:'评分失败', mixed:'标准不同，未汇总'};

/** Same weighted mean as the reports, preserving each label's frozen scale. */
export function summarizeRunScores(run = {}) {
  const cases = run.cases ?? [];
  const ids = [...new Set([...(run.dimensions ?? []), ...cases.flatMap(c => Object.keys(c.scores ?? {}))])];
  return ids.map(id => {
    const entries = cases.filter(c => c.scores?.[id]).map(c => ({...c.scores[id], weight:c.scores[id].weight ?? c.weight ?? 1}));
    const scored = entries.filter(s => {
      const scale = s.scale ?? run.scoreScale;
      return s.state === 'scored' && Number.isFinite(s.value) && Number.isFinite(s.weight) && s.weight > 0 &&
        Number.isFinite(scale?.min) && Number.isFinite(scale?.max) && scale.max > scale.min && s.value >= scale.min && s.value <= scale.max;
    });
    const standards = new Set(scored.map(s => {
      const scale = s.scale ?? run.scoreScale;
      return JSON.stringify([scale.min, scale.max, s.standardDigest ?? null]);
    }));
    const mixed = standards.size > 1;
    const weight = scored.reduce((sum, s) => sum + s.weight, 0);
    const scale = scored[0]?.scale ?? run.scoreScale;
    const value = scored.length && !mixed ? round(scored.reduce((sum, s) => sum + s.value * s.weight, 0) / weight) : null;
    const nil = entries.filter(s => s.state === 'null').length;
    const error = entries.filter(s => s.state === 'error').length;
    const state = mixed ? 'mixed' : value !== null ? 'scored' : error ? 'error' : nil ? 'unassessable' : 'pending';
    return {id, name:names.get(id) ?? run.labelNames?.[id] ?? id, value, min:scale?.min, max:scale?.max,
      state, valid:scored.length, covered:entries.length, nil, error};
  });
}

/** With fewer than three measured dimensions, known labels provide context axes only. */
export function radarAxes(items) {
  if (items.length >= 3) return items;
  const byId = new Map(items.map(item => [item.id, item]));
  return [
    ...labels.map(([id, name]) => byId.get(id) ?? {id, name, value:null, state:'uncovered', valid:0, covered:0}),
    ...items.filter(item => !names.has(item.id)),
  ];
}

function scoreText(item) {
  return item.state === 'scored' ? `${item.value} / ${item.max}` : stateNames[item.state] ?? '待评分';
}

export function renderScoreRadar(items) {
  const axes = radarAxes(items), n = axes.length;
  const cx = 350, cy = 280, radius = 174, outer = 211;
  const point = (index, distance) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / n;
    return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance];
  };
  const xy = p => p.map(v => v.toFixed(2)).join(',');
  const points = axes.map((item, index) => item.state === 'scored' && Number.isFinite(item.value)
    ? point(index, radius * Math.max(0, Math.min(1, (item.value - item.min) / (item.max - item.min)))) : null);
  let grid = '', lines = '', captions = '', series = '';
  for (let ring = 1; ring <= 5; ring++) {
    grid += `<polygon class="radar-ring" points="${axes.map((_, i) => xy(point(i, radius * ring / 5))).join(' ')}"/>`;
    grid += `<text class="radar-tick" x="${cx + 7}" y="${cy - radius * ring / 5 - 5}">${ring * 20}%</text>`;
  }
  axes.forEach((item, index) => {
    const end = point(index, radius), label = point(index, outer);
    const angle = -Math.PI / 2 + index * 2 * Math.PI / n;
    const anchor = Math.cos(angle) > .18 ? 'start' : Math.cos(angle) < -.18 ? 'end' : 'middle';
    lines += `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${end[0].toFixed(2)}" y2="${end[1].toFixed(2)}"/>`;
    const short = item.name.length > 12 ? item.name.slice(0, 11) + '…' : item.name;
    captions += `<text class="radar-label ${item.state === 'scored' ? 'scored' : 'missing'}" text-anchor="${anchor}" x="${label[0].toFixed(2)}" y="${label[1].toFixed(2)}"><title>${esc(item.name)}：${esc(scoreText(item))}</title><tspan>${esc(short)}</tspan><tspan class="radar-value" x="${label[0].toFixed(2)}" dy="18">${esc(scoreText(item))}</tspan></text>`;
  });
  // A missing axis has no point or zero-radius vertex. Do not bridge it with an area.
  if (points.every(Boolean)) {
    series = `<polygon class="radar-area" points="${points.map(xy).join(' ')}"/>`;
  } else {
    points.forEach((p, i) => {
      const next = points[(i + 1) % n];
      if (p && next) series += `<line class="radar-segment" x1="${p[0].toFixed(2)}" y1="${p[1].toFixed(2)}" x2="${next[0].toFixed(2)}" y2="${next[1].toFixed(2)}"/>`;
    });
  }
  points.forEach((p, i) => {
    if (!p) return;
    const item = axes[i], title = `${item.name}：${scoreText(item)}，${item.valid} 题有效评分`;
    series += `<circle class="radar-point" tabindex="0" role="img" aria-label="${esc(title)}" cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="5"><title>${esc(title)}</title></circle>`;
  });
  return `<svg class="score-radar-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 555" role="img" aria-label="Agent 能力雷达图"><title>本轮评测的能力分布</title><desc>外圈代表各维度满分。只有有效分数绘制得分点；未覆盖、证据不足和评分失败均不作为零分。</desc>${grid}${lines}${series}${captions}</svg>`;
}

export function renderRunRadar(run) {
  const items = summarizeRunScores(run), axes = radarAxes(items);
  const valid = items.filter(item => item.state === 'scored').length;
  const rows = items.map(item => `<div class="radar-score-row"><div><strong>${esc(item.name)}</strong><small>${item.valid} / ${item.covered} 题有效评分${item.nil ? ` · ${item.nil} 题证据不足` : ''}${item.error ? ` · ${item.error} 题评分失败` : ''}</small></div><span class="${item.state === 'scored' ? 'scored' : 'missing'}">${esc(scoreText(item))}</span></div>`).join('');
  const context = items.length < 3 ? `使用 ${axes.length} 个维度作参照；未覆盖的维度不计分。` : '按本轮覆盖的维度展示。';
  return `<section class="run-radar" aria-label="本轮能力评分"><div class="run-radar-heading"><div><h2>能力雷达图</h2><p>${valid} 个维度有有效分数 · 本轮覆盖 ${items.length} 个维度</p></div><span>按原始量表展示</span></div><div class="run-radar-layout"><div>${renderScoreRadar(items)}<p class="radar-legend"><i></i>绿色点表示有效评分 · 外圈为满分</p></div><div class="radar-score-list">${rows || '<p class="muted">尚无有效评分，评分完成后会自动更新。</p>'}<p class="radar-note">${context}缺失分数保留状态，不补为零分。${valid && valid < 3 ? '当前先展示得分点，更多维度评分完成后补充图形。' : ''}</p></div></div></section>`;
}
