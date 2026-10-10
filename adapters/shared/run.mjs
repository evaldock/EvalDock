import {fileURLToPath} from 'node:url';
import {main} from './cli.mjs';
import {runEvaluation as evaluate} from './evaluation.mjs';
import {createAdapter} from './factory.mjs';
export {createAdapter} from './factory.mjs';
export async function runEvaluation(options){
  return evaluate({...options,adapter:await createAdapter(options.root,options.targetId)});
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main(runEvaluation,import.meta.url);
