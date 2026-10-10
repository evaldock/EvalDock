import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {temporary} from './support.mjs';
import {preflightDsh} from '../../workbench/lib/dsh-preflight.mjs';
import {DshControl} from '../../workbench/lib/dsh-control.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';
async function fixture(t,source){
  const root=await temporary(t),sourceRoot=path.join(root,'install'),dshHome=path.join(root,'home');
  const folder=path.join(dshHome,'profiles/web'),names=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','broken-plugin'];
  for(const d of [path.join(sourceRoot,'lib'),path.join(sourceRoot,'node_modules/@deepseek-ai/dsh-app-boot'),...names.map(n=>path.join(folder,'node_modules',n))])await mkdir(d,{recursive:true});
  await writeFile(path.join(sourceRoot,'package.json'),JSON.stringify({type:'module'}));
  await writeFile(path.join(sourceRoot,'node_modules/@deepseek-ai/dsh-app-boot/package.json'),JSON.stringify({type:'module',main:'index.js'}));
  await writeFile(path.join(sourceRoot,'node_modules/@deepseek-ai/dsh-app-boot/index.js'),'export const loadLayeredEnv=()=>({});');
  await writeFile(path.join(sourceRoot,'lib/profile-boot-fixture.js'),source+'\nexport { runProfile };');
  const profile={dsh:{profile:{bundles:names}}};await writeFile(path.join(folder,'package.json'),JSON.stringify(profile));
  return {descriptor:{sourceRoot,dshHome,profile:'web'},profile,plugins:names.map(name=>({name,version:'1'})),revision:'revision'};
}
test('isolated DSH startup uses a temporary home and ephemeral listener without prompts',async t=>{
  const f=await fixture(t,`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';async function runProfile(options){assert.deepEqual(options.args,['--host','127.0.0.1','--port','0','--no-open']);assert.match(process.env.DSH_HOME,/evaldock-dsh-preflight/);assert.equal(JSON.parse(readFileSync('package.json')).dsh.profile.bundles.length,3);return {ctx:{fiber:{state:2},get:()=>({port:45678})},shutdown:{shutdown:async()=>{}}};}`);
  const before=await readFile(path.join(f.descriptor.dshHome,'profiles/web/package.json'),'utf8');
  assert.equal((await preflightDsh(f)).status,'PASSED');
  assert.equal(await readFile(path.join(f.descriptor.dshHome,'profiles/web/package.json'),'utf8'),before);
});
test('startup failure identifies plugin and redacts secrets',async t=>{
  const f=await fixture(t,`async function runProfile(){throw Error('broken-plugin duplicate tool sk-sensitivefixture');}`),r=await preflightDsh(f);
  assert.equal(r.status,'FAILED');assert.equal(r.issues[0].code,'DSH_PLUGIN_CONFLICT');assert.deepEqual(r.issues[0].plugins,['broken-plugin']);assert.ok(!JSON.stringify(r).includes('sk-sensitivefixture'));
});
test('timeout kills the DSH startup process',async t=>{
  const pidFile=path.join(await temporary(t),'pid');
  const f=await fixture(t,`import {writeFileSync} from 'node:fs';async function runProfile(){writeFileSync(${JSON.stringify(pidFile)},String(process.pid));await new Promise(()=>{setInterval(()=>{},1000)});}`);
  const result=await preflightDsh({...f,timeoutMs:500});assert.equal(result.issues[0].code,'DSH_PREFLIGHT_TIMEOUT');
  const pid=Number(await readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('failed startup prevents start, restart, configuration save, and evaluation creation',async()=>{
  const c=new DshControl('/unused'),s={revision:'r',status:'RUNNING',modelReady:true},names=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'];
  c.idle=async()=>s;c.plugins=async()=>({catalog:names.map(name=>({name,version:'1'}))});
  c.checkStartup=async()=>({status:'FAILED',issues:[{message:'conflict'}]});
  c.core={controlDsh:()=>assert.fail('must not start'),selectDshPlugins:()=>assert.fail('must not save'),dshConfiguration:()=>assert.fail('must not create job')};
  for(const call of [()=>c.action('start'),()=>c.action('restart'),()=>c.apply({revision:'r',plugins:names}),()=>c.run({revision:'r'})]){
    await assert.rejects(call(),e=>e.preflight?.status==='FAILED');assert.equal(c.busy,null);
  }
});
test('DSH preflight route is CSRF protected and returns structured issues',async t=>{
  const root=await temporary(t),check={status:'FAILED',issues:[{plugins:['broken-plugin'],message:'conflict'}]};
  const control={jobs:{children:new Map()},status:async()=>({jobs:[],runs:[],runningSessions:0}),preflight:async()=>check};
  const quiet={active:false,records:async()=>({jobs:[],runs:[]})};
  const {server}=await startControlServer({root,port:0,controller:control,workbuddyController:quiet,agentControllers:{pi:quiet,langgraph:quiet}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port,csrf=(await(await fetch(base+'/api/control/status')).json()).csrf;
  const post=token=>fetch(base+'/api/control/preflight',{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:JSON.stringify({revision:'r',plugins:[]})});
  assert.equal((await post('wrong')).status,403);assert.deepEqual((await(await post(csrf)).json()).result,check);
});

test('checking saved selection preserves its actual layer order, even when catalog order differs',async()=>{
 const c=new DshControl('/unused'),names=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','extra'];
 const saved=[names[0],names[2],names[1]],p={revision:'r',profile:{dsh:{profile:{bundles:saved}}},catalog:names.map(name=>({name,version:'1'}))};
 c.plugins=async()=>p;c.core={dshConfiguration:async()=>({agentId:'a'})};c.inspect=async()=>({});c.descriptor={};
 const result=await c.checkStartup({revision:'r:a',plugins:names},{revision:'r:a',status:'RUNNING',needsRestart:false});
 assert.equal(result.status,'PASSED');assert.deepEqual(result.plugins,saved);assert.equal(c.lastPreflight,result);
});
