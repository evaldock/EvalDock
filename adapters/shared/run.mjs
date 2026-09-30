import {createHermesAdapter} from '../hermes/adapter.mjs';
import {createOpenClawAdapter} from '../openclaw/adapter.mjs';
import {fileURLToPath} from 'node:url';
import {resolveTarget} from './registry.mjs';
import {runEvaluation as evaluate} from './evaluation.mjs';
import {main} from './cli.mjs';
import {createQwenWorkAdapter} from '../qwenwork/adapter.mjs';
import {createDoubaoWorkAdapter} from '../doubaowork/adapter.mjs';
import {createPiAdapter} from '../pi/adapter.mjs';
import {createLangGraphAdapter} from '../langgraph/adapter.mjs';

export async function createAdapter(root,targetId){
  const target=await resolveTarget(root,targetId);
  const factories={hermes:createHermesAdapter,openclaw:createOpenClawAdapter,pi:createPiAdapter,langgraph:createLangGraphAdapter,qwenwork:createQwenWorkAdapter,doubaowork:createDoubaoWorkAdapter};
  const factory=factories[target.kind];if(!factory)throw Error('AGENT_KIND_UNSUPPORTED');return factory(target);
}
export async function runEvaluation(options){
  return evaluate({...options,adapter:await createAdapter(options.root,options.targetId)});
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main(runEvaluation,import.meta.url);
