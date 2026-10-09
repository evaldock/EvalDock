/** Loopback-only transport; each adapter supplies its own verified app identity and API. */
export class Desktop {
  constructor(ws){this.ws=ws;this.next=0;this.pending=new Map();
    ws.addEventListener('message',event=>{let m;try{m=JSON.parse(event.data);}catch{return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);p.dispose();m.error?p.reject(new Error('AGENT_TRANSPORT_ERROR')):p.resolve(m.result);});
    ws.addEventListener('close',()=>{for(const p of this.pending.values()){p.dispose();p.reject(new Error('AGENT_DISCONNECTED'));}this.pending.clear();});
  }
  static async connect({port,match}){
    const endpoint=`http://127.0.0.1:${port}`;
    let targets;try{const r=await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error();targets=await r.json();}catch{throw new Error('AGENT_NOT_CONNECTED');}
    const t=targets.find(x=>x.type==='page'&&match(x));
    if(!t)throw new Error('AGENT_WINDOW_NOT_READY');
    const url=new URL(t.webSocketDebuggerUrl);if(url.hostname!=='127.0.0.1'||url.port!==String(port))throw new Error('AGENT_INVALID_ENDPOINT');
    const ws=new WebSocket(url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new Error('AGENT_CONNECT_TIMEOUT'));},3000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('AGENT_CONNECT_FAILED'));},{once:true});});
    const client=new Desktop(ws);return client;
  }
  async evaluate(expression,timeout=10000,signal){
    if(signal?.aborted)throw new Error('AGENT_CANCELLED');
    const id=++this.next;
    const r=await new Promise((resolve,reject)=>{
      const dispose=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      const fail=code=>{this.pending.delete(id);dispose();reject(new Error(code));};
      const abort=()=>fail('AGENT_CANCELLED');
      const timer=setTimeout(()=>fail('AGENT_RPC_TIMEOUT'),timeout);
      this.pending.set(id,{resolve,reject,dispose});signal?.addEventListener('abort',abort,{once:true});
      try{this.ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));}
      catch{fail('AGENT_DISCONNECTED');}
    });
    if(r.exceptionDetails)throw new Error('AGENT_RPC_REJECTED');return r.result?.value;
  }
  close(){this.ws.close();}
}
