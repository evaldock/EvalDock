import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,symlink,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {temporary,json} from './support.mjs';
import {scanLocalAgents,AgentDiscovery} from '../../workbench/lib/agent-discovery.mjs';
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
