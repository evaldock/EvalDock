/** Frozen corpus + long-form execution/score records. No model calls or environment access. */
import {createHash} from 'node:crypto';

export function assert(ok, message) { if (!ok) throw new Error(message); }
export const finite = x => typeof x === 'number' && Number.isFinite(x);
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function index(rows, key) {
  assert(Array.isArray(rows), 'Expected array: ' + key);
  const out = new Map();
  for (const row of rows) {
    assert(row && nonempty(row[key]) && !out.has(row[key]), 'Missing/duplicate ' + key);
    out.set(row[key], row);
  }
  return out;
}
const pair = (a, b) => JSON.stringify([a, b]);

export class Dataset {
  constructor(raw) {
    assert(raw?.schema === 'evaldock.estimator-data/v1', 'Invalid data schema');
    assert(nonempty(raw.protocol?.id) && nonempty(raw.protocol?.judge_version), 'Missing protocol/judge version');
    assert(raw.protocol.repeat_policy === 'single_attempt', 'v1 requires frozen single_attempt policy');
    this.raw = structuredClone(raw);
    this.labels = [...index(this.raw.labels, 'label_id').values()];
    this.cases = [...index(this.raw.cases, 'case_id').values()];
    this.agents = index(this.raw.agents, 'agent_id');
    assert(this.labels.length && this.cases.length && this.agents.size, 'Empty labels/cases/agents');
    this.labelIndex = new Map(this.labels.map((x, i) => [x.label_id, i]));
    this.caseIndex = new Map(this.cases.map((x, i) => [x.case_id, i]));
    this.labels.forEach(l => assert(finite(l.min) && finite(l.max) && l.max > l.min && finite(l.max-l.min) && nonempty(l.rubric_version), 'Invalid label scale/version'));
    for (const a of this.agents.values()) assert(nonempty(a.config_hash), 'Missing agent config_hash');
    const totals = this.labels.map(() => 0);
    this.weights = this.cases.map(c => {
      assert(nonempty(c.case_version) && c.labels && Object.keys(c.labels).length, 'Missing case version/labels');
      assert(finite(c.expected_cost ?? 1) && (c.expected_cost ?? 1) > 0, 'Invalid expected_cost');
      const w = this.labels.map(() => 0);
      for (const [lid, weight] of Object.entries(c.labels)) {
        assert(this.labelIndex.has(lid) && finite(weight) && weight > 0, 'Unknown label or nonpositive weight');
        const d = this.labelIndex.get(lid); w[d] = weight; totals[d] += weight;
      }
      return w;
    });
    assert(totals.every(x => finite(x) && x > 0), 'A target label has no applicable cases');
    this.weights.forEach(w => w.forEach((v, d) => { w[d] = v / totals[d]; }));
    this.corpusDigest = digest({protocol: this.raw.protocol, labels: this.labels, cases: this.cases});
    this.executions = index(this.raw.executions, 'execution_id');
    this.byPair = new Map();
    for (const ex of this.executions.values()) {
      const a = this.agents.get(ex.agent_id), i = this.caseIndex.get(ex.case_id);
      assert(a && i !== undefined, 'Execution references unknown agent/case');
      assert(ex.protocol_id === raw.protocol.id && ex.agent_config_hash === a.config_hash &&
        ex.case_version === this.cases[i].case_version, 'Execution protocol/config/case version mismatch');
      assert((ex.repeat_id ?? 1) === 1, 'Repeated attempts need an explicitly frozen aggregation policy');
      assert(['COMPLETED', 'AGENT_FAILED', 'AGENT_TIMEOUT', 'INFRA_ERROR'].includes(ex.status), 'Invalid execution status');
      const key = pair(ex.agent_id, ex.case_id);
      assert(!this.byPair.has(key), 'Duplicate agent-case execution');
      this.byPair.set(key, ex);
      for (const k of ['tokens', 'cost', 'elapsed_seconds']) assert(ex[k] == null || (finite(ex[k]) && ex[k] >= 0), 'Invalid usage: ' + k);
    }
    this.scores = new Map();
    assert(Array.isArray(this.raw.scores), 'Expected scores array');
    for (const score of this.raw.scores) {
      const ex = this.executions.get(score.execution_id), d = this.labelIndex.get(score.label_id);
      assert(ex && d !== undefined, 'Score references unknown execution/label');
      const i = this.caseIndex.get(ex.case_id), label = this.labels[d], key = pair(ex.execution_id, score.label_id);
      assert(this.weights[i][d] > 0, 'Score for non-applicable label');
      assert(!this.scores.has(key), 'Duplicate execution-label score');
      assert(score.rubric_version === label.rubric_version && score.judge_version === raw.protocol.judge_version, 'Score rubric/judge version mismatch');
      let value = null;
      if (score.status === 'SCORED') {
        assert(ex.status !== 'INFRA_ERROR', 'Infrastructure failure cannot become an agent score');
        assert(finite(score.raw_score) && score.raw_score >= label.min && score.raw_score <= label.max, 'Invalid raw score');
        value = (score.raw_score - label.min) / (label.max - label.min);
        assert(score.score_01 === undefined || (finite(score.score_01) && Math.abs(score.score_01 - value) < 1e-9), 'Normalized/raw score mismatch');
      } else {
        assert(['UNASSESSABLE', 'ERROR'].includes(score.status) && score.raw_score === null &&
          (score.score_01 === undefined || score.score_01 === null), 'Missing score must stay null');
      }
      this.scores.set(key, {...score, value});
    }
  }
  observation(agentId, caseId) {
    assert(this.agents.has(agentId) && this.caseIndex.has(caseId), 'Unknown requested agent/case');
    const ex = this.byPair.get(pair(agentId, caseId));
    if (!ex) return null;
    const i = this.caseIndex.get(caseId), scores = {}, missing = [];
    this.labels.forEach((label, d) => {
      if (!this.weights[i][d]) return;
      const s = this.scores.get(pair(ex.execution_id, label.label_id));
      if (!s || s.value === null) missing.push(label.label_id);
      else scores[label.label_id] = s.value;
    });
    return {case_id: caseId, execution_id: ex.execution_id, scores, missing_labels: missing,
      execution_status: ex.status, tokens: ex.tokens ?? null, cost: ex.cost ?? null,
      elapsed_seconds: ex.elapsed_seconds ?? null};
  }
  matrix(agentIds, requireComplete = true) {
    return agentIds.map(a => {
      assert(this.agents.has(a), 'Unknown agent: ' + a);
      return this.cases.map((c, i) => {
        const o = this.observation(a, c.case_id);
        return this.labels.map((l, d) => {
          const value = o?.scores[l.label_id] ?? null;
          assert(!requireComplete || !this.weights[i][d] || value !== null, 'Incomplete applicable scores: ' + a + '/' + c.case_id + '/' + l.label_id);
          return value;
        });
      });
    });
  }
  truth(agentId) {
    const y = this.matrix([agentId])[0];
    return this.labels.map((_, d) => this.weights.reduce((sum, w, i) => sum + w[d] * (y[i][d] ?? 0), 0));
  }
  report() {
    const y = this.matrix([...this.agents.keys()], false);
    const pairs = this.weights.reduce((s, w) => s + w.filter(x => x > 0).length, 0);
    const scored = y.flat(2).filter(x => x !== null).length;
    return {corpus_digest: this.corpusDigest, agents: this.agents.size, cases: this.cases.length,
      labels: this.labels.length, applicable_pairs: pairs, expected_executions: this.agents.size * this.cases.length,
      executions: this.executions.size, expected_scores: pairs * this.agents.size, scored,
      missing_scores: pairs * this.agents.size - scored,
      complete_agents: [...this.agents.keys()].filter((_, a) => this.weights.every((w, i) => w.every((v, d) => !v || y[a][i][d] !== null)))};
  }
}
