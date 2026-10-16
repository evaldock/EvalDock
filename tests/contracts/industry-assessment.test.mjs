import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndustryAssessment,sha256} from '../../scripts/lib/industry-assessment.mjs';
const digest='a'.repeat(64), label='label.synthetic-domain/v1';
function fixture(extraCases=[]) {
  const cases=[{caseId:'synthetic-zero',datasetId:'dataset.synthetic/v1',questionId:'synthetic-q',task:'Synthetic task',effective:true,scoringStatus:'COMPLETE',executionStatus:'COMPLETED',hasTrace:true,sourceReportSha256:'b'.repeat(64),caseDigest:{value:'c'.repeat(64)},traceDigest:{value:'d'.repeat(64)},weight:1,evaluationMode:'FULL',scores:{[label]:{state:'scored',value:0,scale:{min:0,max:100},standardDigest:digest}}},...extraCases];
  const source={schema:'evaldock.industry-source/v1',roundId:'synthetic-round',cases};
  const manifest={schema:'evaldock.industry-classification/v1',roundId:source.roundId,industries:Array.from({length:14},(_,i)=>({id:'industry-'+i,title:'Synthetic '+i})),cases:cases.map(c=>({caseId:c.caseId,datasetId:c.datasetId,questionId:c.questionId,taskSha256:sha256(c.task),industryId:'industry-0',scoreLabelId:label,classificationReasonCode:'SYNTHETIC_WORKFLOW',classificationReason:'Explicit synthetic workflow'}))};
  return {source,manifest};
}
test('industry projection preserves zero, source weights and private boundaries',()=>{
  const {source,manifest}=fixture();const one=structuredClone(source.cases[0]);one.caseId='second';one.weight=3;one.scores[label].value=100;source.cases.push(one);manifest.cases.push({...manifest.cases[0],caseId:one.caseId});
  source.cases[0].task='PRIVATE-TASK';manifest.cases[0].taskSha256=sha256('PRIVATE-TASK');source.cases[0].sourceReport='/private/source';source.cases[0].scores[label].reason='PRIVATE-JUDGE';
  const original=structuredClone(source),out=buildIndustryAssessment(source,manifest);
  assert.equal(out.industries[0].groups[0].value,75);assert.equal(out.industries[0].groups[0].sampleCount,2);
  assert.equal(out.cases[0].value,0);assert.equal(out.industries.length,14);assert.deepEqual(source,original);assert.doesNotMatch(JSON.stringify(out),/PRIVATE-|\/private\/source/);
});
test('different original labels, frozen standards, scales and modes remain separate',()=>{
 const {source,manifest}=fixture();
 for(const [i,changes] of [{standardDigest:'e'.repeat(64)},{scale:{min:0,max:5},value:4},{mode:'EFFECT'}].entries()){
  const c=structuredClone(source.cases[0]);c.caseId='case-'+i;Object.assign(c.scores[label],changes);if(changes.mode)c.evaluationMode=changes.mode;
  source.cases.push(c);manifest.cases.push({...manifest.cases[0],caseId:c.caseId});
 }
 assert.equal(buildIndustryAssessment(source,manifest).industries[0].groups.length,4);
});
test('partial attempts and quarantine never contribute or trigger supplemental judging',()=>{
 const {source,manifest}=fixture();source.cases[0].effective=false;source.cases[0].scoringStatus='PARTIAL';
 let out=buildIndustryAssessment(source,manifest);assert.equal(out.cases[0].scoringState,'PENDING_SOURCE_COMPLETION');assert.equal(out.industries[0].groups.length,0);
 source.cases[0].scores[label].state='quarantined';source.cases[0].hasTrace=false;out=buildIndustryAssessment(source,manifest);assert.equal(out.cases[0].scoringState,'EXCLUDED');assert.equal(out.industries[0].excludedCount,1);
 source.cases[0].scores={};delete source.cases[0].sourceReportSha256;source.cases[0].executionStatus='NOT_STARTED';assert.equal(buildIndustryAssessment(source,manifest).cases[0].scoringState,'PENDING_EXECUTION');
});
test('unassessable, invalid scores, pending labels and Judge errors retain different states',()=>{
 const {source,manifest}=fixture();const c=source.cases[0];c.scores[label].state='null';c.scores[label].value=null;assert.equal(buildIndustryAssessment(source,manifest).industries[0].unassessableCount,1);
 c.scores[label].state='error';assert.equal(buildIndustryAssessment(source,manifest).cases[0].scoringState,'ERROR');
 c.scores[label].state='scored';c.scores[label].value=101;assert.equal(buildIndustryAssessment(source,manifest).cases[0].scoringState,'INVALID_SCORE');
 c.scores={};assert.equal(buildIndustryAssessment(source,manifest).cases[0].scoringState,'NEEDS_SUPPLEMENT');
});
test('every source Case must have one reviewed decision bound to the exact public task',()=>{
 const {source,manifest}=fixture();manifest.cases[0].taskSha256='wrong';assert.throws(()=>buildIndustryAssessment(source,manifest),/CLASSIFICATION_TASK_MISMATCH/);
 manifest.cases[0].taskSha256=sha256(source.cases[0].task);manifest.cases.push(structuredClone(manifest.cases[0]));assert.throws(()=>buildIndustryAssessment(source,manifest),/CLASSIFICATION_INCOMPLETE/);
 manifest.cases.pop();manifest.cases[0].industryId=null;manifest.cases[0].scoreLabelId=null;const out=buildIndustryAssessment(source,manifest);assert.equal(out.classifiedCaseCount,0);assert.equal(out.outsideScopeCount,1);
});
test('supplemental scores require the same report, Case, Trace and classification binding',()=>{
 const {source,manifest}=fixture();source.cases[0].scores={};const c=source.cases[0];
 const packet={schema:'evaldock.industry-supplement/v1',classificationDigest:sha256(manifest),roundId:source.roundId,caseId:c.caseId,labelId:label,sourceReportSha256:c.sourceReportSha256,sourceCaseDigest:c.caseDigest.value,sourceTraceDigest:c.traceDigest.value,standardDigest:digest,
  score:{status:'SCORED',score:88,labelId:label,caseDigest:c.caseDigest,allTraceDigest:c.traceDigest,labelDigest:{value:digest},scale:{min:0,max:100}}};
 const out=buildIndustryAssessment(source,manifest,[packet]);assert.equal(out.industries[0].supplementalCount,1);assert.equal(out.industries[0].groups[0].value,88);
 packet.sourceReportSha256='wrong';assert.throws(()=>buildIndustryAssessment(source,manifest,[packet]),/SUPPLEMENT_BINDING_MISMATCH/);
});

