import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {dshRpc,detectWebProtocol,setSessionPermission,consumeRemoteStream} from '../../dist/src/runtime/dsh-web-protocol.js';
import {DshControl} from '../../workbench/lib/dsh-control.mjs';
import {remoteAutomaticResponse,startAutoInteraction} from '../../dist/src/runtime/auto-interaction.js';
async function fixture(t,{legacy=false,foreign=false}={}){
 const calls=[],answers=[];const sockets=new Set();
 const server=createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  if(!body){res.writeHead(404);res.end();return;}
  const call=JSON.parse(body);calls.push(call);
  if(!legacy&&req.url==='/api/session.list'){res.writeHead(404);res.end();return;}
  const result=call.method==='commands/execute'?{result:{kind:'success'}}:call.method==='session.prompt'?{command:{kind:'success'}}:{items:[]};
  if(call.method==='$events/result')answers.push(call.payload.args);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{ok:true,value:result}}));
 });
 server.on('upgrade',(req,socket)=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const send=value=>{const bytes=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(bytes.length<126?2:4);head[0]=129;head[1]=bytes.length<126?bytes.length:126;if(bytes.length>=126)head.writeUInt16BE(bytes.length,2);socket.write(Buffer.concat([head,bytes]));};
  let pending=Buffer.alloc(0);
  socket.on('data',chunk=>{
   pending=Buffer.concat([pending,chunk]);
   while(pending.length>=2){
    const op=pending[0]&15,masked=!!(pending[1]&128);let length=pending[1]&127,offset=2;
    if(length===126){if(pending.length<4)return;length=pending.readUInt16BE(2);offset=4;}
    if(length===127){socket.destroy();return;}
    if(pending.length<offset+(masked?4:0)+length)return;
    const mask=masked?pending.subarray(offset,offset+4):null;offset+=masked?4:0;
    const value=Buffer.from(pending.subarray(offset,offset+length));pending=pending.subarray(offset+length);
    if(mask)for(let i=0;i<value.length;i++)value[i]^=mask[i%4];
    if(op===8){socket.destroy();return;}if(op!==1)continue;
    const open=JSON.parse(value.toString());
    assert.equal(open.type,'open');assert.deepEqual(Object.keys(open.payload),['args']);
    const emit=value=>send({type:'item',streamId:open.streamId,value});
    if(open.endpoint==='$events'){
     emit({type:'ready',clientId:'client',host:{home:'/synthetic'}});
     emit({type:'waterfall',event:'approval/request',eventId:'approval',agentId:'owned',request:{toolName:'write'}});
    }else emit({type:'snapshot',header:{id:foreign?'foreign':open.payload.args.request.address.sessionId},records:[{type:'event',event:{type:'turn/end',seq:5,data:{reason:{kind:'completed'}}}}],projections:{asOfSeq:5,values:{permissions:{currentValue:'danger-full-access'}}}});
   }
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{for(const s of sockets)s.destroy();server.closeAllConnections();server.close();});
 return {base:'http://127.0.0.1:'+server.address().port,calls,answers};
}
test('DSH Remote maps named arguments, session snapshots and permission commands',async t=>{
 const f=await fixture(t);assert.equal(await detectWebProtocol(f.base),'remote');
 assert.equal((await dshRpc(f.base,'host.describe')).home,'/synthetic');
 const history=await dshRpc(f.base,'session.history',{sessionId:'owned',maxMessages:20});assert.equal(history.events[0].event.seq,5);
 await dshRpc(f.base,'session.prompt',{sessionId:'owned',mode:'queue',content:[{type:'text',text:'task'}]});
 const prompt=f.calls.find(c=>c.method==='session/prompt');assert.equal(prompt.payload.args.request.sessionId,'owned');assert.ok(prompt.payload.args.request.requestId);
 await setSessionPermission(f.base,'owned');assert.deepEqual(f.calls.at(-1).payload.args,{agentId:'owned',line:'/permission danger-full-access',submittedAttachments:[]});
});
test('legacy DSH keeps its original command carrier',async t=>{
 const f=await fixture(t,{legacy:true});assert.equal(await detectWebProtocol(f.base),'legacy');await setSessionPermission(f.base,'owned');assert.equal(f.calls.at(-1).method,'session.prompt');assert.equal(f.calls.at(-1).payload.sessionId,'owned');
});
test('Remote snapshots from another session are rejected',async t=>{
 const f=await fixture(t,{foreign:true});await assert.rejects(dshRpc(f.base,'session.history',{sessionId:'owned'}),/SESSION_MISMATCH/);
});
test('Remote automatic answers echo stream correlation and cannot claim another session',()=>{
 const f={type:'waterfall',eventId:'e',agentId:'owned',event:'approval/request',request:{}};
 assert.deepEqual(remoteAutomaticResponse(f,'client','owned'),{clientId:'client',eventId:'e',outcome:{kind:'result',value:'allowed-once'}});
 assert.deepEqual(remoteAutomaticResponse(f,'client','other').outcome,{kind:'next'});
 const question={...f,event:'user-questions/request',request:{questions:[{id:'q',options:[{label:'yes (recommended)'},{label:'no'}]}]}};
 assert.equal(remoteAutomaticResponse(question,'client','owned').outcome.value.answers[0].selected[0],'yes (recommended)');
});
test('Remote event connection waits for ready and posts the scoped native answer',async t=>{
 const f=await fixture(t),auto=startAutoInteraction({base:f.base,sessionId:'owned',signal:AbortSignal.timeout(3000)});
 try{await auto.ready;for(let i=0;i<100&&!f.answers.length;i++)await new Promise(r=>setTimeout(r,10));assert.deepEqual(f.answers[0],{clientId:'client',eventId:'approval',outcome:{kind:'result',value:'allowed-once'}});}finally{await auto.stop();}
});

test('workbench control uses the same detected protocol for listing and cancellation',async t=>{
 const f=await fixture(t),control=new DshControl('/synthetic');
 control.descriptor={webEndpoint:f.base};
 await control.rpc('session.list');await control.rpc('session.cancel',{sessionId:'owned'});
 assert.deepEqual(f.calls.at(-1).payload,{args:{request:{sessionId:'owned'}}});
 assert.equal(f.calls.at(-1).method,'session/cancel');
});
test('Remote stream abort closes the owned connection and stops consuming events',async t=>{
 const f=await fixture(t),controller=new AbortController();let count=0;
 await consumeRemoteStream(f.base,'$events',{},controller.signal,async()=>{count++;controller.abort();});
 assert.equal(count,1);
});
