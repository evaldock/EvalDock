/** Shared capture policy. References point to earlier retained events in this Session. */
import { eventFingerprint, objectRecord, type SessionRecord } from "./session-events.js";

export function createSessionEvidenceCompactor() {
  const values = new Map<string, {seq:number; path:string}>();
  const stats = {noiseRecords:0, reusedBodies:0};
  const pointer=(base:string,key:string)=>base+"/"+key.replaceAll("~","~0").replaceAll("/","~1");
  function encode(value:unknown, seq:number, path:string, key:string):unknown {
    // Only content, never IDs/correlation fields. Repeated real actions keep their own events.
    const reusable=(typeof value==="string" && (Buffer.byteLength(value)>=256 || key==="arguments")) ||
      (["tools","plugins","config","sections"].includes(key) && value!==null && typeof value==="object" && Buffer.byteLength(JSON.stringify(value))>=128);
    if(reusable) {
      const hash=eventFingerprint({value});
      const prior=values.get(hash);
      if(prior) { stats.reusedBodies++; return {evidenceRef:{seq:prior.seq,path:prior.path}}; }
      values.set(hash,{seq,path});
    }
    if(Array.isArray(value)) return value.map((v,i)=>encode(v,seq,pointer(path,String(i)),String(i)));
    const object=objectRecord(value);
    if(object) return Object.fromEntries(Object.entries(object).map(([k,v])=>[k,encode(v,seq,pointer(path,k),k)]));
    return value;
  }
  return {
    stats,
    accept(record:SessionRecord):SessionRecord | undefined {
      const data=objectRecord(record.data);
      if(["heartbeat","session/heartbeat","session/flush","runtime/heartbeat"].includes(String(record.type)) &&
          (!data || !Object.keys(data).length)) { stats.noiseRecords++; return undefined; }
      if(record.type==="assistant/message") {
        const blocks=objectRecord(data?.message)?.content;
        if(Array.isArray(blocks) && blocks.length===0 && !data?.usage &&
           Object.keys(data??{}).every(k=>["turn","step","message"].includes(k)) &&
           Object.keys(objectRecord(data?.message)??{}).every(k=>["role","content","id"].includes(k))) {
          stats.noiseRecords++; return undefined;
        }
      }
      if(typeof record.seq!=="number") return record;
      // Do not alter original top-level sequence links or correlation data.
      return {...record,data:encode(record.data,record.seq,"/data","data")};
    },
  };
}

/** Match only the identical result of the same call; different outcomes and retries stay intact. */
export class ToolResultReferences {
  private results=new Map<string,{sessionId:string;seq:number;path:string;digest:string}>();
  observe(sessionId:string,event:SessionRecord):void {
    if(event.type!=="tool/result" || typeof event.seq!=="number")return;
    const data=objectRecord(event.data),message=objectRecord(data?.message);
    if(!Array.isArray(message?.content))return;
    message.content.forEach((value,index)=>{
      const block=objectRecord(value);
      if(block?.type!=="tool-result" || typeof block.toolCallId!=="string" || !Array.isArray(block.content))return;
      this.results.set(block.toolCallId,{sessionId,seq:event.seq as number,
        path:"/data/message/content/"+index+"/content",digest:eventFingerprint({content:block.content})});
    });
    if(this.results.size>10000)this.results.delete(this.results.keys().next().value!);
  }
  result(callId:unknown,value:unknown):unknown {
    const object=objectRecord(value),ref=typeof callId==="string"?this.results.get(callId):undefined;
    if(!object || !ref || !Array.isArray(object.content) || eventFingerprint({content:object.content})!==ref.digest)return value;
    return {...object,content:{sessionEvidenceRef:{sessionId:ref.sessionId,seq:ref.seq,path:ref.path}}};
  }
}
