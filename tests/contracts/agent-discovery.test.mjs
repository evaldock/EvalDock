import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,symlink,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {temporary,json} from './support.mjs';
import {scanLocalAgents,AgentDiscovery,graphTarget} from '../../workbench/lib/agent-discovery.mjs';
import {startControlServer} from '../../workbench/control-server.mjs';
async function fixture(t){
 const home=await temporary(t),bin=path.join(home,'bin');await mkdir(bin);
 return {home,bin,options:{home,pathValue:bin,appRoots:[path.join(home,'Applications')],systemBins:[],readInfo:async file=>JSON.parse(await readFile(path.join(file,'Contents/Info.plist'),'utf8'))}};
}
test('scan reads desktop metadata and deduplicates CLI symlinks without executing commands',async t=>{
 const f=await fixture(t),pkg=path.join(f.home,'pkg'),app=path.join(f.home,'Applications/WorkBuddy.app');
 await json(path.join(pkg,'package.json'),{name:'@openai/codex',version:'1.2.3'});
 const executable=path.join(pkg,'codex.js'),sentinel=path.join(f.home,'executed');
 await writeFile(executable,`#!/bin/sh\ntouch '${sentinel}'\n`,{mode:0o755});
 await symlink(executable,path.join(f.bin,'codex'));await mkdir(path.join(f.home,'.local/bin'),{recursive:true});await symlink(executable,path.join(f.home,'.local/bin/codex'));
 await json(path.join(app,'Contents/Info.plist'),{CFBundleIdentifier:'test.workbuddy',CFBundleShortVersionString:'5.6.2'});
 const result=await scanLocalAgents(f.options);
 assert.equal(result.agents.filter(a=>a.kind==='codex').length,1);assert.equal(result.agents.find(a=>a.kind==='codex').version,'1.2.3');
 assert.equal(result.agents.find(a=>a.kind==='workbuddy').version,'5.6.2');assert.ok(result.agents.every(a=>a.evaluationReady===false));assert.equal(result.agents.find(a=>a.kind==='codex').supported,false);await assert.rejects(access(sentinel));
});
test('rescan removes vanished installs and tolerates broken links and malformed app metadata',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.bin,'hermes'),'#!/bin/sh\n',{mode:0o755});await symlink('/missing/path',path.join(f.bin,'pi'));
 const service=new AgentDiscovery(f.options);assert.equal((await service.scan()).agents.length,1);await rm(path.join(f.bin,'hermes'));
 assert.equal((await service.scan()).agents.length,1);assert.equal((await service.scan(true)).agents.length,0);
 await mkdir(path.join(f.home,'Applications/Claude.app'),{recursive:true});const result=await service.scan(true);assert.equal(result.agents.length,0);assert.equal(result.errors.length,1);
});
test('npm Pi installation proposes an explicit package root without assuming source checkout',async t=>{
 const f=await fixture(t),pkg=path.join(f.home,'pi-package');await json(path.join(pkg,'package.json'),{name:'@mariozechner/pi-coding-agent',version:'1.0.0'});await writeFile(path.join(pkg,'cli.js'),'#!/usr/bin/env node\n',{mode:0o755});await symlink(path.join(pkg,'cli.js'),path.join(f.bin,'pi'));
 const target=(await scanLocalAgents(f.options)).agents[0].target;assert.equal(target.packageRoot,pkg);assert.deepEqual(target.extensions,[]);
});
test('connect accepts only fresh discovered IDs, preserves configured targets and blocks active runs',async t=>{
 const root=await temporary(t),existing={id:'my-pi',kind:'pi',name:'Custom',sourceRoot:'/custom',extensions:['keep']};await json(path.join(root,'config/agents.json'),{schema:'evaldock.agent-targets/v1',targets:[existing]});
 const quiet={active:false,records:async()=>({jobs:[],runs:[]})},control={status:async()=>({jobs:[],runs:[]})};let refreshed=0,available=true;
 const service={scan:async()=>({agents:available?[{id:'detected',target:{id:'local-pi',kind:'pi',name:'Pi',executable:'/discovered/cli.js'}}]:[]})};
 const pi={...quiet,refreshTargets:async()=>{refreshed++;}};
 const {server}=await startControlServer({root,port:0,controller:control,workbuddyController:quiet,agentControllers:{pi},discoveryService:service});t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,csrf=(await(await fetch(base+'/api/control/status')).json()).csrf;
 const post=(body,token=csrf)=>fetch(base+'/api/control/discovery/connect',{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:JSON.stringify(body)});
 assert.equal((await post({id:'detected'},'bad')).status,403);assert.equal((await post({id:'detected',executable:'/injected'})).status,409);
 pi.active=true;assert.equal((await post({id:'detected'})).status,409);pi.active=false;
 assert.equal((await post({id:'detected'})).status,200);assert.equal(refreshed,1);
 assert.equal((await post({id:'detected'})).status,200);
 const targets=JSON.parse(await readFile(path.join(root,'config/agents.json'))).targets;assert.equal(targets.length,2);assert.deepEqual(targets[0],existing);
 available=false;assert.equal((await post({id:'detected'})).status,409);
});

