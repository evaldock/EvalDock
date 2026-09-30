/** Serializable renderer collector. No timer reads: adapters feed owned push events only. */
export function createRendererCapture(sessionId){
  const encoder=new TextEncoder(),tools=new Map(),events=new Map();let bytes=0,order=0,resolve;
  const c={sessionId,seen:0,noise:0,duplicates:0,mergedUpdates:0,omitted:0,clipped:0,final:'',finalTruncated:false,error:null,result:null,done:false};
  c.wait=new Promise(r=>{resolve=r;});
  const size=v=>encoder.encode(JSON.stringify(v)).length;
  const trim=(s,max)=>{if(encoder.encode(s).length<=max)return s;let lo=0,hi=Math.min(s.length,max);while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(encoder.encode(s.slice(0,mid)).length<=max)lo=mid;else hi=mid-1;}if(lo&&/[\uD800-\uDBFF]/.test(s[lo-1]))lo--;return s.slice(0,lo);};
  const bound=(v,depth=0)=>{
    if(typeof v==='string'){const s=trim(v,16384);if(s!==v)c.clipped++;return s+(s!==v?' [TRUNCATED]':'');}
    if(v==null||typeof v==='number'||typeof v==='boolean')return v??null;
    if(depth>6){c.clipped++;return '[DEPTH_LIMIT]';}
    if(Array.isArray(v)){if(v.length>32)c.clipped++;return v.slice(0,32).map(x=>bound(x,depth+1));}
    const rows=Object.entries(v);if(rows.length>32)c.clipped++;
    return Object.fromEntries(rows.slice(0,32).map(([k,x])=>[k,/^(?:api.?key|authorization|access.?token|refresh.?token|token|password|secret)$/i.test(k)?'[REDACTED]':bound(x,depth+1)]));
  };
  c.text=(text,append=false)=>{if(typeof text!=='string')return;const s=append?c.final+text:text,clipped=trim(s,65536);c.finalTruncated=(append&&c.finalTruncated)||s!==clipped;c.final=clipped;};
  c.add=(type,data)=>{
    if(c.done)return;c.seen++;let safe=bound(data);if(size(safe)>32768){safe={callId:data.callId,name:data.name,contentOmitted:true};c.clipped++;}
    const item={at:new Date().toISOString(),event:{type,data:safe},order:++order};
    if(type==='tool/call'||type==='tool/result'){
      if(!data.callId){c.omitted++;return;}const id=String(data.callId),phase=type==='tool/call'?'call':'result',old=tools.get(id)??{};
      if(old[phase]){bytes-=size(old[phase]);c.mergedUpdates++;if(JSON.stringify(old[phase].event)===JSON.stringify(item.event)){bytes+=size(old[phase]);c.duplicates++;return;}}
      old[phase]=item;tools.set(id,old);bytes+=size(item);
    }else{const key=type+JSON.stringify(safe);if(events.has(key)){c.duplicates++;return;}events.set(key,item);bytes+=size(item);if(events.size>64){const key=events.keys().next().value;bytes-=size(events.get(key));events.delete(key);c.omitted++;}}
    while(bytes>192*1024||tools.size>128){if(tools.size){const key=tools.keys().next().value;for(const row of Object.values(tools.get(key))){bytes-=size(row);c.omitted++;}tools.delete(key);}else{const key=events.keys().next().value;if(key===undefined)break;bytes-=size(events.get(key));events.delete(key);c.omitted++;}}
  };
  c.finish=(error=null)=>{if(c.done)return;c.error=error;c.done=true;c.result=error?null:{stopReason:'end_turn'};resolve({error});};
  c.extract=()=>{const {wait,text,add,finish,extract,...plain}=c;return {...plain,queue:[...events.values(),...[...tools.values()].flatMap(x=>[x.call,x.result].filter(Boolean))].sort((a,b)=>a.order-b.order).map(({order,...r})=>r)};};return c;
}
