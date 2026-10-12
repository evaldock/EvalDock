import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {temporary} from './support.mjs';
import {AgentModelSettings} from '../../workbench/lib/agent-model-settings.mjs';
import {loadAgentEnvironment} from '../../adapters/shared/registry.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';

test('fresh Agent credentials can be configured independently of evaluator credentials',async t=>{
 const root=await temporary(t),file=path.join(root,'agent-model.env'),legacyFile=path.join(root,'missing-dsh.env');
 const environment={PATH:process.env.PATH,EVALDOCK_PLANNER_API_KEY:'planner-fixture',EVALDOCK_JUDGE_API_KEY:'judge-fixture'};
 const controller={cacheUntil:123,preflights:new Map([['pi',{status:'FAILED'}]]),jobs:{secrets:[],environment:{...environment}}};
 const settings=new AgentModelSettings({file,legacyFile,environment,controllers:[controller]});
 assert.equal((await settings.get()).keyConfigured,false);
 await assert.rejects(settings.save({apiKey:''}),/请填写/);
 await assert.rejects(loadAgentEnvironment({file,legacyFile,environment}),/AGENT_MODEL_KEY_MISSING/);
 await settings.save({apiKey:'target-fixture'});
 assert.equal((await settings.get()).keyConfigured,true);
 const target=await loadAgentEnvironment({file,legacyFile,environment});
 assert.equal(target.DEEPSEEK_API_KEY,'target-fixture');
 assert.equal(target.EVALDOCK_PLANNER_API_KEY,undefined);assert.equal(target.EVALDOCK_JUDGE_API_KEY,undefined);
 assert.equal(controller.jobs.environment.DEEPSEEK_API_KEY,undefined);
 assert.ok(controller.jobs.secrets.includes('target-fixture'));assert.equal(controller.preflights.size,0);assert.equal(controller.cacheUntil,0);
 assert.equal((await stat(file)).mode&0o777,0o600);
 await settings.save({apiKey:''});assert.equal((await loadAgentEnvironment({file,legacyFile,environment})).DEEPSEEK_API_KEY,'target-fixture');
});

test('invalid or busy saves preserve Agent credentials and legacy credentials remain usable',async t=>{
 const root=await temporary(t),file=path.join(root,'agent-model.env'),legacyFile=path.join(root,'legacy.env');
 const {writeFile}=await import('node:fs/promises');
 await writeFile(legacyFile,'DEEPSEEK_API_KEY=legacy-fixture\nEVALDOCK_JUDGE_API_KEY=private-evaluator-fixture\n',{mode:0o600});
 const environment={DEEPSEEK_API_KEY:'environment-fixture'},controller={active:false};
 const settings=new AgentModelSettings({file,legacyFile,environment,controllers:[controller]});
 assert.equal((await loadAgentEnvironment({file,legacyFile,environment:{}})).DEEPSEEK_API_KEY,'legacy-fixture');
 await settings.save({apiKey:'saved-fixture'});const saved=await readFile(file,'utf8');
 assert.equal((await loadAgentEnvironment({file,legacyFile,environment})).DEEPSEEK_API_KEY,'saved-fixture');
 for(const input of [{apiKey:'bad\nvalue'},{apiKey:'bad value'},{apiKey:123},{apiKey:'valid',endpoint:'https://example.com'}])await assert.rejects(settings.save(input));
 controller.active=true;await assert.rejects(settings.save({apiKey:'replacement-fixture'}),/评测结束/);
 assert.equal(await readFile(file,'utf8'),saved);assert.match(await readFile(legacyFile,'utf8'),/legacy-fixture/);
});

test('Agent settings API protects secrets and allows a fresh user to configure the target key',async t=>{
 const root=await temporary(t),file=path.join(root,'agent-model.env'),legacyFile=path.join(root,'missing-legacy.env');
 const quiet={active:false,status:async()=>({targets:[]}),records:async()=>({jobs:[],runs:[]}),jobs:{secrets:[]},preflights:new Map()};
 const control={env:{},status:async()=>({jobs:[],runs:[]}),jobs:{jobs:new Map()}};
 const agentSettings=new AgentModelSettings({file,legacyFile,environment:{},controllers:[quiet]});
 const {server}=await startControlServer({root,port:0,controller:control,workbuddyController:quiet,agentControllers:{pi:quiet},modelSettingsFile:path.join(root,'models.env'),agentModelSettings:agentSettings});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port;
 const before=await fetch(origin+'/api/control/agent-model-settings').then(r=>r.json());
 assert.equal(before.settings.keyConfigured,false);
 const evaluator=await fetch(origin+'/api/control/model-settings').then(r=>r.json());
 assert.equal(evaluator.settings.planner.keyConfigured,false);assert.equal(evaluator.settings.judge.keyConfigured,false);
 const post=token=>fetch(origin+'/api/control/agent-model-settings',{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:JSON.stringify({apiKey:'api-target-fixture'})});
 assert.equal((await post('wrong-token')).status,403);
 const response=await post(before.csrf);assert.equal(response.status,200);
 const body=await response.text();assert.equal(JSON.parse(body).settings.keyConfigured,true);assert.ok(!body.includes('api-target-fixture'));
 const loaded=await loadAgentEnvironment({file,legacyFile,environment:{}});assert.equal(loaded.DEEPSEEK_API_KEY,'api-target-fixture');
 assert.equal((await fetch(origin+'/api/control/model-settings').then(r=>r.json())).settings.judge.keyConfigured,false);
});
