/** Regularized 1PL mean-response baseline. Fractional log loss preserves continuous rubric scores.
 * Not the binary 2PL/MIRT implementation in tinyBenchmarks. Curvature is selection-only.
 */
import {assert, digest, finite} from './data.mjs';
export const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, x))));
const clip = x => Math.max(-1, Math.min(1, x));

export function fit(data, agentIds, {abilityRidge = 2, itemRidge = 5, maxIterations = 500} = {}) {
  assert(agentIds.length >= 2 && new Set(agentIds).size === agentIds.length, 'At least two distinct training agents required');
  assert(finite(abilityRidge) && abilityRidge > 0 && finite(itemRidge) && itemRidge > 0 &&
    Number.isSafeInteger(maxIterations) && maxIterations > 0, 'Invalid fit options');
  const all = data.matrix(agentIds), parameters = [];
  for (let d = 0; d < data.labels.length; d++) {
    const indices = data.weights.flatMap((w, i) => w[d] > 0 ? [i] : []);
    const y = agentIds.map((_, a) => indices.map(i => all[a][i][d]));
    let mean = y.flat().reduce((s, x) => s+x, 0)/(agentIds.length*indices.length);
    mean = Math.max(.01, Math.min(.99, mean));
    let mu = Math.log(mean/(1-mean)), previous = Infinity, converged = false, loss = Infinity, iterations = 0;
    const theta = agentIds.map(() => 0), beta = indices.map(() => 0);
    for (; iterations < maxIterations; iterations++) {
      for (let a = 0; a < theta.length; a++) {
        let g = abilityRidge*theta[a], h = abilityRidge;
        for (let j = 0; j < beta.length; j++) {const p = sigmoid(mu+theta[a]-beta[j]); g += p-y[a][j]; h += p*(1-p);}
        theta[a] -= clip(g/h);
      }
      for (let j = 0; j < beta.length; j++) {
        let g = itemRidge*beta[j], h = itemRidge;
        for (let a = 0; a < theta.length; a++) {const p = sigmoid(mu+theta[a]-beta[j]); g += y[a][j]-p; h += p*(1-p);}
        beta[j] -= clip(g/h);
      }
      let g = .01*mu, h = .01;
      for (let a = 0; a < theta.length; a++) for (let j = 0; j < beta.length; j++) {
        const p = sigmoid(mu+theta[a]-beta[j]); g += p-y[a][j]; h += p*(1-p);
      }
      mu -= clip(g/h);
      loss = .005*mu*mu + abilityRidge/2*theta.reduce((s, t) => s+t*t, 0) + itemRidge/2*beta.reduce((s, b) => s+b*b, 0);
      for (let a = 0; a < theta.length; a++) for (let j = 0; j < beta.length; j++) {
        const z = mu+theta[a]-beta[j]; loss += Math.max(0, z)+Math.log1p(Math.exp(-Math.abs(z)))-y[a][j]*z;
      }
      if (Math.abs(previous-loss) < 1e-8*(1+Math.abs(loss))) {converged = true; iterations++; break;}
      previous = loss;
    }
    parameters.push({label_id: data.labels[d].label_id, intercept: mu,
      difficulties: Object.fromEntries(indices.map((i, j) => [data.cases[i].case_id, beta[j]])),
      diagnostics: {iterations, converged, loss, training_abilities: theta}});
  }
  const model = {schema: 'evaldock.mean-irt/v1', kind: 'regularized-fractional-1pl',
    corpus_digest: data.corpusDigest, training_agents: agentIds.map(a => data.agents.get(a)),
    training_response_digest: digest({agentIds, responses: all}), ability_ridge: abilityRidge, item_ridge: itemRidge,
    parameters, synthetic: data.raw.protocol.synthetic === true,
    warnings: ['A small agent panel does not establish transfer accuracy.', 'Quasi-likelihood curvature is not a confidence interval.']};
  return {...model, model_digest: digest(model)};
}
export function checkModel(data, model) {
  assert(model.schema === 'evaldock.mean-irt/v1' && model.corpus_digest === data.corpusDigest, 'Model/corpus mismatch');
  const {model_digest, ...body} = model;
  assert(digest(body) === model_digest, 'Model integrity mismatch');
}
export function infer(data, model, observations) {
  checkModel(data, model);
  const predictions = data.cases.map(() => data.labels.map(() => null)), theta = [], curvature = [];
  for (let d = 0; d < data.labels.length; d++) {
    const item = model.parameters[d], lid = data.labels[d].label_id;
    const seen = observations.filter(o => Object.hasOwn(o.scores, lid));
    let t = 0, h = model.ability_ridge;
    for (let iteration = 0; iteration < 80; iteration++) {
      let g = model.ability_ridge*t; h = model.ability_ridge;
      for (const o of seen) {const p = sigmoid(item.intercept+t-item.difficulties[o.case_id]); g += p-o.scores[lid]; h += p*(1-p);}
      const step = clip(g/h); t -= step; if (Math.abs(step) < 1e-9) break;
    }
    h = model.ability_ridge;
    for (const o of seen) {const p = sigmoid(item.intercept+t-item.difficulties[o.case_id]); h += p*(1-p);}
    theta.push(t); curvature.push(h);
    data.cases.forEach((c, i) => {if (data.weights[i][d]) predictions[i][d] = sigmoid(item.intercept+t-item.difficulties[c.case_id]);});
  }
  return {predictions, theta, curvature};
}
