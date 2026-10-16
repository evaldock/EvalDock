import {createHash} from 'node:crypto';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const requireThat = (condition, code) => { if (!condition) throw Error(code); };
const digest = value => typeof value === 'string' ? value : value?.value;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validValue = score => finite(score?.value) && finite(score.scale?.min) && finite(score.scale?.max) && score.scale.max > score.scale.min && score.value >= score.scale.min && score.value <= score.scale.max;
export function validateClassification(source, manifest) {
  requireThat(source.schema === 'evaldock.industry-source/v1' && manifest.schema === 'evaldock.industry-classification/v1' && source.roundId === manifest.roundId, 'INDUSTRY_SCOPE_MISMATCH');
  requireThat(manifest.industries?.length === 14 && new Set(manifest.industries.map(i => i.id)).size === 14, 'INDUSTRY_SET_INVALID');
  const ids = new Set(manifest.industries.map(i => i.id));
  requireThat(Array.isArray(source.cases) && Array.isArray(manifest.cases) && source.cases.length === manifest.cases.length, 'CLASSIFICATION_INCOMPLETE');
  const cases = new Map(source.cases.map(c => [c.caseId, c]));
  requireThat(cases.size === source.cases.length && new Set(manifest.cases.map(c => c.caseId)).size === cases.size, 'DUPLICATE_INDUSTRY_CASE');
  for (const decision of manifest.cases) {
    const c = cases.get(decision.caseId);
    requireThat(c && decision.datasetId === c.datasetId && decision.questionId === c.questionId && typeof c.task === 'string' && sha256(c.task) === decision.taskSha256, 'CLASSIFICATION_TASK_MISMATCH');
    requireThat(typeof decision.classificationReasonCode === 'string' && !!decision.classificationReasonCode && typeof decision.classificationReason === 'string' && !!decision.classificationReason, 'CLASSIFICATION_REASON_REQUIRED');
    requireThat(decision.industryId === null || ids.has(decision.industryId) && /^label\.[a-zA-Z0-9.-]+\/v\d+$/.test(decision.scoreLabelId), 'CLASSIFICATION_INDUSTRY_INVALID');
  }
  return cases;
}
export function buildIndustryAssessment(source, manifest, packets = []) {
  const sources = validateClassification(source, manifest);
  const supplements = new Map();
  for (const packet of packets) {
    const key = packet.caseId + '::' + packet.labelId;
    requireThat(!supplements.has(key), 'DUPLICATE_SUPPLEMENT'); supplements.set(key, packet);
  }
  const cases = [];
  for (const decision of manifest.cases) {
    const c = sources.get(decision.caseId);
    const row = {caseId:c.caseId, datasetId:c.datasetId, questionId:c.questionId, industryId:decision.industryId,
      classificationReasonCode:decision.classificationReasonCode, classificationReason:decision.classificationReason,
      scoringState:'OUTSIDE_SCOPE', value:null, sourceLabelId:decision.scoreLabelId, weight:c.weight ?? 1,
      evaluationMode:c.evaluationMode ?? 'UNKNOWN', sourceReportSha256:c.sourceReportSha256 ?? null,
      sourceTraceDigest:digest(c.traceDigest) ?? null, sourceRevision:c.scoreRevision?.id ?? null, origin:null};
    requireThat(finite(row.weight) && row.weight >= 0, 'INDUSTRY_WEIGHT_INVALID');
    if (!row.industryId) { cases.push(row); continue; }
    if (!c.sourceReportSha256 || !c.hasTrace) row.scoringState = c.executionStatus === 'NOT_STARTED' ? 'PENDING_EXECUTION' : 'EVIDENCE_UNAVAILABLE';
    else if (!c.effective || c.scoringStatus !== 'COMPLETE') row.scoringState = Object.values(c.scores).some(s => s.state === 'quarantined') ? 'EXCLUDED' : 'PENDING_SOURCE_COMPLETION';
    else {
      let score = c.scores[decision.scoreLabelId];
      if (score) row.origin = 'REUSED';
      else {
        const packet = supplements.get(c.caseId + '::' + decision.scoreLabelId);
        if (packet) {
          requireThat(packet.schema === 'evaldock.industry-supplement/v1' && packet.classificationDigest === sha256(manifest) && packet.roundId === source.roundId && packet.sourceReportSha256 === c.sourceReportSha256 && packet.sourceCaseDigest === digest(c.caseDigest) && packet.sourceTraceDigest === digest(c.traceDigest), 'SUPPLEMENT_BINDING_MISMATCH');
          const s = packet.score;
          requireThat(s?.labelId === packet.labelId && digest(s.caseDigest) === packet.sourceCaseDigest && digest(s.allTraceDigest) === packet.sourceTraceDigest && digest(s.labelDigest) === packet.standardDigest, 'SUPPLEMENT_SCORE_BINDING_MISMATCH');
          score = {state:({SCORED:'scored',UNASSESSABLE:'null',ERROR:'error'})[s.status], value:s.score, scale:s.scale, standardDigest:packet.standardDigest};
          row.origin = 'SUPPLEMENTAL';
        }
      }
      if (!score) row.scoringState = 'NEEDS_SUPPLEMENT';
      else {
        row.standardDigest = score.standardDigest;
        row.scale = score.scale;
        row.scoringState = score.state === 'null' ? 'UNASSESSABLE' : score.state === 'error' ? 'ERROR' : score.state === 'scored' && validValue(score) && /^[a-f0-9]{64}$/.test(score.standardDigest ?? '') ? 'SCORED' : 'INVALID_SCORE';
        if (row.scoringState === 'SCORED') row.value = score.value;
      }
    }
    cases.push(row);
  }
  const industries = manifest.industries.map(industry => {
    const rows = cases.filter(c => c.industryId === industry.id), groups = new Map();
    for (const row of rows) {
      if (!row.standardDigest || !row.scale || !['SCORED','UNASSESSABLE','ERROR'].includes(row.scoringState)) continue;
      const key = [row.sourceLabelId,row.standardDigest,row.scale.min,row.scale.max,row.evaluationMode].join('::');
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
    }
    const count = state => rows.filter(r => r.scoringState === state).length;
    const groupRows = [...groups].map(([id, items]) => {
      const values = items.filter(r => r.scoringState === 'SCORED' && r.weight > 0), totalWeight = values.reduce((n,r)=>n+r.weight,0), first = items[0];
      return {id,sourceLabelId:first.sourceLabelId,standardDigest:first.standardDigest,scale:first.scale,evaluationMode:first.evaluationMode,
        value:values.length ? Math.round((values.reduce((n,r)=>n+r.value*r.weight,0)/totalWeight + Number.EPSILON)*100)/100 : null,
        sampleCount:values.length,totalWeight,reusedCount:values.filter(r=>r.origin==='REUSED').length,supplementalCount:values.filter(r=>r.origin==='SUPPLEMENTAL').length,
        unassessableCount:items.filter(r=>r.scoringState==='UNASSESSABLE').length,errorCount:items.filter(r=>r.scoringState==='ERROR').length};
    });
    return {...industry, status:groupRows.some(g=>g.sampleCount>0)?'AVAILABLE':count('PENDING_EXECUTION')?'PENDING_EXECUTION':count('NEEDS_SUPPLEMENT')?'PENDING_SCORING':count('UNASSESSABLE')?'UNASSESSABLE':rows.length?'NO_EFFECTIVE_SCORE':'NO_APPLICABLE_CASES',
      classifiedCaseCount:rows.length,reusedCount:rows.filter(r=>r.origin==='REUSED' && r.scoringState==='SCORED' && r.weight>0).length,
      supplementalCount:rows.filter(r=>r.origin==='SUPPLEMENTAL' && r.scoringState==='SCORED' && r.weight>0).length,
      supplementalAttemptCount:rows.filter(r=>r.origin==='SUPPLEMENTAL').length,pendingExecutionCount:count('PENDING_EXECUTION'),pendingScoreCount:count('NEEDS_SUPPLEMENT')+count('PENDING_SOURCE_COMPLETION'),
      unassessableCount:count('UNASSESSABLE'),errorCount:count('ERROR')+count('INVALID_SCORE'),excludedCount:count('EXCLUDED'),evidenceUnavailableCount:count('EVIDENCE_UNAVAILABLE'),groups:groupRows};
  });
  const missingSupplementCount = cases.filter(c=>c.scoringState==='NEEDS_SUPPLEMENT').length;
  return {schema:'evaldock.industry-assessment/v1',assessmentState:missingSupplementCount?'SCORING':'COMPLETE',missingSupplementCount,roundId:source.roundId,classificationDigest:sha256(manifest),sourceSnapshotSha256:manifest.sourceSnapshotSha256,
    sourceGeneratedAt:source.generatedAt,generatedAt:new Date().toISOString(),plannedCaseCount:source.cases.length,classifiedCaseCount:cases.filter(c=>c.industryId).length,outsideScopeCount:cases.filter(c=>!c.industryId).length,
    policy:'One reviewed primary industry per Case. Only the original selected effective COMPLETE attempt contributes. Reused and supplemental scores retain their original standard digest, label, scale and evaluation mode. Original reports and traces are immutable.',industries,cases};
}