test('audit CLI validates the exact source snapshot and publishes only the projection',async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');const {assessIndustries}=await import('../../scripts/assess-industries.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'industry-assessment-'));
 try{
  const {source,manifest}=fixture();source.cases[0].task='PRIVATE-TASK';manifest.cases[0].taskSha256=sha256(source.cases[0].task);const bytes=JSON.stringify(source);manifest.sourceSnapshotSha256=sha256(bytes);
  const sourceFile=path.join(root,'source.json'),manifestFile=path.join(root,'manifest.json'),outputRoot=path.join(root,'output');await writeFile(sourceFile,bytes);await writeFile(manifestFile,JSON.stringify(manifest));
  const result=await assessIndustries({sourceFile,manifestFile,outputRoot});assert.equal(result.classifiedCaseCount,1);assert.equal(result.missingSupplementCount,0);
  assert.doesNotMatch(await readFile(path.join(outputRoot,'assessment.json'),'utf8'),/PRIVATE-TASK/);assert.equal(await readFile(sourceFile,'utf8'),bytes);
  await writeFile(sourceFile,bytes+' ');await assert.rejects(assessIndustries({sourceFile,manifestFile,outputRoot}),/SOURCE_SNAPSHOT_CHANGED/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an active assessment lock prevents concurrent writes and model work',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');const {assessIndustries}=await import('../../scripts/assess-industries.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'industry-locked-'));
 try{await writeFile(path.join(root,'.assessment.lock'),'active');await assert.rejects(assessIndustries({outputRoot:root,sourceFile:'unused',manifestFile:'unused',supplement:true}),/ASSESSMENT_ALREADY_RUNNING/);}finally{await rm(root,{recursive:true,force:true});}
});
