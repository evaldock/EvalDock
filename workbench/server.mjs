import {projectPaths} from './lib/paths.mjs';

import http from 'node:http';
import {loadEnvFile} from 'node:process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdir,access,readdir} from 'node:fs/promises';
import {homedir} from "node:os";
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Jobs} from './lib/jobs.mjs';
import {HttpError,dirs,jsonFile,readBounded,token} from './lib/files.mjs';
import {listRuns,runLocation,readRun} from './lib/history.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req){
  if(!(req.headers['content-type']??'').startsWith('application/json'))throw new HttpError(415,'JSON_REQUIRED');
  let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16384)throw new HttpError(413,'REQUEST_TOO_LARGE');}
  try{return JSON.parse(text);}catch{throw new HttpError(400,'INVALID_JSON');}
}
function uint(value,fallback,max=10000){
  if(value===null)return fallback;
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>max)throw new HttpError(400,'INVALID_QUERY');
  return Number(value);
}
async function credential(stateRoot,override){
  if(override)return override;
  const name=path.join(stateRoot,'api-token');
  try{return (await readFile(name,'utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;}
  const value=randomBytes(32).toString('hex');await writeFile(name,value+'\n',{mode:0o600,flag:'wx'});return value;
}
export async function startServer(options={}){
  const repoRoot=options.repoRoot??path.dirname(HERE),stateRoot=options.stateRoot??projectPaths(repoRoot).workbench;
  await mkdir(stateRoot,{recursive:true,mode:0o700});
  let local={};try{local=JSON.parse(await readFile(path.join(HERE,'config.local.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(options.environment===undefined){
    try{loadEnvFile(path.join(process.env.DSH_HOME??path.join(homedir(),'.dsh'),'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const {loadModelEnvironment}=await import(pathToFileURL(path.join(repoRoot,'dist/src/platform/model-environment.js')));
    await loadModelEnvironment();
  }
  const auth=await credential(stateRoot,options.token??process.env.EVALDOCK_WORKBENCH_TOKEN);
  if(auth.length<24)throw new Error('API token must contain at least 24 characters');
  const port=options.port??Number(process.env.PORT??local.port??18768);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
  const origins=options.origins??local.origins??['http://127.0.0.1:5173','http://localhost:5173'];
  for(const origin of origins){const u=new URL(origin);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!['http:','https:'].includes(u.protocol)||u.origin!==origin)throw new Error('Frontend origins must be exact loopback origins');}
  // Only new workbench files are written; the existing CLI still controls its own runtime paths.
  const runtimeConfig=path.join(stateRoot,'runtime-config.json');
  const base=JSON.parse(await readFile(path.join(repoRoot,'config/macos-vm.json'),'utf8'));
  for(const [key,dir] of Object.entries({runRoot:'records',artifactRoot:'artifacts',reportRoot:'reports',resultRoot:'evaluation-results',workspaceRoot:'workspaces',runtimeDshHomeRoot:'runtime-homes'}))base[key]=path.join(stateRoot,dir);
  await writeFile(runtimeConfig,JSON.stringify(base,null,2)+'\n',{mode:0o600});
  const defaults=[
    {id:'real-dsh',name:'本机 当前实际 DSH Web',descriptor:path.join(repoRoot,'config/targets/real-dsh.json'),config:runtimeConfig,fixture:false,warnings:[]}
  ];
  const targets=options.targets??local.targets??defaults;
  for(const t of targets){token(t.id);if(!path.isAbsolute(t.descriptor)||!path.isAbsolute(t.config))throw new Error('Target registry requires absolute descriptor and config paths');}
  const roots=options.resultRoots??{project:projectPaths(repoRoot).results,legacyWorkbench:path.join(HERE,'var/evaluation-results')};
  const cliPath=options.cliPath??path.join(repoRoot,'dist/src/app/cli.js');
  const jobs=new Jobs({repoRoot,stateRoot:path.join(stateRoot,'jobs'),targets,maxConcurrentJobs:options.maxConcurrentJobs??1,
    cliPath,cliPrefix:options.cliPrefix??[cliPath],nodePath:process.execPath,
    environment:options.environment,secrets:Object.entries(options.environment??process.env).filter(([k])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)).map(([,v])=>v??'').concat(auth)});
  jobs.legacyRoots=[path.join(HERE,'var/jobs')];await jobs.init();
  const actualTarget=targets.find(t=>!t.fixture);
  const dshModule=()=>import(pathToFileURL(path.join(repoRoot,'dist/src/runtime/dsh-control.js')).href);
  const actualDescriptor=async()=>{
    if(!actualTarget)throw new HttpError(409,'REAL_DSH_NOT_CONFIGURED');
    const {loadTargetDescriptor}=await import(pathToFileURL(path.join(repoRoot,'dist/src/app/bootstrap.js')).href);
    return loadTargetDescriptor(actualTarget.descriptor);
  };

  const server=http.createServer(async(req,res)=>{
    try{
      const origin=req.headers.origin;
      const own='http://127.0.0.1:'+server.address().port;
      if(!['127.0.0.1:'+server.address().port,'localhost:'+server.address().port].includes(req.headers.host))throw new HttpError(403,'INVALID_HOST');
      if(origin&&origin!==own&&!origins.includes(origin))throw new HttpError(403,'ORIGIN_DENIED');
      if(origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');}
      if(req.method==='OPTIONS'){
        res.writeHead(204,{'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Authorization, Content-Type'});res.end();return;
      }
      const url=new URL(req.url,own);
      if(url.pathname==='/health'&&req.method==='GET'){send(res,200,{service:'evaldock-workbench',status:'ok'});return;}
      const supplied=Buffer.from((req.headers.authorization??'').replace(/^Bearer /,'')),expected=Buffer.from(auth);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new HttpError(401,'UNAUTHORIZED');
      const route=url.pathname.split('/').filter(Boolean).map(x=>decodeURIComponent(x));
      if(route[0]!=='api'||route[1]!=='v1')throw new HttpError(404,'NOT_FOUND');
      const parts=route.slice(2),method=req.method;
      if(method==='GET'&&parts.length===1&&parts[0]==='capabilities'){
        let built=true;try{await access(cliPath);}catch{built=false;}
        send(res,200,{version:'v1',cliBuilt:built,actions:['inspect','plan','run'],progress:'CLI_LOGS_AND_FINAL_SUMMARY',
          executeFrozenPlan:false,selectDatasetIds:false,selectLabelIds:false,caseSelection:'FILTERS_PLANNER_QUEUE',
          cancel:'SIGINT_GRACEFUL',forceKill:false,judgeMode:'CURRENT_CORE_IMPLEMENTATION',
          actualWebTargetConfigured:!!actualTarget,dshControl:['start','stop','restart'],pluginSelection:true,testSizeControls:[],apiConcurrentJobLimit:jobs.maxConcurrentJobs,caseConcurrency:3});return;
      }
      if(parts[0]==='dsh'){
        const control=await dshModule(),descriptor=await actualDescriptor();
        if(method==='GET'&&parts.length===1){send(res,200,await control.dshStatus(descriptor));return;}
        if(method==='GET'&&parts.length===3&&parts[1]==='plugins'&&parts[2]==='search'){
          const {searchPlugins}=await import(pathToFileURL(path.join(repoRoot,'dist/src/app/plugins.js')).href);
          send(res,200,{items:await searchPlugins(url.searchParams.get('q')??'')});return;
        }
        if(method==='POST'&&parts.length===2&&['control','plugins'].includes(parts[1])){
          const input=await body(req);
          const key=parts[1]==='control'?'action':'plugins';
          if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,key))throw new HttpError(400,'INVALID_DSH_REQUEST');
          if(key==='action'&&!['start','stop','restart'].includes(input.action))throw new HttpError(400,'INVALID_DSH_ACTION');
          if(key==='plugins'&&(!Array.isArray(input.plugins)||input.plugins.some(p=>typeof p!=='string')))throw new HttpError(400,'INVALID_PLUGINS');
          if(jobs.children.size)throw new HttpError(409,'DSH_EVALUATION_ACTIVE');
          send(res,200,key==='action'?await control.controlDsh(descriptor,input.action):await control.selectDshPlugins(descriptor,input.plugins));return;
        }
      }
      if(method==='GET'&&parts.length===1&&parts[0]==='targets'){
        const items=await Promise.all(targets.map(async t=>{
          let descriptor=null,error=null;try{descriptor=JSON.parse(await readFile(t.descriptor,'utf8'));}catch{error='TARGET_DESCRIPTOR_UNREADABLE';}
          return {id:t.id,name:t.name,fixture:!!t.fixture,descriptor,warnings:t.warnings??[],error};
        }));send(res,200,{items});return;
      }
      if(method==='GET'&&parts.length===1&&parts[0]==='catalog'){
        
        const labels=await Promise.all((await readdir(path.join(repoRoot,'labels'))).filter(n=>n.endsWith('.json')).sort().map(n=>jsonFile(path.join(repoRoot,'labels'),n)));
        const datasets=[];for(const name of await dirs(path.join(repoRoot,'datasets'))){
          const cases=[];for(const id of await dirs(path.join(repoRoot,'datasets',name))){
            try{const q=await jsonFile(path.join(repoRoot,'datasets'),path.join(name,id,'question.json'));
              cases.push({id,declaredCaseId:q.caseId??null,title:q.title??null,labelIds:q.labelIds??q.labels??null});
            }catch(e){if(e.code!=='ENOENT')cases.push({id,error:'QUESTION_UNREADABLE'});}
          }
          if(cases.length)datasets.push({directory:name,cases});
        }
        const catalogMarkdown=(await readBounded(path.join(repoRoot,'datasets'),'catalog.md',2*1024*1024)).toString();
        send(res,200,{labels,datasets,catalogMarkdown,selectionMode:'STANDARD_POLICY',note:'Planner selects 3–10 Datasets and 3–7 Cases each; smaller Datasets use all available Cases. Explicit caseId is a diagnostic run.'});return;
      }
      if(method==='POST'&&parts.length===1&&parts[0]==='jobs'){send(res,202,await jobs.start(await body(req)));return;}
      if(method==='GET'&&parts.length===1&&parts[0]==='jobs'){
        const offset=uint(url.searchParams.get('offset'),0),limit=Math.max(1,uint(url.searchParams.get('limit'),50,200));
        const all=[...jobs.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        send(res,200,{items:all.slice(offset,offset+limit).map(x=>jobs.view(x)),total:all.length});return;
      }
      if(parts[0]==='jobs'&&parts.length>=2){
        const job=jobs.get(parts[1]);
        if(method==='GET'&&parts.length===2){send(res,200,jobs.view(job));return;}
        if(method==='GET'&&parts.length===3&&parts[2]==='result'){
          const summary=job.summary, result={summary,inspection:null,evaluationPlan:null,caseQueue:[],warnings:[]};
          // Resolve known record types from the trusted configured root, never arbitrary stdout paths.
          if(summary && job.recordRoot && job.action!=='run'){
            for(const [field,type,id] of [['inspection','inspection',summary.inspectionId],['evaluationPlan','evaluation-plan',summary.evaluationPlanId]]){
              if(!id)continue;
              try{result[field]=await jsonFile(job.recordRoot,path.join(token(job.runId),'records',type,token(id)+'.json'));}
              catch(e){if(e.code==='ENOENT')result.warnings.push(field.toUpperCase()+'_NOT_RETAINED');else throw e;}
            }
          }
          // Compatibility mapping for the current CLI batch case IDs; kept in the adapter.
          for(const d of summary?.selectedDatasets??[]){
            const slug=String(d.datasetId).replace(/^dataset\./,'').replace(/\/v[1-9][0-9]*$/,'');
            if(!Number.isSafeInteger(d.caseCount)||d.caseCount<0||d.caseCount>10000)continue;
            for(let i=0;i<d.caseCount;i++)result.caseQueue.push({datasetId:d.datasetId,caseIndex:i,caseId:token(slug+'.case-'+(i+1))});
          }
          send(res,200,result);return;
        }
        if(method==='GET'&&parts.length===3&&parts[2]==='events'){
          const after=uint(url.searchParams.get('after'),0,Number.MAX_SAFE_INTEGER);
          send(res,200,{items:job.events.filter(x=>x.sequence>after),nextCursor:job.sequence,
            gap:job.events.length>0&&after<job.events[0].sequence-1,state:job.state});return;
        }
        if(method==='POST'&&parts.length===3&&parts[2]==='cancel'){const value=await body(req);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)throw new HttpError(400,'EMPTY_OBJECT_REQUIRED');send(res,202,await jobs.cancel(job.id));return;}
      }
      if(method==='GET'&&parts[0]==='runs'){
        if(parts.length===1){
          const all=await listRuns(roots),offset=uint(url.searchParams.get('offset'),0),limit=Math.max(1,uint(url.searchParams.get('limit'),50,200));
          send(res,200,{items:all.slice(offset,offset+limit),total:all.length});return;
        }
        if(parts.length>=4){
          const {root,rel}=runLocation(roots,parts[1],parts[2],parts[3]);
          if(parts.length===4){send(res,200,await readRun(root,rel));return;}
          let file;
          if(parts.length===5&&parts[4]==='html')file=path.join(rel,'report.html');
          if(parts[4]==='cases'&&parts.length>=6){
            const caseId=token(parts[5]);
            if(parts.length===6){send(res,200,await jsonFile(root,path.join(rel,'cases',caseId,'report.json')));return;}
            if(parts.length===7&&parts[6]==='html')file=path.join(rel,'cases',caseId,'report.html');
            if(parts.length>=9&&parts[6]==='files'&&['output','attachments'].includes(parts[7])){
              file=path.join(rel,'cases',caseId,...parts.slice(7));
              // Validate unnormalized segments before path.join erases traversal.
              if(parts.slice(7).some(s=>s==='..'||s==='.'||s.includes('/')||s.includes('\\')))throw new HttpError(400,'INVALID_PATH');
              const bytes=await readBounded(root,file);
              res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(parts.at(-1)),
                'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);return;
            }
          }
          if(file){
            const bytes=await readBounded(root,file);
            res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
              'content-security-policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self' http://127.0.0.1:5173 http://localhost:5173"});
            res.end(bytes);return;
          }
        }
      }
      throw new HttpError(404,'NOT_FOUND');
    }catch(error){
      if(error.message?.startsWith('DSH_')){send(res,error.message.includes('INVALID')?400:409,{error:{code:error.message.split(':')[0],message:error.message}});return;}
      const status=error.status??(error.code==='ENOENT'?404:error instanceof URIError?400:500);
      send(res,status,{error:{code:status===500?'INTERNAL_ERROR':error.code??'INVALID_REQUEST',message:status===500?'Request failed; inspect the API service locally.':error.message}});
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,jobs,url:'http://127.0.0.1:'+server.address().port,
    async close(){await jobs.shutdown();await new Promise(resolve=>server.close(resolve));await jobs.writes;}};
}
