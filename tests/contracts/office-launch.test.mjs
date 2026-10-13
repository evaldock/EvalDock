import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createOfficeAdapter} from '../../adapters/shared/office-adapter.mjs';

function fixture({running=true,connected=false,stuck=false,busy=false,interfaceError,connectAfterSpawn=true,multiple=false,orphan=false,forceOnRepeatedSignal=false,quitAccepted=true}={}){
 const app='/Applications/Test Office.app',executable=app+'/Contents/MacOS/Office';
 let rows=[...running?[{pid:701,ppid:1,comm:executable},{pid:702,ppid:701,comm:app+'/Contents/Helpers/Worker'}]:[],...multiple?[{pid:703,ppid:1,comm:executable}]:[],...orphan?[{pid:704,ppid:1,comm:executable}]:[],{pid:900,ppid:1,comm:'/Applications/Other.app/Contents/MacOS/Office'}];
 const signals=[],quits=[],spawns=[],leases=[];let time=0;
 const adapter=createOfficeAdapter({kind:'qwenwork',id:'office-launch'},{app,bundle:'test.office',port:18492,restartDisconnected:true,limitations:[],Desktop:{connect:async()=>{
  if(interfaceError)throw Error(interfaceError);
  if(!connected)throw Error('AGENT_NOT_CONNECTED');
  return {authenticated:async()=>false,close(){}};
 }}},{
  execCommand:async(command,args)=>{
   if(command==='/usr/bin/plutil')return {stdout:JSON.stringify({CFBundleIdentifier:'test.office',CFBundleExecutable:'Office',CFBundleShortVersionString:'1'})};
   if(command==='/usr/bin/osascript'){
    if(args.includes('--')){assert.deepEqual(args.slice(args.indexOf('--')+1),['701',app,executable]);quits.push(701);if(quitAccepted&&!stuck)rows=rows.filter(p=>p.pid!==701);return {stdout:JSON.stringify({accepted:quitAccepted})};}
    return {stdout:JSON.stringify(rows.filter(p=>[701,703].includes(p.pid)).map(p=>({pid:p.pid,app,executable:p.comm})))};
   }
   if(command==='/usr/bin/open')return {stdout:''};
   assert.equal(command,'/bin/ps');return {stdout:rows.map(p=>`${p.pid} ${p.ppid} ${p.comm}`).join('\n')};
  },
  resolvePath:async file=>file,
  signalProcess:(pid,signal)=>{signals.push({pid,signal});if(!stuck||(forceOnRepeatedSignal&&signals.filter(s=>s.pid===pid).length>1))rows=rows.filter(p=>p.pid!==pid);},
  spawnProcess:(file,args,options)=>{
   spawns.push({file,args,options});connected=connectAfterSpawn&&!rows.some(p=>p.pid===701);
   const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
  },
  acquireLease:async()=>{if(busy)throw Error('AGENT_COMPATIBILITY_BUSY_OR_INTERRUPTED');leases.push('acquired');return async()=>leases.push('released');},
  pause:async ms=>{time+=ms;},now:()=>time,launchTimeoutMs:1000,stopTimeoutMs:500,
 });
 return {adapter,signals,quits,spawns,leases,rows:()=>rows};
}

test('retrying after a cancelled native quit never sends a shutdown signal to Qwen',async()=>{
 const f=fixture({stuck:true,forceOnRepeatedSignal:true});
 await assert.rejects(f.adapter.launch(),{message:'AGENT_LAUNCH_STOP_TIMEOUT'});
 await assert.rejects(f.adapter.launch(),{message:'AGENT_LAUNCH_STOP_TIMEOUT'});
 assert.ok(f.rows().some(p=>p.pid===701));assert.deepEqual(f.quits,[701,701]);assert.deepEqual(f.signals,[]);assert.equal(f.spawns.length,0);
});

