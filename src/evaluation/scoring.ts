/** 只按标签汇总数值；无法评分和系统错误分别计数，不转成零分或 PASS/FAIL。 */
import type { DimensionScore, LabelScore } from "./types.js";
export const roundScore = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
export function aggregateScores(scores: readonly LabelScore[]): readonly DimensionScore[] {
  const groups = new Map<string, LabelScore[]>();
  for (const score of scores) groups.set(score.labelId,[...(groups.get(score.labelId) ?? []),score]);
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([labelId,items])=>{
    const first=items[0]!;
    if(items.some(item=>item.scale.min!==first.scale.min || item.scale.max!==first.scale.max ||
      item.labelDigest.value!==first.labelDigest.value)) throw new Error(`Cannot mix scoring standards for ${labelId}`);
    if(items.some(item=>!Number.isFinite(item.weight??1)||(item.weight??1)<0))throw new Error("Invalid score weight");
    const values=items.filter(item=>item.status==="SCORED" && (item.weight??1)>0);
    const totalWeight=values.reduce((n,item)=>n+(item.weight??1),0);
    return {labelId, score:values.length?roundScore(values.reduce((n,item)=>n+item.score!*(item.weight??1),0)/totalWeight):null,
      min:first.scale.min,max:first.scale.max,scoredCases:values.length,
      unassessableCases:items.filter(item=>item.status==="UNASSESSABLE").length,
      errorCases:items.filter(item=>item.status==="ERROR").length};
  });
}
