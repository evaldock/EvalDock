import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {temporary} from './support.mjs';
import {authenticateDshWeb,webFetch,webAuthHeaders} from '../../dist/src/runtime/web-auth.js';
import {consumeWebSocket} from '../../dist/src/runtime/auto-interaction.js';
test('DSH exchanges only a same-origin launch token and authenticates HTTP and WebSocket',async t=>{
 const root=await temporary(t),file=path.join(root,'service.log');let token='first',cookie='dsh-auth-test=first',exchanges=0,wsCookie;
 const server=createServer((req,res)=>{
  if(req.url==='/?token='+token){exchanges++;res.writeHead(303,{'set-cookie':cookie+'; HttpOnly; SameSite=Strict; Path=/','location':'/'});res.end();return;}
  if(req.headers.cookie!==cookie){res.writeHead(401);res.end();return;}
  if(req.url==='/redirect'){res.writeHead(302,{location:'http://localhost:1/'});res.end();return;}
  res.end('ok');
 });
 server.on('upgrade',(req,socket)=>{
  wsCookie=req.headers.cookie;
  if(wsCookie!==cookie){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const body=Buffer.from('{"type":"ready"}');socket.write(Buffer.concat([Buffer.from([0x81,body.length]),body]));
  socket.on('data',()=>socket.destroy());
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port;
 await writeFile(file,base+'/?token=first\nhttp://localhost:1/?token=foreign\n');
 await authenticateDshWeb(base,file);assert.equal((await webFetch(base,'/api/check')).status,200);assert.equal(exchanges,1);
 await authenticateDshWeb(base,file);assert.equal(exchanges,1);
 const controller=new AbortController();await consumeWebSocket(base.replace('http:','ws:')+'/api/events.mux',controller.signal,()=>{},async frame=>{assert.equal(frame.type,'ready');controller.abort();});assert.equal(wsCookie,cookie);
 assert.equal((await webFetch(base,'/redirect')).status,302);
 await assert.rejects(webFetch(base,'//localhost:1/'),/ROUTE_INVALID/);
 assert.throws(()=>webAuthHeaders('http://example.com'),/ORIGIN_INVALID/);
 token='second';cookie='dsh-auth-test=second';await writeFile(file,base+'/?token=second\n');await authenticateDshWeb(base,file);assert.equal(exchanges,2);
 token='third';cookie='dsh-auth-test=third';await writeFile(file,base+'/?token=stale-secret\n');await assert.rejects(authenticateDshWeb(base,file),e=>e.message==='DSH_WEB_AUTH_EXCHANGE_FAILED');assert.deepEqual(webAuthHeaders(base),{});
});

test('authenticated missing DSH RPC is an interface change, not a login failure',async t=>{
 const {rpc}=await import('../../dist/src/runtime/web-target.js');
 const {classify}=await import('../../adapters/compatibility/contracts.mjs');
 const server=createServer((req,res)=>{res.writeHead(404);res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 await assert.rejects(rpc('http://127.0.0.1:'+server.address().port,'host.describe',{}),e=>e.message==='DSH_WEB_INTERFACE_CHANGED'&&classify(e.message)==='INCOMPATIBLE');
});