test('Qwen reconnects a normally opened singleton without changing its data directory',async()=>{
 const f=fixture(),status=await f.adapter.launch();
 assert.equal(status.status,'LOGIN_REQUIRED');assert.equal(status.probeReady,true);assert.equal(status.evaluationReady,false);
 assert.deepEqual(f.quits,[701]);assert.deepEqual(f.signals,[{pid:702,signal:'SIGTERM'}]);
 assert.deepEqual(f.rows().map(p=>p.pid),[900]);assert.deepEqual(f.leases,['acquired','released']);
 assert.equal(f.spawns[0].file,'/Applications/Test Office.app/Contents/MacOS/Office');
 assert.deepEqual(f.spawns[0].args,['--remote-debugging-address=127.0.0.1','--remote-debugging-port=18492']);
 assert.equal(f.spawns[0].options.env.ELECTRON_RUN_AS_NODE,undefined);
});

test('a connected but logged-out Qwen is returned without restarting it',async()=>{
 const f=fixture({connected:true}),status=await f.adapter.launch();
 assert.equal(status.status,'LOGIN_REQUIRED');assert.equal(f.signals.length,0);assert.equal(f.spawns.length,0);assert.equal(f.leases.length,0);
});

test('Qwen connection cannot restart an Agent with an active or interrupted evaluation lease',async()=>{
 const f=fixture({busy:true});await assert.rejects(f.adapter.launch(),{message:'AGENT_COMPATIBILITY_BUSY_OR_INTERRUPTED'});
 assert.equal(f.signals.length,0);assert.equal(f.spawns.length,0);
});

test('a Qwen process that does not exit prevents another launch and releases its lease',async()=>{
 const f=fixture({stuck:true});await assert.rejects(f.adapter.launch(),{message:'AGENT_LAUNCH_STOP_TIMEOUT'});
 assert.equal(f.spawns.length,0);assert.deepEqual(f.quits,[701]);assert.deepEqual(f.signals,[]);assert.deepEqual(f.leases,['acquired','released']);
});

test('a rejected native quit prevents relaunch and leaves the application running',async()=>{
 const f=fixture({quitAccepted:false});await assert.rejects(f.adapter.launch(),{message:'AGENT_LAUNCH_STOP_CANCELLED'});
 assert.deepEqual(f.quits,[701]);assert.deepEqual(f.signals,[]);assert.equal(f.spawns.length,0);assert.ok(f.rows().some(p=>p.pid===701));assert.deepEqual(f.leases,['acquired','released']);
});

test('an incompatible desktop interface cannot trigger a restart',async()=>{
 const f=fixture({interfaceError:'AGENT_INTERFACE_CHANGED'});await assert.rejects(f.adapter.launch(),{message:'AGENT_INTERFACE_CHANGED'});
 assert.equal(f.signals.length,0);assert.equal(f.spawns.length,0);
});

test('multiple application instances are rejected without stopping either one',async()=>{
 const f=fixture({multiple:true});await assert.rejects(f.adapter.launch(),{message:'AGENT_LAUNCH_INSTANCE_AMBIGUOUS'});
 assert.equal(f.signals.length,0);assert.equal(f.spawns.length,0);assert.deepEqual(f.leases,['acquired','released']);
});

test('an orphaned Qwen relay worker is not mistaken for another application instance',async()=>{
 const f=fixture({orphan:true}),status=await f.adapter.launch();
 assert.equal(status.probeReady,true);assert.equal(status.status,'LOGIN_REQUIRED');
 assert.deepEqual(f.quits,[701]);assert.deepEqual(f.signals,[{pid:702,signal:'SIGTERM'}]);
 assert.deepEqual(f.rows().map(p=>p.pid),[704,900]);
});

test('an accepted spawn without an actual connection returns a bounded error',async()=>{
 const f=fixture({running:false,connectAfterSpawn:false});await assert.rejects(f.adapter.launch(),{message:'AGENT_LAUNCH_CONNECTION_TIMEOUT'});
 assert.equal(f.spawns.length,1);assert.deepEqual(f.leases,['acquired','released']);
});
