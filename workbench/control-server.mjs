import {ModelSettings} from './lib/model-settings.mjs';
import {appSummary} from './lib/app-summary.mjs';
import {AgentDiscovery,graphTarget} from './lib/agent-discovery.mjs';
import {loadTargets} from '../adapters/shared/registry.mjs';
import {atomic as saveDiscoveryConfig} from '../adapters/shared/evaluation.mjs';
import {projectPaths} from './lib/paths.mjs';
import {spawn as spawnLiveObserver} from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stat,readFile} from 'node:fs/promises';
import {createReadStream,mkdirSync,openSync,closeSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {trimLogs} from './lib/background-io.mjs';
import {DshControl} from './lib/dsh-control.mjs';
import {WorkBuddyControl} from './lib/workbuddy-control.mjs';
import {initializeAgentControllers} from './lib/agent-control.mjs';
import {evaluationCatalog,validateEvaluationConfig} from './lib/evaluation-config.mjs';
import {confined,token} from './lib/files.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
export async function startControlServer({root=path.dirname(here),port=18767,controller,workbuddyController,agentControllers,discoveryService}={}){
  const control=controller??new DshControl(root);if(!controller)await control.init();
  const workbuddy=workbuddyController??new WorkBuddyControl({root});if(!workbuddyController)await workbuddy.init();
  const agents=agentControllers??await initializeAgentControllers(root);
  const others=()=>[workbuddy,...Object.values(agents)];
  const modelSettings=new ModelSettings({controllers:[control,...others()]});await modelSettings.init();
  const pendingMutations=new Set();
  const discovery=discoveryService??new AgentDiscovery();
  const csrf=randomBytes(32).toString('hex'),preview=path.join(root,'workbench/design-prototypes');
  const server=http.createServer(async(req,res)=>{
    try{
      const addr=server.address(),hosts=['127.0.0.1:'+addr.port,'localhost:'+addr.port];
      if(!hosts.includes(req.headers.host)||req.headers.origin&&!hosts.map(h=>'http://'+h).includes(req.headers.origin)||req.headers['sec-fetch-site']==='cross-site'){json(res,403,{error:'请求来源不允许'});return;}
      const u=new URL(req.url,'http://'+req.headers.host);
      if(u.pathname.startsWith('/api/control/')){
        if(req.method==='GET'&&u.pathname==='/api/control/discovery'){json(res,200,await discovery.scan());return;}
        if(req.method==='GET'&&u.pathname==='/api/control/app'){json(res,200,{...await appSummary({control,workbuddy,agents}),csrf});return;}
        if(req.method==='GET'&&u.pathname==='/api/control/model-settings'){json(res,200,{settings:await modelSettings.get(),csrf});return;}
        if(req.method==='GET'&&u.pathname==='/api/control/evaluation-catalog'){json(res,200,await evaluationCatalog(root));return;}
        const agentRoute=u.pathname.match(/^\/api\/control\/(pi|langgraph|qwenwork|doubaowork|hermes|openclaw)\/status$/);
        if(req.method==='GET'&&agentRoute){json(res,200,await agents[agentRoute[1]].status());return;}
        if(req.method==='GET'&&u.pathname==='/api/control/workbuddy/status'){
          json(res,200,await workbuddy.status());return;
        }
        if(req.method==='GET'&&u.pathname.startsWith('/api/control/trace/')){
          const parts=u.pathname.slice('/api/control/trace/'.length).split('/');
          if(parts.length!==3){json(res,400,{error:'无效 Trace 路径'});return;}
          parts.forEach(token);json(res,200,await control.results.trace(...parts));return;
        }
        if(req.method==='GET'&&u.pathname==='/api/control/activity'){
          const a=await control.activity();
          const external=others().flatMap(c=>[...(c.jobs?.jobs?.values()??[])].map(j=>[j.id,j.state,j.sequence,j.endedAt]));
          json(res,200,{...a,active:a.active||others().some(c=>c.active),revision:external.length?createHash('sha256').update(JSON.stringify([a.revision,external])).digest('hex'):a.revision});return;
        }
        if(req.method==='GET'&&u.pathname==='/api/control/status'){
          const value={...await control.status()};
          for(const c of others())if(c.records){const extra=await c.records(),ids=new Set(extra.jobs.map(j=>j.runId));value.jobs=[...extra.jobs,...(value.jobs??[]).filter(j=>!ids.has(j.runId))];value.runs=[...extra.runs,...(value.runs??[]).filter(r=>!ids.has(r.run.id))];}
          value.csrf=csrf;value.observationCheckedAt=control.observationCheckedAt??null;
          const payload=JSON.stringify(value),etag='"'+createHash('sha256').update(payload).digest('hex')+'"';
          if(req.headers['if-none-match']===etag){res.writeHead(304,{'etag':etag,'cache-control':'no-cache'});res.end();return;}
          res.setHeader('etag',etag);json(res,200,value);return;
        }
        if(req.method==='POST'){
          if(req.headers['x-workbench-token']!==csrf){json(res,403,{error:'请刷新页面后重试'});return;}
          if(!(req.headers['content-type']??'').startsWith('application/json')){json(res,415,{error:'需要 JSON 请求'});return;}
          let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536){json(res,413,{error:'请求过大'});return;}}
          let input;try{input=JSON.parse(raw);}catch{json(res,400,{error:'无效 JSON'});return;}
          if(!input||typeof input!=='object'||Array.isArray(input)){json(res,400,{error:'无效参数'});return;}
          const route=u.pathname.slice('/api/control/'.length);
          if(route==='discovery/scan'){
            if(Object.keys(input).length)throw Error('扫描不接受路径或命令参数');
            json(res,200,await discovery.scan(true));return;
          }
          if(route==='langgraph/connect'){
            if(pendingMutations.size||Object.values(agents).some(c=>c.active)||workbuddy.active)throw Error('请等待当前操作或评测完成后接入');
            pendingMutations.add('discovery');
            try{
              const target=await graphTarget(input),targets=await loadTargets(root);
              const existing=targets.find(t=>t.kind==='langgraph'&&t.python===target.python&&t.entrypoint===target.entrypoint);
              if(!existing)await saveDiscoveryConfig(path.join(root,'config/agents.json'),{schema:'evaldock.agent-targets/v1',targets:[...targets,target]});
              await agents.langgraph.refreshTargets();
              json(res,200,{ok:true,targetId:existing?.id??target.id,existing:!!existing});return;
            }finally{pendingMutations.delete('discovery');}
          }
          if(route==='discovery/connect'){
            if(Object.keys(input).some(k=>k!=='id')||typeof input.id!=='string')throw Error('请选择一个扫描结果');
            if(pendingMutations.size||Object.values(agents).some(c=>c.active))throw Error('请等待当前操作或评测完成后接入');
            pendingMutations.add('discovery');
            try{
              const match=(await discovery.scan(true)).agents.find(a=>a.id===input.id);
              if(!match?.target)throw Error('安装已变化或尚不能自动接入，请重新扫描');
              const targets=await loadTargets(root),target={...match.target,id:match.target.id+'-'+match.id};
              const existing=targets.find(t=>t.id===target.id||t.kind===target.kind&&(target.executable?t.executable===target.executable:!t.executable));
              if(!existing)await saveDiscoveryConfig(path.join(root,'config/agents.json'),{schema:'evaldock.agent-targets/v1',targets:[...targets,target]});
              await agents[target.kind].refreshTargets();
              json(res,200,{ok:true,targetId:existing?.id??target.id});return;
            }finally{pendingMutations.delete('discovery');}
          }
          if(route==='model-settings'){try{json(res,200,{ok:true,settings:await modelSettings.save(input)});}catch(e){json(res,e.statusCode??500,{error:e.statusCode?e.message:'保存配置失败，请检查服务端文件权限或磁盘空间'});}return;}
          const runtimeMatch=route.match(/^(pi|langgraph|qwenwork|doubaowork|hermes|openclaw)\/(run|validate|cancel|extensions|preflight|open)$/);
          const fields=runtimeMatch?({open:['targetId'],run:['targetId','evaluationConfig'],validate:['targetId','datasetCount','caseCount','datasetIds'],cancel:['id'],extensions:['targetId','extensions'],preflight:['targetId','extensions']}[runtimeMatch[2]]):{preflight:['revision','plugins'],service:['action'],plugins:['plugins','revision'],run:['datasetCount','caseCount','revision','allDatasets','casesPerDataset','evaluationConfig'],cancel:['id'],'session-cancel':['sessionId'],'workbuddy/validate':['datasetCount','caseCount','datasetIds'],'workbuddy/run':['evaluationConfig'],'workbuddy/cancel':['id'],'workbuddy/open':[],'workbuddy/recover':[]}[route];
          if(!fields){json(res,404,{error:'接口不存在'});return;}
          if(Object.keys(input).some(k=>!fields.includes(k))){json(res,400,{error:'未知参数'});return;}
          if(input.evaluationConfig!==undefined)input.evaluationConfig=await validateEvaluationConfig(root,input.evaluationConfig);
          // Each controller owns one active run. Serialize its mutations without blocking independent Agents.
          const owner=runtimeMatch?runtimeMatch[1]:route.startsWith('workbuddy/')?'workbuddy':'dsh';
          if(pendingMutations.has('discovery')){json(res,409,{error:'正在接入 Agent，请稍后重试'});return;}
          if(pendingMutations.has(owner)){json(res,409,{error:'该 Agent 有操作正在处理，请稍后重试'});return;}
          pendingMutations.add(owner);
          try{
          let result;
          if(runtimeMatch){
            const runtime=agents[runtimeMatch[1]],action=runtimeMatch[2];
            if(action==='run'||action==='validate')result=await runtime.run({...input,smoke:action==='validate'});
            if(action==='cancel')result=await runtime.jobs.cancel(input.id);
            if(action==='extensions')result=await runtime.extensions(input);
            if(action==='preflight')result=await runtime.preflight(input);
            if(action==='open')result=await runtime.open(input);
          }
          if(route==='workbuddy/run')result=await workbuddy.run(input);
          if(route==='workbuddy/validate')result=await workbuddy.run({smoke:true,...input});
          if(route==='workbuddy/cancel')result=await workbuddy.jobs.cancel(input.id);
          if(route==='workbuddy/open')result=await workbuddy.open();
          if(route==='workbuddy/recover')result=await workbuddy.recover();
          if(route==='preflight')result=await control.preflight(input);
          if(route==='service')result=await control.action(input.action);
          if(route==='plugins')result=await control.apply(input);
          if(route==='run')result=await control.run(input);
          if(route==='cancel')result=await control.jobs.cancel(input.id);
          if(route==='session-cancel')result=await control.cancelSession(input.sessionId);
          control.cacheUntil=0;json(res,200,{ok:true,result});return;
          }finally{pendingMutations.delete(owner);}
        }
        json(res,404,{error:'接口不存在'});return;
      }
      if(!['GET','HEAD'].includes(req.method)){json(res,405,{error:'只支持读取'});return;}
      const relative=decodeURIComponent(u.pathname.slice(1))||'index.html';let file;
      if(relative.startsWith('reports/')){
        const parts=relative.split('/');token(parts[1]);token(parts[2]);
        try{file=await confined(projectPaths(root).results,'agents/'+parts[1]+'/runs/'+parts[2]+'/'+parts.slice(3).join('/'));}
        catch(e){if(e.code!=='ENOENT')throw e;file=await confined(preview,relative);}
      }else if(relative==='live-observation.json'||relative.startsWith('runtime-details/')){
        try{file=await confined(path.join(projectPaths(root).workbench,'cache'),relative);}
        catch(e){if(e.code!=='ENOENT')throw e;file=await confined(preview,relative);}
      }else file=await confined(preview,relative);
      const info=await stat(file);if(!info.isFile())throw Object.assign(new Error('文件不存在'),{code:'ENOENT'});
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}[path.extname(file)]??'application/octet-stream';
      res.writeHead(200,{'content-type':mime,'content-length':info.size,'cache-control':'no-cache','x-content-type-options':'nosniff'});
      if(req.method==='HEAD'){res.end();return;}const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch(e){if(!res.headersSent)json(res,e.code==='ENOENT'?404:409,{error:e.code==='ENOENT'?'文件尚未生成':e.message||'操作未完成',...(e.preflight?{preflight:e.preflight}:{})});else res.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,control,workbuddy,agents};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const {server,control,workbuddy,agents}=await startControlServer({port:Number(process.env.WORKBENCH_PORT??18767)});
  console.log('EvalDock control ready on 127.0.0.1:'+server.address().port);
  const logs=path.join(projectPaths(path.dirname(here)).logs,'workbench');mkdirSync(logs,{recursive:true,mode:0o700});
  const output=openSync(path.join(logs,'collector.log'),'a',0o600),errors=openSync(path.join(logs,'collector.error.log'),'a',0o600);
  const observer=spawnLiveObserver(process.execPath,[fileURLToPath(new URL('./live-observation.mjs',import.meta.url))],{
    stdio:['ignore',output,errors,'ipc'],env:{...process.env,WORKBENCH_PORT:String(server.address().port)}});
  closeSync(output);closeSync(errors);
  observer.on('message',message=>{if(message?.type==='observation-heartbeat')control.observationCheckedAt=message.at;});
  let maintaining=false;
  const maintenance=setInterval(async()=>{
    if(maintaining)return;maintaining=true;
    try{await trimLogs(['server.log','server.error.log','collector.log','collector.error.log'].map(n=>path.join(logs,n)));}
    catch(e){console.error('Log maintenance failed:',e.code??e.message);}
    finally{maintaining=false;}
  },30000);maintenance.unref();
  observer.on('error',()=>console.error('Live observation could not start'));
  let closing=false;
  const stop=async()=>{if(closing)return;closing=true;clearInterval(maintenance);observer.kill('SIGTERM');await Promise.all([control.jobs.shutdown(),workbuddy.jobs.shutdown(),...Object.values(agents).map(c=>c.jobs.shutdown())]);server.close();};
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
}
