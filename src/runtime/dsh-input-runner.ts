/** DSH headless input adapter. Uses native durable image attachments and user messages.
 * Copied into the run home; never patches the tested Agent's core or tools.
 */
import { readFile, writeFile, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
export const name="evaldock-input-runner";
export const inject=["agentDefaultModel","agents","sessions","headlessStartup","attachments"];
interface InputFile { destination:string; mediaType:string; sha256:string; }
interface Receipt { status:"SUBMITTED"|"FAILED"; attachments:{portablePath:string;attachmentId?:string}[];reason?:string; }
// Structural seam: DSH's packages live in the tested Target, not EvalDock's node_modules.
export async function submitInput(ctx:any, task:string, inputs:readonly InputFile[], cwd:string, api:any,
  record:(receipt:Receipt)=>Promise<void>) {
  let submitted=false;
  try {
    const images=[];
    for(const input of inputs) {
      if(!["image/png","image/jpeg","image/webp","image/gif"].includes(input.mediaType))
        throw new Error("DSH_ATTACHMENT_MEDIA_UNSUPPORTED: "+input.mediaType);
      const file=await realpath(path.resolve(cwd,input.destination));
      if(!file.startsWith(path.join(await realpath(cwd),"input")+path.sep)) throw new Error("INPUT_PATH_OUTSIDE_WORKSPACE");
      const data=await readFile(file);
      if(createHash("sha256").update(data).digest("hex")!==input.sha256) throw new Error("INPUT_BYTES_CHANGED");
      images.push({data,mediaType:input.mediaType,name:path.basename(input.destination)});
    }
    const refs=await ctx.get("attachments").saveImages(images);
    const selection=ctx.get("agentDefaultModel").currentSelection();
    const {agent}=await ctx.get("agents").create({
      sessionId:api.SessionId("session-"+randomUUID()),meta:{cwd},
      agentOptions:{provider:selection.provider,model:selection.model},
      setup:(agentCtx:any)=>api.installModelSelection(agentCtx,{current:selection,assembled:undefined}),
    });
    await agent.whenIdle();
    const firstSeq=agent.session.seq;
    agent.followup(api.createUserMessage({content:[{type:"text",text:task},...refs.map((attachment:any)=>({type:"image",attachment}))],source:{kind:"user"}}));
    submitted=true;
    await record({status:"SUBMITTED",attachments:inputs.map((input,i)=>({portablePath:input.destination,attachmentId:refs[i].attachmentId}))});
    await agent.whenIdle();
    await ctx.get("sessions").flush(agent.session);
    const events=agent.session.events.filter((event:any)=>event.seq>=firstSeq);
    const final=events.filter((event:any)=>event.type==="assistant/message").at(-1);
    const end=events.filter((event:any)=>event.type==="turn/end").at(-1);
    return {text:(final?.data.message.content??[]).filter((block:any)=>block.type==="text").map((block:any)=>block.text).join(""),
      exitCode:end?.data.reason?.kind==="completed"?0:1};
  } catch(error) {
    if(!submitted) await record({status:"FAILED",attachments:inputs.map(input=>({portablePath:input.destination})),
      reason:error instanceof Error && error.message.startsWith("DSH_ATTACHMENT_MEDIA_UNSUPPORTED") ? error.message : "INPUT_DELIVERY_FAILED"});
    throw error;
  }
}
export function apply(ctx:any) {
  const exit=ctx.get("appExit");
  void (async()=>{
    await ctx.get("loader")?.await();
    const require=createRequire(process.env.DSH_EVAL_TARGET_EXECUTABLE!);
    const load=(name:string)=>import(pathToFileURL(require.resolve(name)).href);
    const [agent,llm,session]=await Promise.all([load("@deepseek-ai/dsh-agent"),load("@deepseek-ai/dsh-llm"),load("@deepseek-ai/dsh-session")]);
    const inputs=JSON.parse(await readFile(process.env.DSH_EVAL_ATTACHMENT_MANIFEST!,"utf8"));
    const result=await submitInput(ctx,ctx.get("headlessStartup").task,inputs,process.cwd(),{...agent,...llm,...session},
      async receipt=>{await writeFile(process.env.DSH_EVAL_INPUT_RECEIPT!,JSON.stringify(receipt)+"\n",{mode:0o600});});
    process.stdout.write(result.text+"\n");exit(result.exitCode);
  })().catch(error=>{process.stderr.write("EvalDock input runner: "+(error instanceof Error?error.message:"failed")+"\n");exit(1);});
}
