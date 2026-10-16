#!/usr/bin/env node
/** Audit/rescore existing selected attempts only. Never starts an Agent or edits source reports. */
import {readFile,writeFile,mkdir,lstat,realpath,rename,readdir,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildIndustryAssessment,sha256} from './lib/industry-assessment.mjs';
const requireThat=(v,code)=>{if(!v)throw Error(code);};
async function regular(file){const s=await lstat(file);requireThat(s.isFile()&&!s.isSymbolicLink()&&s.size<64*1024*1024,'INDUSTRY_INPUT_INVALID');return readFile(file);}
export async function assessIndustries(options) {
  const root=path.resolve(options.outputRoot);await mkdir(root,{recursive:true,mode:0o700});requireThat(!(await lstat(root)).isSymbolicLink(),'INDUSTRY_OUTPUT_SYMLINK');
  const file=path.join(root,'.assessment.lock');let lock;
  try{lock=await open(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('ASSESSMENT_ALREADY_RUNNING');throw e;}
  try{return await assessUnlocked(options);}finally{await lock.close();await unlink(file);}
}
async function assessUnlocked({sourceFile,manifestFile,outputRoot,runtimeRoot,supplement=false,retryErrors=false,maxCases=0,concurrency=2,judge}) {
  const sourceBytes=await regular(sourceFile),source=JSON.parse(sourceBytes),manifest=JSON.parse(await regular(manifestFile));
  requireThat(sha256(sourceBytes)===manifest.sourceSnapshotSha256,'SOURCE_SNAPSHOT_CHANGED');
  const initial=buildIndustryAssessment(source,manifest),manifestDigest=sha256(manifest);
  const sourceCases=new Map(source.cases.map(c=>[c.caseId,c]));
  const needed=initial.cases.filter(c=>c.scoringState==='NEEDS_SUPPLEMENT');
  requireThat(!supplement||Number.isInteger(maxCases)&&needed.length<=maxCases,'SUPPLEMENT_LIMIT_EXCEEDED');
  const root=path.resolve(outputRoot);await mkdir(root,{recursive:true,mode:0o700});requireThat(!(await lstat(root)).isSymbolicLink(),'INDUSTRY_OUTPUT_SYMLINK');
  const packets=[];let count=0;
  if(supplement){
    requireThat(runtimeRoot&&Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4,'INVALID_SUPPLEMENT_RUNTIME');
    const runtime=await realpath(runtimeRoot),load=rel=>import(pathToFileURL(path.join(runtime,rel)).href);
    const [{loadLabels},{readTraceDirectory},{parseVerifiedReportDocument},{createDefaultLabelJudge},{loadModelEnvironment}]=await Promise.all([
      load('dist/src/labels/catalog.js'),load('dist/src/all-trace/store.js'),load('dist/src/reporting/record.js'),load('dist/src/evaluation/llm-label-judge.js'),load('dist/src/platform/model-environment.js')]);
    const labels=new Map((await loadLabels(path.join(runtime,'labels'))).map(l=>[l.labelId,l]));
    // Credentials are loaded inside the evaluation host; never serialized into reports or logs.
    if(!judge){const {environment}=await load('collaboration/config.mjs');Object.assign(process.env,environment(runtime));await loadModelEnvironment(process.env);judge=createDefaultLabelJudge();}
    const jobs=[...needed];
    async function worker(){for(;;){const row=jobs.shift();if(!row)return;const c=sourceCases.get(row.caseId),label=labels.get(row.sourceLabelId);requireThat(label,'SUPPLEMENT_LABEL_UNAVAILABLE');
      const id=sha256([source.roundId,manifestDigest,c.caseId,row.sourceLabelId,c.sourceReportSha256,label.contentDigest.value]);
      const file=path.join(root,'supplements',id+'.json');await mkdir(path.dirname(file),{recursive:true,mode:0o700});
      const attempts=(await readdir(path.dirname(file))).map(name=>({name,match:name.match(new RegExp('^'+id+'(?:\\.attempt-(\\d+))?\\.json$'))})).filter(x=>x.match).sort((a,b)=>Number(a.match[1]??0)-Number(b.match[1]??0));
      const previous=attempts.at(-1);let packet=previous?JSON.parse(await regular(path.join(path.dirname(file),previous.name))):null;
      if(!packet || retryErrors && packet.score.status==='ERROR'){
        const next=previous?Number(previous.match[1]??0)+1:0;requireThat(next<=3,'SUPPLEMENT_RETRY_LIMIT_EXCEEDED');
        const bytes=await regular(c.sourceReport);requireThat(sha256(bytes)===c.sourceReportSha256,'SOURCE_REPORT_CHANGED');
        const report=parseVerifiedReportDocument(bytes.toString());
        requireThat(report.fixture!==true&&report.case?.contentDigest?.value===c.caseDigest?.value&&report.allTraceRef?.contentDigest?.value===c.traceDigest?.value,'SUPPLEMENT_SOURCE_BINDING_INVALID');
        const allTrace=await readTraceDirectory(path.dirname(c.sourceReport),report.allTraceRef,64*1024*1024);
        const score=await judge.evaluate({label,case:report.case,allTrace,evaluationMode:c.evaluationMode});
        packet={schema:'evaldock.industry-supplement/v1',roundId:source.roundId,classificationDigest:manifestDigest,caseId:c.caseId,labelId:row.sourceLabelId,
          sourceReportSha256:c.sourceReportSha256,sourceCaseDigest:c.caseDigest.value,sourceTraceDigest:c.traceDigest.value,standardDigest:label.contentDigest.value,createdAt:new Date().toISOString(),score};
        const destination=next?path.join(path.dirname(file),id+'.attempt-'+next+'.json'):file;
        await writeFile(destination,JSON.stringify(packet,null,2)+'\n',{flag:'wx',mode:0o600});
      }
      packets.push(packet);count++;console.log(JSON.stringify({event:'industry-supplement',completed:count,total:needed.length,caseId:c.caseId,state:packet.score.status}));
    }}
    const settled=await Promise.allSettled(Array.from({length:concurrency},worker));const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  } else {
    // Reload only packets bound to this manifest. Every packet is revalidated by the projector.
    let files=[];try{files=await readdir(path.join(root,'supplements'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const latest=new Map();for(const file of files){const match=file.match(/^([a-f0-9]{64})(?:\.attempt-(\d+))?\.json$/);if(!match)continue;const attempt=Number(match[2]??0);if(!latest.has(match[1])||latest.get(match[1]).attempt<attempt)latest.set(match[1],{file,attempt});}
    for(const {file} of latest.values()){const packet=JSON.parse(await regular(path.join(root,'supplements',file)));if(packet.classificationDigest===manifestDigest)packets.push(packet);}
  }
  const assessment=buildIndustryAssessment(source,manifest,packets);
  const temp=path.join(root,`assessment.${process.pid}.tmp`);await writeFile(temp,JSON.stringify(assessment,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temp,path.join(root,'assessment.json'));
  return {schema:assessment.schema,roundId:assessment.roundId,classificationDigest:assessment.classificationDigest,classifiedCaseCount:assessment.classifiedCaseCount,missingSupplementCount:assessment.cases.filter(c=>c.scoringState==='NEEDS_SUPPLEMENT').length,
    industries:assessment.industries.map(({id,status,reusedCount,supplementalCount,pendingExecutionCount,pendingScoreCount,unassessableCount,errorCount,groups})=>({id,status,reusedCount,supplementalCount,pendingExecutionCount,pendingScoreCount,unassessableCount,errorCount,groups:groups.map(({value,sampleCount,sourceLabelId})=>({value,sampleCount,sourceLabelId}))}))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href){
 try{const options={};for(let i=2;i<process.argv.length;i++){const a=process.argv[i];if(a==='--supplement')options.supplement=true;else if(a==='--retry-errors')options.retryErrors=true;else{requireThat(['--source','--manifest','--output','--runtime-root','--max-cases','--concurrency'].includes(a)&&process.argv[i+1],'INVALID_ARGUMENT');options[a.slice(2)]=process.argv[++i];}}
  requireThat(options.source&&options.manifest&&options.output,'SOURCE_MANIFEST_OUTPUT_REQUIRED');
  console.log(JSON.stringify(await assessIndustries({sourceFile:options.source,manifestFile:options.manifest,outputRoot:options.output,runtimeRoot:options['runtime-root'],supplement:options.supplement,retryErrors:options.retryErrors,maxCases:Number(options['max-cases']??0),concurrency:Number(options.concurrency??2)}),null,2));
 }catch(error){console.error(JSON.stringify({error:error.message??'INDUSTRY_ASSESSMENT_FAILED'}));process.exitCode=1;}
}
