/** Evaluator-only revisions: archived evidence is verified; Agent execution is never invoked. */
import path from 'node:path';
import {mkdir,lstat,writeFile,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readEvidenceFile,readTraceDirectory} from '../all-trace/store.js';
import {digestBytes,digestEquals,digestValue,freezeJson,validateVersionedAssetId} from '../core/models.js';
import {parseVerifiedReportDocument} from '../reporting/record.js';
import {loadLabels,type LabelDefinition} from '../labels/catalog.js';
import {createDefaultLabelJudge} from './llm-label-judge.js';
import {evaluateLabels} from './evaluate-labels.js';
import {aggregateScores} from './scoring.js';
import type {LabelJudge} from './types.js';

const MAX_ARCHIVE_BYTES=20*1024*1024;
function validateLabel(label:LabelDefinition):void {
  validateVersionedAssetId(label.labelId);
  const scale=label.scoringStandard?.scoring_scale as {min:number;max:number}|undefined;
  if(label.schema!=='evaldock.label/v2' || typeof label.version!=='string' || typeof label.title!=='string' ||
    !label.judge || typeof label.judge.modelRole!=='string' || !Array.isArray(label.judge.instructions) ||
    label.judge.instructions.some(item=>typeof item!=='string') || !Number.isFinite(scale?.min) || !Number.isFinite(scale?.max) || scale!.max<=scale!.min ||
    !digestEquals(label.contentDigest,digestValue(label,['contentDigest'])))throw new Error('Invalid archived label');
}
export async function rescoreArchivedTrace(input:{reportFile:string;revisionId?:string;labelsRoot?:string;labelIds?:readonly string[];
  judge?:LabelJudge;environment?:NodeJS.ProcessEnv;signal?:AbortSignal}) {
  const reportFile=path.resolve(input.reportFile),root=path.dirname(reportFile);
  const readSource=()=>readEvidenceFile(root,path.basename(reportFile),MAX_ARCHIVE_BYTES);
  const sourceBytes=await readSource();
  const report=freezeJson(parseVerifiedReportDocument(sourceBytes.toString('utf8')));
  if(!report.case || !report.allTraceRef)throw new Error('Archived Case and Trace are required');
  if(report.evaluationMode!=='FULL' && report.evaluationMode!=='EFFECT')throw new Error('Original evaluation mode is required');
  const weight=report.case.grading.weight;
  if(weight!==undefined && (typeof weight!=='number'||!Number.isFinite(weight)||weight<0))throw new Error('Invalid grading weight');
  const allTrace=await readTraceDirectory(root,report.allTraceRef,MAX_ARCHIVE_BYTES);
  if(!digestEquals(digestValue(allTrace.scope),digestValue(report.evaluationScope??report.scope)))throw new Error('Trace scope mismatch');
  if(!report.labels.length || new Set(report.labels.map(label=>label.labelId)).size!==report.labels.length)throw new Error('Invalid archived label set');
  report.labels.forEach(validateLabel);
  const ids=input.labelIds??report.labels.map(label=>String(label.labelId));
  if(!ids.length || new Set(ids).size!==ids.length || ids.some(id=>!report.labels.some(label=>label.labelId===id)))throw new Error('Unknown or duplicate label selection');
  const catalog=input.labelsRoot?await loadLabels(input.labelsRoot):report.labels;
  const labels=ids.map(id=>{const label=catalog.find(item=>item.labelId===id);if(!label)throw new Error('Updated scoring label is missing');return label;});
  const revisionId=input.revisionId??`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(revisionId))throw new Error('Invalid revision ID');
  // Root is already canonical and symlink-free through readEvidenceFile. Never reuse a revision directory.
  const parent=path.join(root,'score-revisions');
  await mkdir(parent,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error;});
  if(!(await lstat(parent)).isDirectory() || await realpath(parent)!==parent)throw new Error('Invalid revision directory');
  const revisionDirectory=path.join(parent,revisionId);
  await mkdir(revisionDirectory,{mode:0o700});
  const save=(name:string,value:unknown)=>writeFile(path.join(revisionDirectory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const identity={schema:'evaldock.score-revision/v1',revisionId,createdAt:new Date().toISOString(),
    sourceReportFile:path.basename(reportFile),sourceReportDigest:report.contentDigest,sourceFileDigest:digestBytes(sourceBytes),
    scope:allTrace.scope,caseId:report.case.caseId,caseDigest:report.case.contentDigest,allTraceDigest:allTrace.contentDigest,
    evaluationMode:report.evaluationMode,labels,originalLabelDigests:report.labels.filter(label=>ids.includes(label.labelId)).map(label=>({labelId:label.labelId,contentDigest:label.contentDigest}))};
  await save('started.json',identity);
  try {
    const judge=input.judge??createDefaultLabelJudge(input.environment??process.env,input.signal,path.join(revisionDirectory,'judge','requests'));
    const caseData=freezeJson({...report.case,seedEntries:[]});
    const scores=await evaluateLabels(judge,labels.map(label=>({label,case:caseData,allTrace,evaluationMode:report.evaluationMode!})),input.signal);
    if(input.signal?.aborted || scores.length!==labels.length)throw new Error('Scoring interrupted');
    // Recheck the source after asynchronous Judge calls before publishing a revision.
    if(!digestEquals(digestBytes(await readSource()),identity.sourceFileDigest))throw new Error('Source report changed');
    await readTraceDirectory(root,report.allTraceRef,MAX_ARCHIVE_BYTES);
    const body={...identity,status:scores.some(score=>score.status==='ERROR')?'SCORING_ERROR':'COMPLETE',completedAt:new Date().toISOString(),scores,dimensions:aggregateScores(scores)};
    const result={...body,contentDigest:digestValue(body)};
    const e=(value:unknown)=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
    const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Score revision ${e(revisionId)}</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#222}table{border-collapse:collapse;width:100%}td,th{padding:12px;border:1px solid #ddd;text-align:left}p{overflow-wrap:anywhere}</style><h1>Score revision</h1><p>${e(revisionId)} · ${e(body.status)} · ${e(report.evaluationMode)}</p><p>Archived evidence was reused. The Agent was not run again. This revision does not replace the original report.</p><p>Trace: ${e(allTrace.contentDigest.value)}</p><table><tr><th>Label</th><th>Status</th><th>Score</th><th>Reason / evidence</th></tr>${scores.map(score=>`<tr><td>${e(score.labelId)}</td><td>${e(score.status)}</td><td>${e(score.score??'—')} / ${e(score.scale.max)}</td><td>${e(score.reason)}<p>${e(score.evidenceIds.join(', '))}</p></td></tr>`).join('')}</table><p><a href="report.json">Revision JSON</a> · <a href="../../${encodeURIComponent(path.basename(reportFile))}">Original report JSON</a> · <a href="../../all-trace/manifest.json">Original Trace manifest</a></p></html>`;
    await writeFile(path.join(revisionDirectory,'report.html'),html,{flag:'wx',mode:0o600});
    await save('report.json',result);
    return {revisionDirectory,result};
  } catch(error) {
    await save('failure.json',{...identity,status:'FAILED',reason:'RESCORE_FAILED',completedAt:new Date().toISOString()});
    throw error;
  }
}
