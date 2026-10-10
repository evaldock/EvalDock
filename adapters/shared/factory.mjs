import {createHermesAdapter} from '../hermes/adapter.mjs';
import {createOpenClawAdapter} from '../openclaw/adapter.mjs';
import {resolveTarget} from './registry.mjs';
import {createQwenWorkAdapter} from '../qwenwork/adapter.mjs';
import {createDoubaoWorkAdapter} from '../doubaowork/adapter.mjs';
import {createPiAdapter} from '../pi/adapter.mjs';
import {createLangGraphAdapter} from '../langgraph/adapter.mjs';

export async function createAdapter(root,targetId){
  const target=await resolveTarget(root,targetId);
  const factories={hermes:createHermesAdapter,openclaw:createOpenClawAdapter,pi:createPiAdapter,langgraph:createLangGraphAdapter,qwenwork:createQwenWorkAdapter,doubaowork:createDoubaoWorkAdapter};
  const factory=factories[target.kind];if(!factory)throw Error('AGENT_KIND_UNSUPPORTED');return factory(target);
}
