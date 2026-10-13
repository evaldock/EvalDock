import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {Dataset, digest} from '../../tools/score-estimator/data.mjs';
import {fit, infer} from '../../tools/score-estimator/model.mjs';
import {Session, replay, randomBaseline} from '../../tools/score-estimator/policy.mjs';
import {synthetic} from '../../tools/score-estimator/synthetic.mjs';
import {calibrateFusion, applyFusion} from '../../tools/score-estimator/calibration.mjs';

const fixture = (cases = 24, labels = 4) => synthetic({agents: 5, cases, labels, seed: 7});
const prepared = (cases = 24, labels = 4) => {
  const data = new Dataset(fixture(cases, labels));
  return {data, model: fit(data, ['synthetic-agent-0', 'synthetic-agent-1', 'synthetic-agent-2'])};
};
const options = {budget: 12, probes: 3, audit: 4, seed: 8};
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a-b) < tolerance, a+' != '+b);
function consume(session, data, agent = 'synthetic-agent-4') {
  while (session.state.status !== 'COMPLETE') session.advance(cid => data.observation(agent, cid));
  return session.estimate();
}

test('long-form data preserves applicability, real zeros, distinct missing scores and single execution costs', () => {
  const raw = fixture(), first = raw.scores[0]; first.raw_score = 0;
  raw.scores[1].status = 'ERROR'; raw.scores[1].raw_score = null;
  const data = new Dataset(raw);
  const report = data.report();
  assert.equal(report.executions, 120); assert.equal(report.missing_scores, 1);
  assert.equal(data.observation('synthetic-agent-0', 'synthetic-case-0').scores[first.label_id], 0);
  assert.throws(() => data.truth('synthetic-agent-0'), /Incomplete/);
});
test('duplicate case, execution, or score rows are rejected', () => {
  for (const table of ['cases', 'executions', 'scores']) {
    const raw = fixture(); raw[table].push(structuredClone(raw[table][0]));
    assert.throws(() => new Dataset(raw), /[Dd]uplicate/);
  }
});
test('protocol, case, agent and scoring versions cannot be mixed', () => {
  for (const field of ['protocol_id', 'case_version', 'agent_config_hash']) {
    const raw = fixture(); raw.executions[0][field] = 'wrong';
    assert.throws(() => new Dataset(raw), /mismatch/);
  }
  for (const field of ['rubric_version', 'judge_version']) {
    const raw = fixture(); raw.scores[0][field] = 'wrong';
    assert.throws(() => new Dataset(raw), /mismatch/);
  }
});
test('non-applicable scores, invalid scales, weights, repeats and missing values are rejected', () => {
  const edits = [
    r => {delete r.cases[0].labels[r.scores[0].label_id];},
    r => {r.scores[0].raw_score = 101;},
    r => {r.scores[0].raw_score = NaN;},
    r => {r.scores[0].score_01 = -1;},
    r => {r.scores[0].status = 'ERROR';},
    r => {r.cases[0].labels[r.scores[0].label_id] = 0;},
    r => {r.executions[0].repeat_id = 2;},
    r => {r.executions[0].status = 'INFRA_ERROR';},
    r => {r.labels[0].max = r.labels[0].min;},
  ];
  for (const edit of edits) {const raw = fixture(); edit(raw); assert.throws(() => new Dataset(raw));}
});
test('training requires distinct complete agents and preserves fractional response targets', () => {
  const {data, model} = prepared();
  assert.equal(model.kind, 'regularized-fractional-1pl');
  assert.equal(model.synthetic, true);
  assert.ok(model.parameters.every(p => Number.isFinite(p.intercept) && p.diagnostics.converged));
  assert.throws(() => fit(data, ['synthetic-agent-0']), /two/);
  const raw = fixture(); raw.scores.shift();
  assert.throws(() => fit(new Dataset(raw), ['synthetic-agent-0', 'synthetic-agent-1']), /Incomplete/);
});
test('all-zero and all-one training outcomes stay finite under regularization', () => {
  for (const value of [0, 100]) {
    const raw = fixture(10, 2); raw.scores.forEach(s => {s.raw_score = value;});
    const data = new Dataset(raw), model = fit(data, ['synthetic-agent-0', 'synthetic-agent-1']);
    const result = infer(data, model, []);
    assert.ok(result.predictions.flat().every(p => p === null || (p > 0 && p < 1)));
  }
});
test('fit uses only training agents, not held-out scores', () => {
  const raw = fixture(), data = new Dataset(raw), agents = ['synthetic-agent-0', 'synthetic-agent-1'];
  const m = fit(data, agents);
  const held = new Set(raw.executions.filter(e => e.agent_id === 'synthetic-agent-4').map(e => e.execution_id));
  raw.scores.filter(s => held.has(s.execution_id)).forEach(s => {s.raw_score = 100-s.raw_score;});
  assert.deepEqual(fit(new Dataset(raw), agents), m);
});
test('evaluation rejects training identities, config aliases and split groups', () => {
  const {data, model} = prepared();
  assert.throws(() => Session.create(data, model, 'synthetic-agent-0', options), /leakage/);
  for (const key of ['config_hash', 'split_group']) {
    const raw = fixture(); raw.agents[4][key] = raw.agents[0][key];
    if (key === 'config_hash') raw.executions.filter(e => e.agent_id === raw.agents[4].agent_id).forEach(e => {e.agent_config_hash = raw.agents[4].config_hash;});
    const changed = new Dataset(raw);
    assert.throws(() => Session.create(changed, model, raw.agents[4].agent_id, options), /leakage/);
  }
});
test('model corruption and corpus changes are rejected', () => {
  const {data, model} = prepared(), broken = structuredClone(model); broken.parameters[0].intercept += 1;
  assert.throws(() => Session.create(data, broken, 'synthetic-agent-4', options), /integrity/);
  const raw = fixture(); raw.cases[0].expected_cost *= 2;
  assert.throws(() => Session.create(new Dataset(raw), model, 'synthetic-agent-4', options), /mismatch/);
});
test('adaptive policy reveals only pending cases, counts each case once and is reproducible', () => {
  const {data, model} = prepared();
  const session = Session.create(data, model, 'synthetic-agent-4', options);
  const calls = [];
  while (session.state.status !== 'COMPLETE') {
    const allowed = new Set(session.state.pending);
    session.advance(cid => {assert.ok(allowed.has(cid)); calls.push(cid); return data.observation('synthetic-agent-4', cid);});
  }
  assert.equal(calls.length, 12); assert.equal(new Set(calls).size, 12);
  const second = replay(data, model, 'synthetic-agent-4', options);
  assert.deepEqual(second.session.selections, session.state.selections);
  close(session.estimate().execution_costs.tokens.known_sum,
    calls.reduce((sum, cid) => sum+data.observation('synthetic-agent-4', cid).tokens, 0));
  assert.ok(session.state.selections.filter(s => s.role !== 'audit').every(s => s.conditional_draw_probability > 0));
});
test('policy never invokes matrix/truth while selecting cases', () => {
  const {data, model} = prepared();
  data.matrix = () => {throw Error('future matrix leak');};
  data.truth = () => {throw Error('future truth leak');};
  const session = Session.create(data, model, 'synthetic-agent-4', options);
  assert.equal(consume(session, data).status, 'COMPLETE');
});
test('dynamic choices can differ with revealed responses under the same seed', () => {
  const {data, model} = prepared(50, 8), low = Session.create(data, model, 'synthetic-agent-4', {...options, budget: 30});
  const high = Session.create(data, model, 'synthetic-agent-4', {...options, budget: 30});
  const feed = (s, value) => {
    while (s.state.status !== 'COMPLETE') s.advance(cid => {
      const obs = data.observation('synthetic-agent-4', cid);
      Object.keys(obs.scores).forEach(k => {obs.scores[k] = value;}); return obs;
    });
  };
  feed(low, 0); feed(high, 1);
  assert.notDeepEqual(low.state.selections.map(x => x.case_ids), high.state.selections.map(x => x.case_ids));
});
test('unrun or unassessable selected cases remain pending and are never silently replaced', () => {
  const {data, model} = prepared(), s = Session.create(data, model, 'synthetic-agent-4', options);
  const pending = [...s.state.pending];
  s.advance(() => null); assert.equal(s.state.status, 'WAITING_FOR_SCORES'); assert.deepEqual(s.state.pending, pending);
  s.advance(cid => ({...data.observation('synthetic-agent-4', cid), missing_labels: ['missing']}));
  assert.equal(s.state.status, 'EVALUATION_INCOMPLETE'); assert.equal(s.estimate().labels, null);
  assert.deepEqual(s.state.pending, pending);
  assert.equal(consume(s, data).status, 'COMPLETE');
});
test('resume keeps requests and frozen audit predictions unchanged', () => {
  const {data, model} = prepared(), s = Session.create(data, model, 'synthetic-agent-4', options);
  while (s.state.phase !== 'AUDIT') s.advance(cid => data.observation('synthetic-agent-4', cid));
  const frozen = digest(s.state.audit_design), selected = [...s.state.pending];
  s.advance(cid => cid === selected[0] ? data.observation('synthetic-agent-4', cid) : null);
  const resumed = new Session(data, model, JSON.parse(JSON.stringify(s.state)));
  consume(resumed, data);
  assert.equal(digest(resumed.state.audit_design), frozen);
  assert.deepEqual(resumed.state.audit_design.sample_indices.map(i => data.cases[i].case_id), selected);
});
test('census exactly recovers every target score with zero interval width', () => {
  const {data, model} = prepared();
  const {result} = replay(data, model, 'synthetic-agent-4', {...options, budget: data.cases.length});
  const truth = data.truth('synthetic-agent-4');
  data.labels.forEach((l, d) => {
    const row = result.labels[l.label_id];
    close(row.estimate, truth[d]); close(row.lower, row.upper);
    assert.equal(row.status, 'CENSUS_COMPLETE');
  });
});
test('audit residual is unbiased by enumeration with unequal weights (no double correction)', () => {
  const raw = fixture(4, 2);
  raw.cases.forEach((c, i) => Object.keys(c.labels).forEach(l => {c.labels[l] = i+1;}));
  const data = new Dataset(raw), model = fit(data, ['synthetic-agent-0', 'synthetic-agent-1']);
  const totals = data.labels.map(() => 0);
  for (let i = 0; i < 4; i++) {
    const s = Session.create(data, model, 'synthetic-agent-4', {budget: 1, audit: 1, probes: 0});
    s.state.audit_design.sample_indices = [i]; s.state.audit_design_digest = digest(s.state.audit_design);
    s.state.pending = [data.cases[i].case_id]; const result = consume(s, data);
    data.labels.forEach((l, d) => {totals[d] += result.labels[l.label_id].estimate/4;});
  }
  data.truth('synthetic-agent-4').forEach((t, d) => close(totals[d], t));
});
test('SRS baseline respects unequal target weights and recovers census', () => {
  const {data} = prepared();
  const result = randomBaseline(data, 'synthetic-agent-4', data.cases.length, 7), truth = data.truth('synthetic-agent-4');
  data.labels.forEach((l, d) => close(result[l.label_id], truth[d]));
});
test('zero empirical variation does not collapse an unmeasured target interval', () => {
  const {data, model} = prepared();
  const s = Session.create(data, model, 'synthetic-agent-4', options);
  while (s.state.status !== 'COMPLETE') s.advance(cid => {
    const o = data.observation('synthetic-agent-4', cid); Object.keys(o.scores).forEach(k => {o.scores[k] = 1;}); return o;
  });
  assert.ok(Object.values(s.estimate().labels).some(r => r.upper-r.lower > .1));
});
test('model-only mode does not claim calibrated precision', () => {
  const {data, model} = prepared();
  const {result} = replay(data, model, 'synthetic-agent-4', {...options, audit: 0});
  assert.ok(Object.values(result.labels).every(r => r.status === 'MODEL_ONLY_UNVALIDATED'));
});
test('frozen fusion calibrates on validation agents and cannot evaluate them again', () => {
  const {data, model} = prepared();
  const record = {budget: options.budget, ...replay(data, model, 'synthetic-agent-3', options)};
  const cal = calibrateFusion(data, model, [record], ['synthetic-agent-3']);
  const testResult = replay(data, model, 'synthetic-agent-4', options).result;
  const result = applyFusion(data, model, cal, 'synthetic-agent-4', options.budget, testResult);
  for (const row of Object.values(result.labels)) {
    assert.ok(row.lambda >= 0 && row.lambda <= 1);
    assert.ok(row.lower <= row.upper); assert.equal(row.status, 'FUSION_UNCERTIFIED');
  }
  assert.throws(() => applyFusion(data, model, cal, 'synthetic-agent-3', options.budget, record.result), /Validation agent/);
});
test('CLI performs synthetic -> validate -> fit -> init/step -> replay, rejects overwrite and unknown options', async t => {
  const root = process.cwd(), base = path.join(root, 'var');
  await mkdir(base, {recursive: true}); const dir = await mkdtemp(path.join(base, 'score-estimator-test-'));
  t.after(async () => {assert.ok(dir.startsWith(base+path.sep)); await rm(dir, {recursive: true, force: true});});
  const cli = path.join(root, 'tools/score-estimator/cli.mjs');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], {cwd: root, encoding: 'utf8'}));
  const data = path.join(dir, 'data.json'), model = path.join(dir, 'model.json'), session = path.join(dir, 'session.json');
  run('synthetic', '--out', data, '--cases', '20', '--labels', '3');
  assert.equal(run('validate', '--data', data).missing_scores, 0);
  run('fit', '--data', data, '--agents', 'synthetic-agent-0,synthetic-agent-1,synthetic-agent-2', '--out', model);
  run('init', '--data', data, '--model', model, '--agent', 'synthetic-agent-4', '--budget', '8', '--probes', '2', '--audit', '2', '--out', session);
  run('step', '--data', data, '--model', model, '--session', session, '--out', path.join(dir, 'next.json'));
  run('replay', '--data', data, '--model', model, '--agents', 'synthetic-agent-4', '--budgets', '8', '--probes', '2', '--audit', '2', '--seeds', '1', '--out', path.join(dir, 'replay.json'));
  const saved = JSON.parse(await readFile(path.join(dir, 'replay.json'), 'utf8'));
  assert.equal(saved.records[0].result.executed_cases, 8); assert.equal(saved.synthetic, true);
  assert.notEqual(spawnSync(process.execPath, [cli, 'synthetic', '--out', data], {cwd: root}).status, 0);
  assert.notEqual(spawnSync(process.execPath, [cli, 'validate', '--data', data, '--typo', '1'], {cwd: root}).status, 0);
  const broken = JSON.parse(await readFile(session, 'utf8')); broken.seed = 123;
  const bad = path.join(dir, 'bad.json'); await writeFile(bad, JSON.stringify(broken));
  assert.notEqual(spawnSync(process.execPath, [cli, 'step', '--data', data, '--model', model, '--session', bad, '--out', path.join(dir, 'unused.json')], {cwd: root}).status, 0);
});

