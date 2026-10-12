import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {summarizeRunScores, radarAxes, renderScoreRadar, renderRunRadar} from '../../workbench/design-prototypes/score-radar.js';
import {renderRun} from '../../workbench/design-prototypes/product-pages.js';

const delivery = 'label.artifact-delivery/v1', cost = 'label.efficiency-cost/v1', code = 'label.tool-code/v1';
const score = (value, extra = {}) => ({state:'scored', value, scale:{min:0, max:100}, standardDigest:'current', ...extra});

test('a single score appears on the radar while unavailable dimensions stay missing', () => {
  const run = {dimensions:[delivery, cost], cases:[{scores:{[delivery]:score(96), [cost]:{state:'null', value:null}}}]};
  const items = summarizeRunScores(run), axes = radarAxes(items), html = renderScoreRadar(items);
  assert.equal(axes.length, 15);
  assert.equal(axes.find(item => item.id === delivery).value, 96);
  assert.equal(axes.find(item => item.id === cost).state, 'unassessable');
  assert.equal(axes.find(item => item.id === code).state, 'uncovered');
  assert.equal((html.match(/class="radar-point"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /class="radar-area"|NaN|Infinity/);
  assert.match(html, /96 \/ 100/);
  assert.match(html, /证据不足/);
});

test('zero remains a valid point and missing evidence and Judge errors do not dilute the mean', () => {
  const run = {dimensions:[delivery, cost, code], cases:[
    {weight:3, scores:{[delivery]:score(80), [cost]:score(0)}},
    {weight:1, scores:{[delivery]:score(40), [code]:{state:'error'}}},
    {weight:8, scores:{[delivery]:{state:'null'}}},
    {weight:0, scores:{[delivery]:score(100)}},
  ]};
  const items = summarizeRunScores(run);
  assert.equal(items.find(item => item.id === delivery).value, 70);
  assert.equal(items.find(item => item.id === delivery).valid, 2);
  assert.equal(items.find(item => item.id === cost).value, 0);
  assert.equal(items.find(item => item.id === code).state, 'error');
  const html = renderScoreRadar(items);
  assert.equal((html.match(/class="radar-point"/g) ?? []).length, 2);
  assert.match(html, /cx="350\.00" cy="280\.00"/);
  assert.doesNotMatch(html, /class="radar-area"/);
});

test('frozen scales stay intact and different standards cannot be averaged', () => {
  const old = score(4, {scale:{min:0, max:5}, standardDigest:'old'});
  const historical = summarizeRunScores({cases:[{scores:{[delivery]:old}}]});
  assert.equal(historical[0].value, 4);
  assert.equal(historical[0].max, 5);
  assert.match(renderScoreRadar(historical), /4 \/ 5/);
  for (const next of [score(80), {...old, standardDigest:'different'}]) {
    const mixed = summarizeRunScores({cases:[{scores:{[delivery]:old}}, {scores:{[delivery]:next}}]});
    assert.equal(mixed[0].state, 'mixed');
    assert.equal(mixed[0].value, null);
    assert.doesNotMatch(renderScoreRadar(mixed), /class="radar-point"/);
  }
});

test('three scored dimensions form an area while empty reports show only reference axes', () => {
  const items = summarizeRunScores({cases:[{scores:{[delivery]:score(90), [cost]:score(50), [code]:score(70)}}]});
  assert.equal(radarAxes(items).length, 3);
  assert.match(renderScoreRadar(items), /class="radar-area"/);
  assert.doesNotMatch(renderScoreRadar([]), /class="radar-point"|class="radar-area"/);
  assert.match(renderRunRadar(), /尚无有效评分/);
});

test('desktop report details include the radar and escape imported label text', () => {
  const id = 'label.custom/v1', run = {cases:[{id:'case', scores:{[id]:score(75)}}], labelNames:{[id]:'<script>bad</script>'}};
  const html = renderRun({id:'job', runId:'run', state:'SUCCEEDED', events:[]}, {run, reportPaths:[]});
  assert.match(html, /能力雷达图/);
  assert.match(html, /75 \/ 100/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('radar reference axes correspond to the current label catalog', async () => {
  const inventory = JSON.parse(await readFile('workbench/design-prototypes/question-inventory/index.json', 'utf8'));
  assert.deepEqual(radarAxes([]).map(item => item.id).sort(), inventory.labels.map(label => label.labelId).sort());
});
