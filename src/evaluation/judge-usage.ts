import type { JudgeRequestUsage, LabelScore } from "./types.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Provider usage only. Cache hits are already part of prompt_tokens, never additional tokens. */
export function providerUsage(value: unknown): Pick<JudgeRequestUsage,"inputTokens"|"outputTokens"|"cacheHitTokens"|"cacheMissTokens"> {
  const usage=object(value);
  const inputTokens=count(usage.prompt_tokens);
  const outputTokens=count(usage.completion_tokens);
  let cacheHitTokens=count(usage.prompt_cache_hit_tokens) ?? count(object(usage.prompt_tokens_details).cached_tokens);
  let cacheMissTokens=count(usage.prompt_cache_miss_tokens);
  if(inputTokens!==null && cacheHitTokens!==null && cacheHitTokens>inputTokens) cacheHitTokens=null;
  if(inputTokens!==null && cacheMissTokens!==null && cacheMissTokens>inputTokens) cacheMissTokens=null;
  if(inputTokens!==null && cacheHitTokens!==null) {
    if(cacheMissTokens!==null && cacheMissTokens+cacheHitTokens!==inputTokens) {cacheHitTokens=null;cacheMissTokens=null;}
    else cacheMissTokens=inputTokens-cacheHitTokens;
  }
  return {inputTokens,outputTokens,cacheHitTokens,cacheMissTokens};
}

/** A batch's usage appears on each label record; count physical request IDs just once. */
export function summarizeJudgeUsage(scores: readonly LabelScore[]) {
  const requests=new Map<string,JudgeRequestUsage>();
  for(const score of scores) for(const request of score.diagnostics?.requests??[]) requests.set(request.requestId,request);
  const rows=[...requests.values()];
  const sum=(key:"inputTokens"|"outputTokens"|"cacheHitTokens"|"cacheMissTokens") => {
    const known=rows.map(row=>row[key]).filter((value):value is number=>value!==null);
    return known.length ? known.reduce((a,b)=>a+b,0) : null;
  };
  const inputTokens=sum("inputTokens"),cacheHitTokens=sum("cacheHitTokens");
  return {requestCount:rows.length,untrackedScoreCount:scores.filter(score=>score.diagnostics?.requests===undefined && score.model!=="not-invoked").length,
    unknownUsageRequests:rows.filter(row=>row.inputTokens===null || row.outputTokens===null).length,
    requestBytes:rows.reduce((sum,row)=>sum+row.requestBytes,0),
    inputTokens,outputTokens:sum("outputTokens"),cacheHitTokens,cacheMissTokens:sum("cacheMissTokens"),
    // A partial usage set must not be presented as a complete cache hit rate.
    cacheHitRate:rows.length && rows.every(row=>row.inputTokens!==null && row.cacheHitTokens!==null) && inputTokens && cacheHitTokens!==null ? cacheHitTokens/inputTokens : null,
  };
}