test('conditional residual/direct estimates recover truth when informative cases are already fixed', () => {
  const raw = fixture(5, 2);
  raw.cases.forEach((c, i) => Object.keys(c.labels).forEach(l => {c.labels[l] = i+1;}));
  const data = new Dataset(raw), model = fit(data, ['synthetic-agent-0', 'synthetic-agent-1']);
  const base = Session.create(data, model, 'synthetic-agent-4', {budget: 2, probes: 1, audit: 1, seed: 14});
  base.advance(cid => data.observation('synthetic-agent-4', cid));
  assert.equal(base.state.phase, 'AUDIT');
  const population = base.state.audit_design.remaining_indices, mean = [0, 0], direct = [0, 0];
  for (const i of population) {
    const s = new Session(data, model, base.state);
    s.state.audit_design.sample_indices = [i]; s.state.audit_design_digest = digest(s.state.audit_design);
    s.state.pending = [data.cases[i].case_id];
    const result = consume(s, data);
    data.labels.forEach((l, d) => {
      mean[d] += result.labels[l.label_id].estimate/population.length;
      direct[d] += result.labels[l.label_id].direct_estimate/population.length;
    });
  }
  data.truth('synthetic-agent-4').forEach((t, d) => {close(mean[d], t); close(direct[d], t);});
});
test('no sampled observations of a rare label cannot establish its precision', () => {
  const raw = fixture(20, 3), rare = raw.labels[2].label_id;
  raw.cases.forEach((c, i) => {if (i !== 0) delete c.labels[rare];});
  const caseForExecution = new Map(raw.executions.map(e => [e.execution_id, e.case_id]));
  raw.scores = raw.scores.filter(s => s.label_id !== rare || caseForExecution.get(s.execution_id) === raw.cases[0].case_id);
  // Give case 0 the rare label explicitly, regardless of generated label count.
  raw.cases[0].labels[rare] = 1;
  for (const ex of raw.executions.filter(e => e.case_id === raw.cases[0].case_id)) {
    if (!raw.scores.some(s => s.execution_id === ex.execution_id && s.label_id === rare)) {
      raw.scores.push({execution_id: ex.execution_id, label_id: rare, raw_score: 50, status: 'SCORED',
        rubric_version: 'synthetic-v1', judge_version: raw.protocol.judge_version});
    }
  }
  const data = new Dataset(raw), model = fit(data, ['synthetic-agent-0', 'synthetic-agent-1']);
  const s = Session.create(data, model, 'synthetic-agent-4', {budget: 1, probes: 0, audit: 1});
  s.state.audit_design.sample_indices = [1]; s.state.audit_design_digest = digest(s.state.audit_design);
  s.state.pending = [data.cases[1].case_id];
  const row = consume(s, data).labels[rare];
  assert.equal(row.audit_label_cases, 0); assert.equal(row.lower, 0); assert.equal(row.upper, 1);
  assert.equal(row.status, 'BUDGET_LIMITED');
});
test('nonconverged fits are recorded explicitly and cannot be mistaken for a passed optimizer', () => {
  const data = new Dataset(fixture()), model = fit(data, ['synthetic-agent-0', 'synthetic-agent-1'], {maxIterations: 1});
  assert.ok(model.parameters.every(p => !p.diagnostics.converged));
});
