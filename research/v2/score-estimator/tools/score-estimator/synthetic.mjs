/** Deliberately synthetic response table. Never benchmark data or measured agent accuracy. */
import {assert, digest} from './data.mjs';
import {random} from './policy.mjs';
import {sigmoid} from './model.mjs';

export function synthetic({agents = 5, cases = 1514, labels = 30, seed = 42} = {}) {
  assert([agents, cases, labels].every(Number.isSafeInteger) && agents >= 3 && labels >= 2 && cases >= labels, 'Invalid synthetic dimensions');
  const rnd = random('synthetic:'+seed);
  const normal = () => Math.sqrt(-2*Math.log(Math.max(1e-12, rnd())))*Math.cos(2*Math.PI*rnd());
  const protocol = {id: 'SYNTHETIC-ONLY-v1-'+seed, judge_version: 'synthetic-generator-v1',
    repeat_policy: 'single_attempt', synthetic: true, environment_version: 'no-runtime'};
  const ls = Array.from({length: labels}, (_, d) => ({label_id: 'label.synthetic-'+d+'/v1',
    min: 0, max: 100, rubric_version: 'synthetic-v1'}));
  const cs = Array.from({length: cases}, (_, i) => {
    const count = 2+Math.floor(rnd()*(Math.min(7, labels)-1));
    return {case_id: 'synthetic-case-'+i, case_version: 'synthetic-v1',
      task_family: 'synthetic-family-'+i%12, expected_cost: 1+4*rnd(),
      labels: Object.fromEntries(Array.from({length: count}, (_, j) => [ls[(i+j)%labels].label_id, 1]))};
  });
  const as = Array.from({length: agents}, (_, a) => ({agent_id: 'synthetic-agent-'+a,
    config_hash: digest({synthetic: true, seed, agent: a}), split_group: 'synthetic-family-'+a}));
  const abilities = as.map(() => ls.map(() => normal()*.8));
  const difficulty = cs.map(() => ls.map(() => normal()));
  const executions = [], scores = [];
  as.forEach((agent, a) => cs.forEach((c, i) => {
    const id = 'synthetic-execution-'+a+'-'+i;
    const time = 20+100*rnd(), sharedNoise = normal()*.1;
    executions.push({execution_id: id, agent_id: agent.agent_id, agent_config_hash: agent.config_hash,
      case_id: c.case_id, case_version: c.case_version, protocol_id: protocol.id, repeat_id: 1,
      status: 'COMPLETED', tokens: Math.round(time*20), elapsed_seconds: time, cost: time*.0001});
    for (const lid of Object.keys(c.labels)) {
      const d = ls.findIndex(l => l.label_id === lid);
      const value = Math.min(1, Math.max(0, sigmoid(abilities[a][d]-difficulty[i][d])+sharedNoise+normal()*.03));
      scores.push({execution_id: id, label_id: lid, raw_score: Math.round(value*10000)/100,
        status: 'SCORED', rubric_version: 'synthetic-v1', judge_version: protocol.judge_version,
        evidence_path: 'synthetic:no-real-agent-execution'});
    }
  }));
  return {schema: 'evaldock.estimator-data/v1', protocol, agents: as, labels: ls, cases: cs, executions, scores};
}
