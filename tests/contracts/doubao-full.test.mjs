import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {startDoubao} from '../../adapters/doubaowork/collector.mjs';
import {createRendererCapture} from '../../adapters/shared/renderer-capture.mjs';
import {prepareWorkspace} from '../../adapters/doubaowork/workspace.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function stream(){const values=[];let wake,closed=false;return{push(v){values.push(v);wake?.();},unsubscribe(){closed=true;wake?.();},async *[Symbol.asyncIterator](){while(!closed){if(!values.length)await new Promise(r=>wake=r);while(values.length)yield values.shift();}}};}
async function fixture(){
 const streams=new Map(),sent=[],loads=[],cancelled=[],released=[],watchers=new Set();let messageMap={},cancelPending=false;const infoReads=[];
 const store={getState:()=>({messageMap}),subscribe:f=>(watchers.add(f),()=>watchers.delete(f))};
 const native=id=>({subscribe:()=>streams.get(id)});
 const service={sendMessage:x=>{sent.push(x);streams.set(x.sessionId,stream());},lifecycleRegistry:{getSession:native},breakMessage:async()=>{}};
 const ts={loadThreadMessageList:async({threadId})=>{loads.push(threadId);},markCurrentSessionUserCancel(){}};
 const modules={35673:{getIsLoggedIn:()=>true},788925:{D:async()=>({getMessageService:async()=>service,getThreadMessageService:async()=>ts})},521109:{Wp:()=>({getState:()=>({modeSelectValue:'9',modeSelectConfigs:{}})})},63487:{MR:()=>true},201753:{zcD:{BLOCK_TEXT:10000,BLOCK_COMPLEX_TASK:10090,BLOCK_FILE_OPERATION:10019,BLOCK_SUPERTASK_TOOL:10016,BLOCK_GENERICTOOL:10024,BLOCK_GUI_TOOL:10068,BLOCK_PERMISSION_APPLY:10066,BLOCK_INTERACTION_ASK:10082}},734835:{I:store},656207:{IO:()=> 'bot'},71834:{NW:{getState:()=>({})}},957165:{createSendMessage:x=>x.message},446276:{mapTextToTextBlock:text=>({text})},609347:{iv:{AGWTaskTerminate:async({thread_id})=>(cancelled.push(thread_id),{code:0})}},639732:{V:async({thread_id})=>(infoReads.push(thread_id),{data:{thread_info:{ext:{thread_status:!cancelPending&&cancelled.includes(thread_id)?'completed':'running'}}}})},421540:{rS:async({request})=>(released.push(request.sandboxId),{success:true})},886735:{_:()=>({})}};
 const context=vm.createContext({window:{__evaldockDoubaoRequire:id=>modules[id]},TextEncoder,queueMicrotask,setTimeout,clearTimeout});
 const start=async id=>{await vm.runInContext(`(${startDoubao.toString()})({sessionId:${JSON.stringify(id)},prompt:'public task',cwd:'/case'},${createRendererCapture.toString()},async()=>({runtime_type:2,client_option:{sandbox_id:${JSON.stringify(id)}}}))`,context);return context.window.__evaldockDoubaoSessions[id];};
 return {start,sent,loads,cancelled,released,watchers,infoReads,setCancelPending:()=>{cancelPending=true;},emit:(id,message)=>streams.get(id).push({message}),update:(threadId,message)=>{messageMap={...messageMap,[threadId]:{[message.message_id]:message}};for(const f of watchers)f();}};
}
const text=t=>({block_type:10000,block_id:'text',content:{text_block:{text:t}},is_finish:true});
const card=id=>({block_type:10090,content:{complex_task_block:{thread_id:id,display_type:'organizer'}}});
const end=blocks=>({content_blocks_v2:blocks,final_status:{session:'Success'}});
const result=(id,answer)=>({message_id:id,stage:4,user_type:2,ext:{async_job:JSON.stringify({status:2}),is_finish:'1'},content_blocks_v2:[{block_type:10019,block_id:'tool-'+id,is_finish:true,content:{file_operation_block:{operation_type:1,path:'/case/input.txt',display_content:{result:'observed input'}}}},text(answer)]});
test('main chat success waits for background push; only owned threads are collected and updates merge',async()=>{
 const f=await fixture(),c=await f.start('owned');let done=false;c.wait.then(()=>done=true);
 f.emit('owned',end([card('own-thread'),text('delegated')]));await tick();await tick();assert.equal(done,false);assert.deepEqual(f.loads,['own-thread']);
 f.update('other-thread',result('other','private unrelated'));assert.equal(done,false);
 for(let i=0;i<50;i++)f.update('own-thread',{...result('m','interim'),stage:2,ext:{async_job:JSON.stringify({status:1})}});
 f.update('own-thread',result('m','actual final'));await c.wait;const out=await c.extract();assert.equal(out.error,null);assert.equal(out.final,'actual final');assert.equal(out.queue.filter(x=>x.event.type==='tool/call').length,1);assert.ok(out.duplicates>40);assert.ok(!JSON.stringify(out).includes('private unrelated'));assert.deepEqual(f.loads,['own-thread']);assert.equal(f.watchers.size,0);assert.deepEqual(f.released,['owned']);
 assert.equal(JSON.parse(f.sent[0].messages[0].ext.general_task_param).runtime_type,2);
});
test('concurrent office cases retain independent children, final answers and cleanup',async()=>{
 const f=await fixture(),a=await f.start('a'),b=await f.start('b');f.emit('a',end([card('thread-a')]));f.emit('b',end([card('thread-b')]));await tick();await tick();
 f.update('thread-b',result('b','answer b'));await b.wait;const bb=await b.extract();assert.equal(bb.final,'answer b');assert.equal(f.watchers.size,1);
 f.update('thread-a',result('a','answer a'));await a.wait;const aa=await a.extract();assert.equal(aa.final,'answer a');assert.ok(!JSON.stringify(aa).includes('answer b'));assert.equal(f.watchers.size,0);
});
test('cancel terminates only discovered owned threads and confirms server state before cleanup',async()=>{
 const f=await fixture(),c=await f.start('owned');f.emit('owned',end([card('child')]));await tick();await tick();assert.equal(await c.cancel(),true);await c.wait;const out=await c.extract();assert.equal(out.error,'AGENT_CANCELLED');assert.deepEqual(f.cancelled,['child']);assert.equal(f.watchers.size,0);assert.deepEqual(f.released,['owned']);
});
test('workspace bridge preserves application authorization and verifies per-case directory grant',async()=>{
 let request;const modules={209715:{sandboxEnvironmentController:{query:async()=>({isReady:true,environmentId:'env'})}},209874:{buildGeneralAgentCompletionTaskParam:async(id,cwd)=>({workspace:cwd,sandbox_id:'env',agent_workspace:{}})},40111:{wn:()=>({sandboxAuthType:2})},876207:{H:async x=>(request=x,{sandboxId:'own-sandbox',resolvedSharedFolders:[x.cwd]})}};
 const r=id=>modules[id];r.e=async()=>{};const ctx=vm.createContext({window:{__evaldockDoubaoRequire:r}});const result=await vm.runInContext(`(${prepareWorkspace.toString()})({sessionId:'owned',cwd:'/case'})`,ctx);
 assert.equal(result.runtime_type,2);assert.equal(result.client_option.workspace,'/case');assert.equal(request.sandboxAuthType,2);assert.deepEqual(result.client_option.shared_folder_path,['/case']);
 modules[209715].sandboxEnvironmentController.query=async()=>({isReady:false});await assert.rejects(vm.runInContext(`(${prepareWorkspace.toString()})({sessionId:'owned',cwd:'/case'})`,ctx),/AGENT_LOCAL_RUNTIME_UNAVAILABLE/);
});

test('delayed cancellation confirmation waits for a pushed terminal event without status polling',async()=>{
 const f=await fixture(),c=await f.start('owned');f.emit('owned',end([card('child')]));await tick();await tick();f.setCancelPending();const cancelling=c.cancel();await tick();
 f.update('child',{...result('m','cancelled'),ext:{async_job:JSON.stringify({status:4}),is_finish:'1'}});
 assert.equal(await cancelling,true);const out=await c.extract();assert.equal(out.error,'AGENT_CANCELLED');assert.equal(f.infoReads.length,2);assert.deepEqual(f.loads,['child']);
});
