import {fileURLToPath} from 'node:url';
import {runEvaluation as evaluate} from '../shared/evaluation.mjs';
import {main} from '../shared/cli.mjs';
import {createWorkBuddyAdapter} from './adapter.mjs';
export {atomic} from '../shared/evaluation.mjs';
export const runEvaluation=options=>evaluate({...options,adapter:createWorkBuddyAdapter(options)});
if(process.argv[1]===fileURLToPath(import.meta.url))await main(runEvaluation,import.meta.url);
