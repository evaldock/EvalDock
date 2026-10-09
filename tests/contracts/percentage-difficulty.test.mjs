import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {loadLabels} from '../../dist/src/labels/catalog.js';
import {loadDatasetDescriptionCatalog} from '../../dist/src/datasets/catalog.js';
import {currentQuestionCases} from '../../dist/src/datasets/loader.js';
import {judgePrompt, parseLabelScore, OpenAiCompatibleLabelJudge} from '../../dist/src/evaluation/llm-label-judge.js';
import {aggregateScores} from '../../dist/src/evaluation/scoring.js';
import {digestValue} from '../../dist/src/core/models.js';
import {judgeInput} from './support.mjs';

const labels = await loadLabels('labels');
const input = {...judgeInput(), label: labels.find(l => l.labelId === 'label.tool-code/v1')};
const score = (value, target = input) => parseLabelScore(JSON.stringify({score: value, reason: 'Fixture evidence'}), target, 'fixture');

test('all live label rubrics use five concise requirements and percentage guidance', () => {
  assert.equal(labels.length, 15);
  for (const label of labels) {
    assert.equal(label.version, '3.0.0');
    assert.equal(label.scoringStandard.scoring_scale.max, 100);
    const text = JSON.stringify(label);
    assert.doesNotMatch(text, /0[–-]5(?!\d)|(?<![\d.])[1-5]\s*分/);
    assert.equal(label.scoringStandard.sections[0].heading, '五条评分要求');
    assert.equal(label.scoringStandard.sections[0].content.length, 5);
    assert.equal(label.scoringStandard.sections.length, 2);
    assert.ok(label.scoringStandard.sections[0].content.every(x => typeof x === 'string'));
    assert.match(label.scoringStandard.sections[1].content[0], /60–74/);
    assert.match(label.scoringStandard.sections[1].content[0], /75–89/);
    assert.match(label.scoringStandard.sections[1].content[0], /不为满足分布/);
  }
  assert.match(JSON.stringify(labels.find(l => l.labelId === 'label.collaboration/v1')), /模拟协作只评价方案/);
});

test('percentage Judge accepts precise values, endpoints and null, rejects out-of-range results', () => {
  for (const n of [0, 3.25, 83.5, 100]) {
    const result = score(n);
    assert.equal(result.score, n); // No inferred scale conversion, including small percentages.
    assert.deepEqual(result.scale, {min: 0, max: 100});
  }
  for (const n of [-0.01, 100.01]) assert.throws(() => score(n), /OUT_OF_RANGE/);
  const result = aggregateScores([score(0), score(100), score(null)])[0];
  assert.equal(result.score, 50);
  assert.equal(result.scoredCases, 2);
  assert.equal(result.unassessableCases, 1);
  assert.equal(result.max, 100);
});

test('frozen five-point records stay five-point and cannot be aggregated with the new standard', () => {
  const legacyDefinition = {...input.label, version: '2.0.0', scoringStandard: {...input.label.scoringStandard, scoring_scale: {min: 0, max: 5}}};
  const legacy = {...input, label: {...legacyDefinition, contentDigest: digestValue(legacyDefinition)}};
  const oldScore = score(4.25, legacy);
  assert.equal(oldScore.score, 4.25);
  assert.equal(oldScore.scale.max, 5);
  assert.equal(aggregateScores([oldScore])[0].score, 4.25);
  assert.throws(() => aggregateScores([oldScore, score(85)]), /Cannot mix scoring standards/);
});

test('the real request payload supplies percentage standards and preserves a mocked provider score', async () => {
  let body;
  const judge = new OpenAiCompatibleLabelJudge({endpoint: 'https://fixture.test/judge', apiKey: 'fixture', model: 'fixture', fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({choices: [{message: {content: '{"score":83.5,"reason":"Supported fixture"}'}}]}));
  }});
  const result = await judge.evaluate(input);
  const prompt = JSON.parse(body.messages[1].content);
  assert.equal(prompt.label.scoringStandard.scoring_scale.max, 100);
  assert.doesNotMatch(prompt.output_schema.score, /4\.25/);
  assert.equal(result.score, 83.5);
  assert.equal(result.scale.max, 100);
  assert.equal(judgePrompt(input).all_trace, input.allTrace);
});

test('published difficulty metadata has no real task hints and static inventory has no task copies', async () => {
 const difficulty=JSON.parse(await readFile('planning/case-difficulty.json','utf8'));
 const inventory=JSON.parse(await readFile('workbench/design-prototypes/question-inventory/index.json','utf8'));
 assert.deepEqual(difficulty.cases,[]);assert.deepEqual(inventory.datasets,[]);
 assert.equal(inventory.labels.length,labels.length);
});

test('workbench chart captions and aggregates follow recorded scales and hide mixed standards', async () => {
  const html = await readFile('workbench/design-prototypes/index.html', 'utf8');
  const source = html.slice(html.indexOf('function aggregate()'), html.indexOf('function judgeOnlyFailure'));
  function displayed(items) {
    const context = {dimensions: ['tool.code'], cases: items.map(s => ({weight: 1, scores: {'tool.code': s}})), activeRun: null};
    vm.createContext(context); vm.runInContext(source, context);
    return {dimensions: vm.runInContext('scoredDimensions()', context), caption: vm.runInContext('scoreScaleCaption()', context)};
  }
  const old = {state: 'scored', value: 4.25, scale: {min: 0, max: 5}, standardDigest: 'old'};
  const current = {state: 'scored', value: 83.5, scale: {min: 0, max: 100}, standardDigest: 'new'};
  assert.equal(displayed([old]).caption, '满分 5');
  assert.equal(displayed([current]).caption, '满分 100');
  assert.equal(displayed([current]).dimensions[0].value, 83.5);
  assert.equal(displayed([old, current]).dimensions.length, 0);
});
