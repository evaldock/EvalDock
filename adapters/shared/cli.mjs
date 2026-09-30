import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {realpath} from 'node:fs/promises';
import {parseEvaluationConfig} from '../../dist/src/app/evaluation-config.js';

export async function main(run, moduleUrl) {
  const args=process.argv.slice(2), value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
  const root=await realpath(path.resolve(path.dirname(fileURLToPath(moduleUrl)),'../..'));
  const abort=new AbortController();
  process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
  const owner=Number(process.env.EVALDOCK_AGENT_OWNER_PID??process.env.EVALDOCK_WORKBUDDY_OWNER_PID);
  // Parent lifecycle guard only. Evidence is delivered by events, never polled.
  const watchdog=owner?setInterval(()=>{if(process.ppid!==owner)abort.abort();},1000):null;
  watchdog?.unref();
  try {
    const validation=value('--validation-config')?JSON.parse(value('--validation-config')):{};
    const evaluation=value('--evaluation-config')?{evaluationConfig:parseEvaluationConfig(JSON.parse(value('--evaluation-config')))}:{};
    const result=await run({root,runId:value('--run-id'),targetId:value('--target-id'),signal:abort.signal,...validation,...evaluation});
    console.log(JSON.stringify(result));
    process.exitCode=result.status==='COMPLETED'?0:result.status==='CANCELLED'?130:1;
  } finally {if(watchdog)clearInterval(watchdog);}
}
