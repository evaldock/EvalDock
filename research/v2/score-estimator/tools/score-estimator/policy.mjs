/** Adaptive case selection + an independent SRS residual audit, all on frozen records.
 * Per-step adaptive probabilities are NOT final inclusion probabilities and are never used as HT weights.
 */
import {createHash} from 'node:crypto';
import {assert, digest, finite} from './data.mjs';
import {checkModel, infer} from './model.mjs';

export function random(seed) {
  let step = 0;
  return () => createHash('sha256').update(String(seed)+':'+step++).digest().readUInt32BE(0)/0x100000000;
}
export function shuffle(values, seed) {
  const out = [...values], next = random(seed);
  for (let i = out.length-1; i > 0; i--) {const j = Math.floor(next()*(i+1)); [out[i], out[j]] = [out[j], out[i]];}
  return out;
}
const bounds = x => Math.min(1, Math.max(0, x));
export class Session {
  constructor(data, model, state) {
    checkModel(data, model);
    assert(state.schema === 'evaldock.estimator-session/v1' && state.corpus_digest === data.corpusDigest &&
      state.model_digest === model.model_digest, 'Session protocol/model mismatch');
    assert(data.agents.has(state.agent.agent_id) &&
      digest(state.agent) === digest(data.agents.get(state.agent.agent_id)), 'Session agent identity mismatch');
    this.data = data; this.model = model; this.state = structuredClone(state);
  }
  static create(data, model, agentId, {budget = 100, probes = 20, audit = 20, seed = 0,
    alpha = .05, tolerance = .05, simultaneousLooks = 1} = {}) {
    checkModel(data, model);
    const agent = data.agents.get(agentId);
    assert(agent, 'Unknown evaluation agent');
    assert(!model.training_agents.some(a => a.agent_id === agentId || a.config_hash === agent.config_hash ||
      (agent.split_group && a.split_group === agent.split_group)), 'Training/evaluation agent or split-group leakage');
    assert([budget, probes, audit, simultaneousLooks].every(Number.isSafeInteger) &&
      budget >= 1 && budget <= data.cases.length && audit >= 0 && audit <= budget &&
      probes >= 0 && probes <= budget-audit && simultaneousLooks >= 1, 'Invalid budget/probes/audit/look counts');
    assert(finite(alpha) && alpha > 0 && alpha < 1 && finite(tolerance) && tolerance > 0 && tolerance <= 1, 'Invalid precision policy');
    const session = new Session(data, model, {schema: 'evaldock.estimator-session/v1',
      corpus_digest: data.corpusDigest, model_digest: model.model_digest, agent,
      budget, probes, audit, seed, alpha, tolerance, simultaneousLooks, informative_count: budget-audit,
      phase: 'INFORMATIVE', status: 'WAITING_FOR_SCORES', observations: [], selections: [], pending: []});
    session.request(); return session;
  }
  request() {
    const s = this.state, data = this.data;
    if (s.pending.length || s.status === 'COMPLETE') return;
    const observations = s.observations.filter(o => o.role !== 'audit');
    const used = new Set(observations.map(o => o.case_id));
    const candidates = data.cases.flatMap((c, i) => used.has(c.case_id) ? [] : [i]);
    const {predictions, theta, curvature} = infer(data, this.model, observations);
    if (observations.length === s.informative_count) {
      const indices = shuffle(candidates, s.seed+':audit').slice(0, s.audit);
      // This is fixed before revealing even the first audit response.
      s.audit_design = {remaining_indices: candidates, sample_indices: indices, predictions, theta,
        population_size: candidates.length, inclusion_probability: candidates.length ? indices.length/candidates.length : 1,
        scheme: 'simple-random-without-replacement'};
      s.audit_design_digest = digest(s.audit_design);
      s.phase = 'AUDIT'; s.pending = indices.map(i => data.cases[i].case_id);
      s.selections.push({role: 'audit', case_ids: [...s.pending], population_size: candidates.length,
        inclusion_probability: s.audit_design.inclusion_probability});
      if (!s.pending.length) s.status = 'COMPLETE';
      return;
    }
    const counts = data.labels.map((_, d) => observations.filter(o => Object.hasOwn(o.scores, data.labels[d].label_id)).length);
    const gradient = data.labels.map((_, d) => candidates.reduce((sum, i) => {
      const p = predictions[i][d] ?? 0; return sum+data.weights[i][d]*p*(1-p);
    }, 0));
    const role = observations.length < s.probes ? 'probe' : 'informative';
    const utility = candidates.map(i => {
      let coverage = 0, reduction = 0;
      data.labels.forEach((_, d) => {
        if (!data.weights[i][d]) return;
        coverage += 1/(1+counts[d]);
        const p = predictions[i][d], info = p*(1-p), h = curvature[d];
        reduction += gradient[d]**2*(1/h-1/(h+info));
      });
      return (role === 'probe' ? coverage : reduction+.01*coverage/data.labels.length)/(data.cases[i].expected_cost ?? 1);
    });
    const maximum = Math.max(1e-12, ...utility);
    const soft = utility.map(u => Math.exp(4*(u/maximum-1))), total = soft.reduce((a, b) => a+b, 0);
    const probabilities = soft.map(p => .9*p/total+.1/candidates.length);
    let draw = random(s.seed+':'+role+':'+observations.length)(), position = probabilities.length-1;
    for (let j = 0; j < probabilities.length; j++) {draw -= probabilities[j]; if (draw < 0) {position = j; break;}}
    const cid = data.cases[candidates[position]].case_id;
    s.pending = [cid];
    s.selections.push({role, case_ids: [cid], conditional_draw_probability: probabilities[position],
      candidate_count: candidates.length, utility: utility[position],
      reason: role === 'probe' ? 'coverage-per-cost' : 'approximate-score-variance-reduction-per-cost'});
  }
  advance(oracle) {
    const s = this.state, data = this.data;
    if (s.status === 'COMPLETE') return;
    const pending = [], problems = [], role = s.selections.at(-1).role;
    for (const cid of s.pending) {
      const obs = oracle(cid);
      if (obs === null) {pending.push(cid); continue;}
      assert(obs?.case_id === cid, 'Oracle returned the wrong case');
      const i = data.caseIndex.get(cid);
      const expected = data.labels.flatMap((l, d) => data.weights[i][d] ? [l.label_id] : []);
      if (obs.execution_status === 'INFRA_ERROR' || obs.missing_labels?.length ||
        expected.length !== Object.keys(obs.scores).length || !expected.every(l => Object.hasOwn(obs.scores, l))) {
        pending.push(cid); problems.push({case_id: cid, missing_labels: obs.missing_labels ?? [],
          execution_status: obs.execution_status}); continue;
      }
      assert(Object.values(obs.scores).every(x => finite(x) && x >= 0 && x <= 1), 'Invalid observed normalized score');
      s.observations.push({...structuredClone(obs), role});
    }
    s.pending = pending; s.problems = problems;
    if (pending.length) s.status = problems.length ? 'EVALUATION_INCOMPLETE' : 'WAITING_FOR_SCORES';
    else if (s.phase === 'AUDIT') s.status = 'COMPLETE';
    else {s.status = 'WAITING_FOR_SCORES'; this.request();}
  }
  estimate() {
    const s = this.state, data = this.data;
    if (s.status !== 'COMPLETE') return {status: s.status, pending: s.pending, completed_cases: s.observations.length, labels: null, problems: s.problems ?? []};
    assert(digest(s.audit_design) === s.audit_design_digest, 'Frozen audit design was changed');
    const design = s.audit_design, m = design.remaining_indices.length, n = design.sample_indices.length;
    const byCase = new Map(s.observations.map(o => [o.case_id, o]));
    const informative = s.observations.filter(o => o.role !== 'audit');
    const labels = {};
    data.labels.forEach((label, d) => {
      const contribution = obs => data.weights[data.caseIndex.get(obs.case_id)][d]*(obs.scores[label.label_id] ?? 0);
      const known = informative.reduce((sum, o) => sum+contribution(o), 0);
      const base = known+design.remaining_indices.reduce((sum, i) => sum+data.weights[i][d]*(design.predictions[i][d] ?? 0), 0);
      const residual = design.sample_indices.reduce((sum, i) => {
        const w = data.weights[i][d], o = byCase.get(data.cases[i].case_id);
        return sum+w*((o.scores[label.label_id] ?? 0)-(design.predictions[i][d] ?? 0));
      }, 0);
      const pirt = base+residual, corrected = base+(n ? m/n*residual : 0);
      const observed = s.observations.reduce((sum, o) => sum+contribution(o), 0);
      const remainingWeight = Math.max(0, 1-s.observations.reduce((sum, o) => sum+data.weights[data.caseIndex.get(o.case_id)][d], 0));
      let estimate = n ? corrected : pirt, lower = observed, upper = observed+remainingWeight, status;
      if (remainingWeight < 1e-12) {
        estimate = observed; lower = upper = observed; status = 'CENSUS_COMPLETE';
      } else if (n) {
        // z_i = w_i(y_i-p_i), y_i in [0,1]. Bound its entire finite population,
        // including zero-weight/non-applicable cases in the global SRS frame.
        let lowZ = Infinity, highZ = -Infinity;
        for (const i of design.remaining_indices) {
          const w = data.weights[i][d], p = design.predictions[i][d] ?? 0;
          lowZ = Math.min(lowZ, -w*p); highZ = Math.max(highZ, w*(1-p));
        }
        const half = m*(highZ-lowZ)*Math.sqrt(Math.log(2*data.labels.length*s.simultaneousLooks/s.alpha)/(2*n));
        lower = Math.max(lower, corrected-half); upper = Math.min(upper, corrected+half);
        if (lower > upper) {lower = observed; upper = observed+remainingWeight;}
        // Include the displayed point so the reported tolerance applies to that point.
        lower = Math.min(lower, bounds(estimate)); upper = Math.max(upper, bounds(estimate));
        status = Math.max(bounds(estimate)-lower, upper-bounds(estimate)) <= s.tolerance ? 'PRECISION_MET' : 'BUDGET_LIMITED';
      } else status = 'MODEL_ONLY_UNVALIDATED';
      labels[label.label_id] = {estimate, display_estimate: bounds(estimate), pirt_estimate: pirt,
        frozen_prediction_baseline: base, audit_correction: n ? m/n*residual : null,
        direct_estimate: n ? known+m/n*design.sample_indices.reduce((sum, i) => sum+data.weights[i][d]*(byCase.get(data.cases[i].case_id).scores[label.label_id] ?? 0), 0) : (m === 0 ? known : null),
        lower, upper, status, scored_cases: s.observations.filter(o => Object.hasOwn(o.scores, label.label_id)).length,
        audit_label_cases: s.observations.filter(o => o.role === 'audit' && Object.hasOwn(o.scores, label.label_id)).length};
    });
    const executionCosts = {};
    for (const field of ['cost', 'tokens', 'elapsed_seconds']) {
      const values = s.observations.map(o => o[field]);
      executionCosts[field] = {known_sum: values.reduce((sum, x) => sum+(x ?? 0), 0), unknown_executions: values.filter(x => x == null).length};
    }
    return {status: 'COMPLETE', agent_id: s.agent.agent_id, corpus_digest: data.corpusDigest, model_digest: this.model.model_digest,
      estimator: 'frozen-prediction-plus-independent-audit-residual', executed_cases: s.observations.length,
      audit_population_size: m, audit_sample_size: n, alpha: s.alpha, labels, execution_costs: executionCosts,
      synthetic: this.model.synthetic, interval_method: 'bounded-residual-SRS-Hoeffding-with-label/look-union-bound',
      interval_scope: 'fixed finite response table; not run-to-run or judge uncertainty',
      model_accuracy_validated: false};
  }
}
export function replay(data, model, agentId, options) {
  const session = Session.create(data, model, agentId, options);
  while (session.state.status !== 'COMPLETE') {
    const count = session.state.observations.length;
    session.advance(cid => data.observation(agentId, cid));
    if (session.state.observations.length === count && session.state.status !== 'COMPLETE') break;
  }
  const result = session.estimate();
  if (result.status === 'COMPLETE') {
    const truth = data.truth(agentId); // Accessible only after the selection policy has finished.
    data.labels.forEach((l, d) => Object.assign(result.labels[l.label_id], {truth: truth[d],
      absolute_error: Math.abs(result.labels[l.label_id].estimate-truth[d]),
      covered: result.labels[l.label_id].lower-1e-12 <= truth[d] && truth[d] <= result.labels[l.label_id].upper+1e-12}));
  }
  return {session: session.state, result};
}
export function randomBaseline(data, agentId, budget, seed) {
  assert(Number.isSafeInteger(budget) && budget >= 1 && budget <= data.cases.length, 'Invalid baseline budget');
  const indices = shuffle(data.cases.map((_, i) => i), seed+':baseline').slice(0, budget);
  const estimate = data.labels.map(() => 0);
  for (const i of indices) {
    const obs = data.observation(agentId, data.cases[i].case_id);
    assert(obs && !obs.missing_labels.length && obs.execution_status !== 'INFRA_ERROR', 'Incomplete baseline score');
    data.labels.forEach((l, d) => {estimate[d] += data.weights[i][d]*(obs.scores[l.label_id] ?? 0)*data.cases.length/budget;});
  }
  return Object.fromEntries(data.labels.map((l, d) => [l.label_id, estimate[d]]));
}
