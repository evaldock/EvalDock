import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {temporary} from './support.mjs';
import {preflightPi} from '../../adapters/pi/preflight.mjs';
import {AgentControl} from '../../workbench/lib/agent-control.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';

async function fixture(t,source){
  const root=await temporary(t),executable=path.join(root,'pi.cjs');
  const extensions=['web-access','web-search'].map(name=>({name,version:'1',path:path.join(root,name),entries:['index.ts'],enabled:true}));
  await mkdir(path.join(root,'packages/coding-agent'),{recursive:true});
  await writeFile(path.join(root,'packages/coding-agent/package.json'),JSON.stringify({version:'1'}));
  for(const e of extensions){await mkdir(e.path);await writeFile(path.join(e.path,'package.json'),JSON.stringify({name:e.name,version:e.version,pi:{extensions:e.entries}}));}
  await writeFile(executable,source(extensions,root));
  const target={id:'pi',kind:'pi',name:'Pi',sourceRoot:root,executable,extensions:extensions.map(e=>e.name),extensionCatalog:extensions.map(e=>({name:e.name,path:e.path}))};
  return {root,target,inspection:{evaluationReady:true,version:'1',installRoot:root,extensions}};
}
const conflictSource=extensions=>`console.error(${JSON.stringify('Error: Failed to load extension "'+extensions[1].path+'/index.ts": Tool "web_search" conflicts with '+extensions[0].path+'/index.ts')});process.exit(1);`;

test('preflight surfaces both owners of a real child-process registration conflict',async t=>{
  const f=await fixture(t,conflictSource),r=await preflightPi(f.target,f.inspection);
  assert.equal(r.status,'FAILED');assert.equal(r.issues[0].code,'PI_EXTENSION_CONFLICT');
  assert.equal(r.issues[0].name,'web_search');assert.deepEqual(r.issues[0].extensions,['web-search','web-access']);
});
test('preflight only requests runtime state and accepts a clean startup',async t=>{
  const f=await fixture(t,()=>`const assert=require('node:assert/strict');assert.ok(process.argv.includes('rpc'));assert.ok(!process.argv.includes('--print'));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);assert.equal(r.type,'get_state');console.log(JSON.stringify({id:r.id,type:'response',command:'get_state',success:true,data:{model:{id:'test'}}}));});`);
  const r=await preflightPi(f.target,f.inspection);assert.equal(r.status,'PASSED');assert.deepEqual(r.issues,[]);
});
test('preflight times out and kills a stuck process',async t=>{
  const f=await fixture(t,(_e,root)=>`require('node:fs').writeFileSync(${JSON.stringify(path.join(root,'pid'))},String(process.pid));setInterval(()=>{},1000);`);
  const r=await preflightPi(f.target,f.inspection,{timeoutMs:500});assert.equal(r.issues[0].code,'PI_PREFLIGHT_TIMEOUT');
  const pid=Number(await readFile(path.join(f.root,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});
test('controller rejects conflicting runs before job creation and rejects saving that selection',async t=>{
  const f=await fixture(t,conflictSource);await mkdir(path.join(f.root,'config'));
  const config=path.join(f.root,'config/agents.json');await writeFile(config,JSON.stringify({schema:'evaldock.agent-targets/v1',targets:[f.target]}));
  const before=await readFile(config,'utf8'),c=new AgentControl({root:f.root,kind:'pi'});
  c.targets=[f.target];c.jobs={children:new Map(),jobs:new Map(),start:()=>assert.fail('must not create a job')};
  const old=process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY='preflight-fixture-key';
  t.after(()=>{if(old===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=old;});
  await assert.rejects(c.run({targetId:'pi'}),e=>e.preflight?.issues[0].code==='PI_EXTENSION_CONFLICT');
  assert.equal(c.starting,false);
  await assert.rejects(c.extensions({targetId:'pi',extensions:f.target.extensions}),e=>e.preflight?.status==='FAILED');
  assert.equal(await readFile(config,'utf8'),before);
  const status=await c.status(true);assert.equal(status.targets[0].evaluationReady,false);assert.equal(status.targets[0].preflight.status,'FAILED');
});
test('preflight API carries structured failures and remains CSRF protected',async t=>{
  const root=await temporary(t),check={status:'FAILED',issues:[{code:'PI_EXTENSION_CONFLICT',name:'web_search',extensions:['a','b']}]};
  const control={jobs:{children:new Map()},status:async()=>({jobs:[],runs:[],runningSessions:0})};
  const quiet={active:false,records:async()=>({jobs:[],runs:[]})};
  const pi={...quiet,preflight:async()=>check,run:async()=>{throw Object.assign(new Error('conflict'),{preflight:check});}};
  const {server}=await startControlServer({root,port:0,controller:control,workbuddyController:quiet,agentControllers:{pi,langgraph:quiet}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port,csrf=(await(await fetch(base+'/api/control/status')).json()).csrf;
  const post=(action,token=csrf)=>fetch(base+'/api/control/pi/'+action,{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:JSON.stringify({targetId:'pi'})});
  assert.equal((await post('preflight','wrong')).status,403);
  assert.deepEqual((await(await post('preflight')).json()).result,check);
  const denied=await post('run');assert.equal(denied.status,409);assert.deepEqual((await denied.json()).preflight,check);
});

test('full access policy follows both RPC preflight and JSON evaluation homes',async t=>{
  const {piLaunch}=await import('../../adapters/pi/launch.mjs');
  const {piConfigurationKey}=await import('../../adapters/pi/preflight.mjs');
  const f=await fixture(t,()=>''),target={...f.target,permissionPreset:'FULL_ACCESS'};
  for(const mode of ['rpc','json']){
    const home=path.join(f.root,mode),launch=await piLaunch(target,f.inspection,home,{mode});
    const policy=JSON.parse(await readFile(path.join(launch.env.PI_CODING_AGENT_DIR,'extensions/pi-permission-system/config.json'),'utf8'));
    assert.deepEqual(policy.permission,{'*':'allow'});assert.equal(policy.yoloMode,true);assert.equal(policy.permissionReviewLog,true);
  }
  assert.notEqual(piConfigurationKey(f.inspection),piConfigurationKey({...f.inspection,permissionPreset:'FULL_ACCESS'}));
});
