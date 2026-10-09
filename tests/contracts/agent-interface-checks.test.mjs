import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {inspectHermes} from '../../adapters/hermes/adapter.mjs';
import {inspectOpenClaw} from '../../adapters/openclaw/adapter.mjs';
import {inspectPi} from '../../adapters/pi/adapter.mjs';
import {inspectLangGraph} from '../../adapters/langgraph/adapter.mjs';
import {appSummary} from '../../workbench/lib/app-summary.mjs';
const cli=[
 [inspectHermes,['chat','--help'],'--query-file --oneshot --format stream-json --provider --model --toolsets --ignore-rules --max-turns --run-budget'],
 [inspectOpenClaw,['cli','agent','exec','--help'],'--config --state-dir --cwd --model --message-file --code-mode direct --json --timeout'],
];
for(const [inspect,expected,help] of cli)test(inspect.name+' checks execution flags, regardless of version metadata',async()=>{
 let output=help,failedVersion=false,failedHelp=false;const calls=[];
 const options={loadEnvironment:async()=>({}),execCommand:async(command,args)=>{calls.push(args);if(args.includes('--version')){if(failedVersion)throw Error('no version flag');return {stdout:'99.0.0'};}if(failedHelp)throw Error('timeout');return {stdout:output};}};
 const target={executable:'cli',node:process.execPath};
 assert.equal((await inspect(target,options)).evaluationReady,true);assert.deepEqual(calls[1],expected);
 failedVersion=true;assert.equal((await inspect(target,options)).evaluationReady,true);
 output=help.replace('--model','--model-other');const missing=await inspect(target,options);assert.equal(missing.reasonCode,'AGENT_CLI_INTERFACE_CHANGED');assert.equal(missing.evaluationReady,false);assert.equal(missing.probeReady,false);
 failedHelp=true;assert.equal((await inspect(target,options)).reasonCode,'AGENT_CLI_INTERFACE_UNAVAILABLE');
});
async function directory(t){const root=await mkdtemp(path.join(tmpdir(),'evaldock-interface-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('Pi requires a successful RPC preflight beyond package discovery',async t=>{
 const root=await directory(t);await writeFile(path.join(root,'package.json'),'{"version":"99"}');const executable=path.join(root,'pi.mjs');await writeFile(executable,'');
 let passed=false;const options={loadEnvironment:async()=>({}),preflight:async()=>({status:passed?'PASSED':'FAILED',issues:passed?[]:[{code:'PI_STARTUP_FAILED'}]})};
 const target={packageRoot:root,executable};assert.equal((await inspectPi(target,options)).reasonCode,'PI_STARTUP_FAILED');passed=true;assert.equal((await inspectPi(target,options)).evaluationReady,true);
});
test('Graph inspection loads the configured object, checks streaming and closes its context',async t=>{
 const root=await directory(t),file=path.join(root,'graph.py'),marker=path.join(root,'closed');
 const source=valid=>`from contextlib import contextmanager\nclass Graph:\n    def ${valid?'stream':'invoke'}(self, *args, **kwargs):\n        raise RuntimeError("must not execute a task")\n@contextmanager\ndef graph():\n    try:\n        yield Graph()\n    finally:\n        open(${JSON.stringify(marker)}, "w").write("closed")\n`;
 const target={python:'python3',sourceRoot:root,entrypoint:file+':graph'};
 await writeFile(file,source(true));assert.equal((await inspectLangGraph(target,{loadEnvironment:async()=>({PATH:process.env.PATH})})).evaluationReady,true);assert.equal(await readFile(marker,'utf8'),'closed');
 await rm(marker);await writeFile(file,source(false));const s=await inspectLangGraph(target,{loadEnvironment:async()=>({PATH:process.env.PATH})});assert.equal(s.evaluationReady,false);assert.equal(s.reasonCode,'LANGGRAPH_INTERFACE_UNAVAILABLE');assert.equal(await readFile(marker,'utf8'),'closed');
 await rm(marker);await writeFile(file,source(false).replace('def invoke(', 'def unsupported('));assert.equal((await inspectLangGraph(target,{loadEnvironment:async()=>({PATH:process.env.PATH})})).evaluationReady,false);assert.equal(await readFile(marker,'utf8'),'closed');
});
test('DSH summary does not admit a running service with missing models or stale configuration',async()=>{
 const other={status:async()=>({}),records:async()=>({jobs:[],runs:[]})};
 for(const state of [{modelReady:false},{modelReady:true,needsRestart:true},{modelReady:true,runningSessions:1},{modelReady:true}]){
  const control={...other,status:async()=>({status:'RUNNING',...state})};
  const result=await appSummary({control,workbuddy:other,agents:{}});
  assert.equal(result.agents[0].targets[0].evaluationReady,state.modelReady&&!state.needsRestart&&!state.runningSessions);
 }
});
