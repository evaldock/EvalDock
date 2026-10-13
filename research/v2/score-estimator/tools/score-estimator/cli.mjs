#!/usr/bin/env node
/** Standalone offline CLI. Does not import any live runner, Judge client, queue or service. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Dataset, assert, digest} from './data.mjs';
import {fit} from './model.mjs';
import {Session, replay, randomBaseline} from './policy.mjs';
import {synthetic} from './synthetic.mjs';
import {calibrateFusion, applyFusion} from './calibration.mjs';

const read = async p => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
async function save(file, value) {
  assert(file, '--out is required');
  await mkdir(path.dirname(path.resolve(file)), {recursive: true});
  await writeFile(file, JSON.stringify(value, null, 2)+'\n', {flag: 'wx', mode: 0o600});
}
function parse(argv) {
  const [command = 'help', ...rest] = argv, options = {};
  for (let i = 0; i < rest.length; i += 2) {
    assert(rest[i].startsWith('--') && rest[i+1] !== undefined && !rest[i+1].startsWith('--'), 'Use --option value');
    const key = rest[i].slice(2); assert(!Object.hasOwn(options, key), 'Duplicate option: '+key); options[key] = rest[i+1];
  }
  const allowed = {
    help: [], synthetic: ['out', 'agents', 'cases', 'labels', 'seed'], validate: ['data', 'out'],
    fit: ['data', 'agents', 'out', 'ability-ridge', 'item-ridge', 'iterations'],
    init: ['data', 'model', 'agent', 'out', 'budget', 'probes', 'audit', 'seed', 'alpha', 'tolerance', 'looks'],
    step: ['data', 'model', 'session', 'out'], estimate: ['data', 'model', 'session', 'out', 'fusion'],
    replay: ['data', 'model', 'agents', 'out', 'budgets', 'probes', 'audit', 'seeds', 'alpha', 'tolerance', 'fusion'],
    calibrate: ['data', 'model', 'agents', 'out', 'budgets', 'probes', 'audit', 'seeds', 'alpha', 'tolerance'],
  };
  assert(allowed[command], 'Unknown command: '+command);
  for (const k of Object.keys(options)) assert(allowed[command].includes(k), 'Unknown option: --'+k);
  return {command, options};
}
const number = (o, k, fallback) => {
  const n = o[k] === undefined ? fallback : Number(o[k]); assert(Number.isFinite(n), 'Invalid number: '+k); return n;
};
const ids = o => {assert(o.agents, '--agents must explicitly identify training/validation/test agents'); return o.agents.split(',');};
function seal(state) {return {...state, session_digest: digest(state)};}
function openState(artifact) {
  const {session_digest, ...state} = artifact;
  assert(digest(state) === session_digest, 'Session file integrity mismatch'); return state;
}
function policy(o, overrides = {}) {
  return {budget: number(o, 'budget', 100), probes: number(o, 'probes', 20), audit: number(o, 'audit', 20),
    seed: number(o, 'seed', 0), alpha: number(o, 'alpha', .05), tolerance: number(o, 'tolerance', .05),
    simultaneousLooks: number(o, 'looks', 1), ...overrides};
}
const quantile = (xs, q) => {const a = [...xs].sort((x, y) => x-y); return a[Math.max(0, Math.ceil(q*a.length)-1)];};
export async function main(argv = process.argv.slice(2)) {
  const {command, options: o} = parse(argv);
  if (command === 'help') {
    console.log('Offline score estimator: synthetic | validate | fit | init | step | estimate | replay | calibrate\nSee docs/SCORE_ESTIMATOR.md. Outputs are exclusive: existing files are never overwritten.'); return;
  }
  if (command === 'synthetic') {
    const raw = synthetic({agents: number(o, 'agents', 5), cases: number(o, 'cases', 1514),
      labels: number(o, 'labels', 30), seed: number(o, 'seed', 42)});
    await save(o.out, raw); console.log(JSON.stringify({synthetic: true, ...new Dataset(raw).report()})); return;
  }
  assert(o.data, '--data is required');
  const data = new Dataset(await read(o.data));
  if (command === 'validate') {
    const report = data.report(); if (o.out) await save(o.out, report);
    console.log(JSON.stringify(report)); return;
  }
  if (command === 'fit') {
    const model = fit(data, ids(o), {abilityRidge: number(o, 'ability-ridge', 2), itemRidge: number(o, 'item-ridge', 5),
      maxIterations: number(o, 'iterations', 500)});
    await save(o.out, model);
    console.log(JSON.stringify({model_digest: model.model_digest, synthetic: model.synthetic,
      nonconverged_labels: model.parameters.filter(p => !p.diagnostics.converged).map(p => p.label_id)})); return;
  }
  assert(o.model, '--model is required'); const model = await read(o.model);
  if (command === 'init') {
    assert(o.agent, '--agent is required');
    const s = Session.create(data, model, o.agent, policy(o)); await save(o.out, seal(s.state));
    console.log(JSON.stringify({status: s.state.status, pending: s.state.pending})); return;
  }
  if (command === 'step' || command === 'estimate') {
    assert(o.session, '--session is required');
    const s = new Session(data, model, openState(await read(o.session)));
    // A frozen earlier response cannot silently change during a resumed session.
    for (const old of s.state.observations) {
      const current = data.observation(s.state.agent.agent_id, old.case_id);
      assert(current && digest(current) === digest(Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'role'))), 'Previously consumed observation changed');
    }
    if (command === 'step') {
      s.advance(cid => data.observation(s.state.agent.agent_id, cid)); await save(o.out, seal(s.state));
      console.log(JSON.stringify({status: s.state.status, pending: s.state.pending, completed: s.state.observations.length})); return;
    }
    let result = s.estimate();
    if (o.fusion) result = applyFusion(data, model, await read(o.fusion), s.state.agent.agent_id, s.state.budget, result);
    await save(o.out, result); console.log(JSON.stringify({status: result.status})); return;
  }
  const agents = ids(o), budgets = (o.budgets ?? '100').split(',').map(Number), seeds = number(o, 'seeds', 5);
  assert(new Set(agents).size === agents.length && new Set(budgets).size === budgets.length &&
    Number.isSafeInteger(seeds) && seeds > 0, 'Duplicate agents/budgets or invalid seeds');
  // Offline validation needs the whole frozen truth table, unlike init/step.
  data.matrix(agents);
  const records = [], fusion = o.fusion ? await read(o.fusion) : null;
  for (const budget of budgets) for (const agent of agents) for (let seed = 0; seed < seeds; seed++) {
    const output = replay(data, model, agent, policy(o, {budget, seed, simultaneousLooks: budgets.length}));
    assert(output.result.status === 'COMPLETE', 'Replay incomplete: '+agent);
    if (fusion) output.result = applyFusion(data, model, fusion, agent, budget, output.result);
    const baseline = randomBaseline(data, agent, budget, seed);
    for (const [lid, row] of Object.entries(output.result.labels)) {
      row.random_baseline_estimate = baseline[lid]; row.random_baseline_error = Math.abs(baseline[lid]-row.truth);
      row.pirt_error = Math.abs(row.pirt_estimate-row.truth);
    }
    records.push({budget, seed, agent_id: agent, ...output});
  }
  if (command === 'calibrate') {
    const artifact = calibrateFusion(data, model, records, agents); await save(o.out, artifact);
    console.log(JSON.stringify({validation_agents: agents, calibration_digest: artifact.calibration_digest})); return;
  }
  const summary = [];
  for (const budget of budgets) for (const label of data.labels) {
    const rows = records.filter(r => r.budget === budget).map(r => r.result.labels[label.label_id]);
    const avg = key => rows.reduce((s, r) => s+r[key], 0)/rows.length;
    summary.push({budget, label_id: label.label_id, mae: avg('absolute_error'),
      p95_error: quantile(rows.map(r => r.absolute_error), .95), max_error: Math.max(...rows.map(r => r.absolute_error)),
      pirt_mae: avg('pirt_error'), random_baseline_mae: avg('random_baseline_error'),
      coverage: rows.filter(r => r.covered).length/rows.length,
      precision_met_rate: rows.filter(r => ['PRECISION_MET', 'CENSUS_COMPLETE'].includes(r.status)).length/rows.length});
  }
  const result = {schema: 'evaldock.estimator-replay/v1', synthetic: model.synthetic, independent_agent_count: agents.length,
    simulations: records.length, score_scale: '[0,1]; multiply errors by 100 for points', summary, records,
    warning: 'Synthetic results and repeated seeds do not establish real-agent accuracy. Fixed-table replay excludes execution/judge variability.'};
  await save(o.out, result);
  console.log(JSON.stringify({synthetic: result.synthetic, simulations: records.length, independent_agents: agents.length, out: o.out}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {console.error('score-estimator: '+error.message); process.exitCode = 1;});
}
