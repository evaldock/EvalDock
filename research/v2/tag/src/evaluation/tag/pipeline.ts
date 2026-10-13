import {mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {AllTrace} from '../../all-trace/types.js';
import {buildTag,type Obj} from './graph.js';
import {compactPresentation} from './grouping.js';
import {ConfiguredTagJudge,evaluateGraph,rubricVersion,safeTagError,type TagJudge} from './judge.js';
export interface TagEvaluationSummary {
 schema:'evaldock.tag-evaluation/v1';status:'COMPLETE'|'ERROR'|'NO_ACTIONS';href:'tag/index.html';
 model:string;rubricVersion:string;records:number;actions:number;scored:number;notApplicable:number;insufficientEvidence:number;errorCount:number;
 scope:'tool-actions';aggregation:'none';traceDigest:AllTrace['contentDigest'];grouping:string;reason?:string;manifestSha256?:string;
}
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const embedded=(v:unknown)=>JSON.stringify(v).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
export async function renderTag(graph:Obj,context:Obj,embeddedView=false){
 graph={...graph,presentation:compactPresentation(graph.presentation??{},graph.records?.length??graph.meta.recordCount??0)};
 const asset=(name:string)=>readFile(new URL('./assets/'+name,import.meta.url),'utf8');
 let html=await asset('template.html');
 const css=(await Promise.all(['style.css','edges.css','context.css','workbench-theme.css'].map(asset))).join('\n');
 const layout=await asset('layout.js');
 const js=(await Promise.all(['app.js',...(context.frames.length?['context.js']:[]),'simple-ui.js'].map(asset))).join('\n');
 html=html.replace('/*__CSS__*/',()=>css).replace('/*__DATA__*/',()=>embedded(graph)).replace('/*__LAYOUT__*/',()=>layout).replace('/*__JS__*/',()=>js);
 if(embeddedView)html=html.replace('<body>','<body class="embedded-tag">');
 return html.replace('<script id="graph-data"',()=>'<script id="context-data" type="application/json">'+embedded(context)+'</script><script id="graph-data"');
}
export async function runTagEvaluation(input:{trace:AllTrace;task:string;grading:unknown;title:string;caseDirectory:string;judge?:TagJudge;env?:NodeJS.ProcessEnv;signal?:AbortSignal}):Promise<TagEvaluationSummary>{
 const env=input.env??process.env,judge=input.judge??new ConfiguredTagJudge(env);
 const base:TagEvaluationSummary={schema:'evaldock.tag-evaluation/v1',status:'ERROR',href:'tag/index.html',model:judge.model,rubricVersion,records:input.trace.entries.length,actions:0,scored:0,notApplicable:0,insufficientEvidence:0,errorCount:0,scope:'tool-actions',aggregation:'none',traceDigest:input.trace.contentDigest,grouping:'records'};
 const dir=path.join(input.caseDirectory,'tag');
 try{
  // Never persist a configured credential if an upstream payload accidentally contains it.
  const secrets=Object.entries(env).filter(([k,v])=>/(API_KEY|TOKEN|PASSWORD|SECRET)$/.test(k)&&v&&v.length>=12).map(([,v])=>v!);
  const guard=(s:string)=>{if(secrets.some(v=>s.includes(v)))throw Error('TAG_CREDENTIAL_IN_EVIDENCE');};
  guard(JSON.stringify({trace:input.trace,grading:input.grading}));
  await mkdir(path.join(dir,'data'),{recursive:true,mode:0o700});
  const {graph,context}=buildTag(input.trace,input.task,input.title);base.actions=graph.nodes.filter((n:Obj)=>n.subtype==='action').length;
  const guarded:TagJudge={model:judge.model,async call(packet,signal){guard(JSON.stringify(packet));const out=await judge.call(packet,signal);guard(JSON.stringify(out));return out;}};
  await evaluateGraph(graph,input.grading,guarded,path.join(dir,'audit'),input.signal);
  for(const a of graph.assessments){if(a.status==='scored')base.scored++;else if(a.status==='not_applicable')base.notApplicable++;else if(a.status==='insufficient_evidence')base.insufficientEvidence++;else base.errorCount++;}
  base.errorCount+=Math.max(0,base.actions*5-graph.assessments.length);base.status=base.errorCount?'ERROR':base.actions?'COMPLETE':'NO_ACTIONS';base.grouping=graph.presentation.grouping;
  await writeFile(path.join(dir,'data/trace.json'),JSON.stringify(input.trace),{mode:0o600});
  await writeFile(path.join(dir,'data/graph.json'),JSON.stringify(graph),{mode:0o600});
  await writeFile(path.join(dir,'data/context.json'),JSON.stringify(context),{mode:0o600});
  await writeFile(path.join(dir,'index.html'),await renderTag(graph,context),{mode:0o600});
  const files:Record<string,string>={};
  const walk=async(rel:string)=>{for(const f of await readdir(path.join(dir,rel),{withFileTypes:true})){const p=path.posix.join(rel,f.name);if(f.isDirectory())await walk(p);else if(f.isFile()&&p!=='manifest.json')files[p]=hash(await readFile(path.join(dir,p)));else if(!f.isFile())throw Error('TAG_UNSAFE_ARTIFACT');}};
  await walk('');const manifest=JSON.stringify({schema:'evaldock.tag-artifacts/v1',traceDigest:input.trace.contentDigest,files});await writeFile(path.join(dir,'manifest.json'),manifest,{mode:0o600});base.manifestSha256=hash(manifest);
 }catch(e){base.status='ERROR';base.errorCount=Math.max(1,base.errorCount);base.reason=safeTagError(e);}
 return base;
}
export async function verifyTagArtifacts(caseDirectory:string,summary:TagEvaluationSummary,traceDigest?:AllTrace['contentDigest']){
 if(traceDigest&&summary.traceDigest.value!==traceDigest.value)throw Error('TAG_TRACE_DIGEST');
 if(!summary.manifestSha256){if(summary.status==='ERROR')return;throw Error('TAG_MANIFEST_MISSING');}
 const root=path.join(caseDirectory,'tag'),body=await readFile(path.join(root,'manifest.json'));if(hash(body)!==summary.manifestSha256)throw Error('TAG_MANIFEST_DIGEST');
 const manifest=JSON.parse(body.toString('utf8'));if(JSON.stringify(manifest.traceDigest)!==JSON.stringify(summary.traceDigest))throw Error('TAG_TRACE_DIGEST');
 for(const [name,digest] of Object.entries(manifest.files)){
  if(!name||name.split('/').some(p=>!p||p==='.'||p==='..')||name.includes('\\'))throw Error('TAG_UNSAFE_ARTIFACT');
  let current=root;for(const part of name.split('/')){current=path.join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('TAG_UNSAFE_ARTIFACT');}
  if(hash(await readFile(current))!==digest)throw Error('TAG_ARTIFACT_DIGEST');
 }
}
