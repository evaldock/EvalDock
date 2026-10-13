/** Optional gp-IRT-style convex fusion, calibrated on separate validation agents.
 * The residual-audit estimator remains the source of design-based uncertainty.
 */
import {assert, digest, finite} from './data.mjs';

export function calibrateFusion(data, model, records, validationIds) {
  assert(records.length && validationIds.length && new Set(validationIds).size === validationIds.length, 'Empty/duplicate validation set');
  const validation = validationIds.map(id => {assert(data.agents.has(id), 'Unknown validation agent'); return data.agents.get(id);});
  for (const a of validation) assert(!model.training_agents.some(t => t.agent_id === a.agent_id ||
    t.config_hash === a.config_hash || (a.split_group && a.split_group === t.split_group)), 'Training/validation leakage');
  assert(records.every(r => r.result.status === 'COMPLETE' && r.result.model_digest === model.model_digest &&
    r.result.corpus_digest === data.corpusDigest && validationIds.includes(r.result.agent_id)), 'Invalid calibration records');
  const budgets = [...new Set(records.map(r => r.budget))], weights = {};
  for (const budget of budgets) {
    weights[budget] = {};
    for (const l of data.labels) {
      let xx = 0, xy = 0;
      for (const record of records.filter(r => r.budget === budget)) {
        const row = record.result.labels[l.label_id];
        assert(finite(row.direct_estimate) && finite(row.truth) && finite(row.pirt_estimate), 'Calibration requires complete audited scores');
        const x = row.direct_estimate-row.pirt_estimate;
        xx += x*x; xy += x*(row.pirt_estimate-row.truth);
      }
      weights[budget][l.label_id] = xx > 1e-15 ? Math.min(1, Math.max(0, -xy/xx)) : 1;
    }
  }
  const artifact = {schema: 'evaldock.score-fusion/v1', corpus_digest: data.corpusDigest,
    model_digest: model.model_digest, validation_agents: validation, weights,
    meaning: 'lambda * conditional-direct-estimate + (1-lambda) * pirt',
    synthetic: model.synthetic, independent_agent_count: validation.length,
    warning: 'Repeated seeds are not independent validation agents; no automatic accuracy certification.'};
  return {...artifact, calibration_digest: digest(artifact)};
}
export function applyFusion(data, model, artifact, agentId, budget, result) {
  const {calibration_digest, ...body} = artifact;
  assert(artifact.schema === 'evaldock.score-fusion/v1' && digest(body) === calibration_digest &&
    artifact.corpus_digest === data.corpusDigest && artifact.model_digest === model.model_digest, 'Fusion version/integrity mismatch');
  const agent = data.agents.get(agentId);
  assert(agent && !artifact.validation_agents.some(a => a.agent_id === agentId || a.config_hash === agent.config_hash ||
    (agent.split_group && agent.split_group === a.split_group)), 'Validation agent reused for final evaluation');
  assert(artifact.weights[budget], 'No frozen fusion weights for this budget');
  const out = structuredClone(result);
  if (out.status !== 'COMPLETE') return out;
  for (const [lid, row] of Object.entries(out.labels)) {
    const lambda = artifact.weights[budget][lid];
    assert(finite(lambda) && lambda >= 0 && lambda <= 1 && finite(row.direct_estimate), 'Fusion requires audit/direct estimate');
    const auditCenter = row.estimate;
    const fused = lambda*row.direct_estimate+(1-lambda)*row.pirt_estimate;
    // Expand about the new center by its displacement; never reuse an unadjusted audit interval.
    const half = Math.max(Math.abs(auditCenter-row.lower), Math.abs(row.upper-auditCenter))+Math.abs(fused-auditCenter);
    row.audit_estimate = auditCenter; row.estimate = fused; row.display_estimate = Math.min(1, Math.max(0, fused));
    row.lambda = lambda; row.lower = Math.max(0, fused-half); row.upper = Math.min(1, fused+half);
    if (row.status !== 'CENSUS_COMPLETE') row.status = 'FUSION_UNCERTIFIED';
    if (finite(row.truth)) {row.absolute_error = Math.abs(fused-row.truth); row.covered = row.lower-1e-12 <= row.truth && row.truth <= row.upper+1e-12;}
  }
  out.estimator = 'validation-frozen-direct-pirt-fusion';
  out.calibration_digest = calibration_digest;
  out.interval_method += '-displacement-expanded-for-fusion';
  return out;
}