test('project-local Pi and OpenClaw installs are connectable without PATH registration',async t=>{
 const f=await fixture(t),pi=path.join(f.home,'Agents/pi/packages/coding-agent'),claw=path.join(f.home,'Agents/openclaw');
 await json(path.join(pi,'package.json'),{name:'@earendil-works/pi-coding-agent',version:'1.0.0'});
 await mkdir(path.join(pi,'dist/bundle'),{recursive:true});await writeFile(path.join(pi,'dist/bundle/cli.js'),'// JS entrypoint\n');
 await json(path.join(claw,'node_modules/openclaw/package.json'),{name:'openclaw',version:'2026.9.6'});
 await writeFile(path.join(claw,'node_modules/openclaw/openclaw.mjs'),'// JS entrypoint\n');
 const node=path.join(claw,'runtime/node_modules/node/bin/node');await mkdir(path.dirname(node),{recursive:true});await writeFile(node,'#!/bin/sh\nexit 99\n',{mode:0o755});
 const result=await scanLocalAgents(f.options),piTarget=result.agents.find(a=>a.kind==='pi')?.target,clawTarget=result.agents.find(a=>a.kind==='openclaw')?.target;
 assert.ok(piTarget,'Pi source install must offer connect');assert.equal(piTarget.packageRoot,pi);assert.deepEqual(piTarget.extensions,[]);
 assert.ok(clawTarget,'OpenClaw local install must offer connect');assert.equal(clawTarget.node,node);assert.equal(clawTarget.executable,path.join(claw,'node_modules/openclaw/openclaw.mjs'));
 await rm(node);const missing=await scanLocalAgents(f.options);assert.equal(missing.agents.find(a=>a.kind==='openclaw').target,null);
});

test('explicit Graph setup validates local paths without importing code',async t=>{
 const f=await fixture(t),root=path.join(f.home,'Graph Project');await mkdir(root);
 await writeFile(path.join(root,'entry.py'),'raise RuntimeError("must not import during validation")');
 const python=path.join(root,'python');await writeFile(python,'#!/bin/sh\nexit 99\n',{mode:0o755});
 const input={name:'Graph',sourceRoot:'~/Graph Project',python,entrypoint:'~/Graph Project/entry.py:create_graph',model:'deepseek-v4-flash',tools:[],workspacePaths:'host'};
 const target=await graphTarget(input,{home:f.home});assert.equal(target.entrypoint,path.join(root,'entry.py')+':create_graph');assert.equal(target.kind,'langgraph');assert.deepEqual(target.tools,[]);
 await assert.rejects(graphTarget({...input,entrypoint:'~/Graph Project/missing.py:create_graph'},{home:f.home}),/是否存在/);
 await assert.rejects(graphTarget({...input,tools:['bad name']},{home:f.home}),/工具名称/);
 await assert.rejects(graphTarget({...input,apiKey:'not-accepted'},{home:f.home}),/未知/);
});
test('Graph UI connection preserves distinct entrypoints and does not overwrite existing configuration',async t=>{
 const root=await temporary(t),source=path.join(root,'Graph');await mkdir(source);
 for(const name of ['chat.py','files.py'])await writeFile(path.join(source,name),'# fixture');
 const python=path.join(source,'python');await writeFile(python,'#!/bin/sh\n',{mode:0o755});
 const quiet={active:false,records:async()=>({jobs:[],runs:[]})},control={status:async()=>({jobs:[],runs:[]})};let refreshed=0;
 const graph={...quiet,refreshTargets:async()=>{refreshed++;}};
 const {server}=await startControlServer({root,port:0,controller:control,workbuddyController:quiet,agentControllers:{langgraph:graph}});t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,csrf=(await(await fetch(base+'/api/control/status')).json()).csrf;
 const input={name:'Chat',sourceRoot:source,python,entrypoint:path.join(source,'chat.py')+':create_graph',model:'deepseek-v4-flash',tools:[],workspacePaths:'host'};
 const post=(body,token=csrf)=>fetch(base+'/api/control/langgraph/connect',{method:'POST',headers:{'content-type':'application/json','x-workbench-token':token},body:JSON.stringify(body)});
 assert.equal((await post(input,'bad')).status,403);graph.active=true;assert.equal((await post(input)).status,409);graph.active=false;
 assert.equal((await post(input)).status,200);assert.equal((await post({...input,name:'Do not overwrite'})).status,200);
 assert.equal((await post({...input,name:'Files',entrypoint:path.join(source,'files.py')+':create_graph',tools:['read_file','write_file']})).status,200);
 const targets=JSON.parse(await readFile(path.join(root,'config/agents.json'))).targets;assert.equal(targets.length,2);assert.equal(targets[0].name,'Chat');assert.notEqual(targets[0].id,targets[1].id);assert.equal(refreshed,3);
});
