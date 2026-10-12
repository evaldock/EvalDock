import type { JudgeInput, LabelJudge, LabelScore } from "./types.js";
import { unavailableReferenceScore } from "./llm-label-judge.js";

/** Common entry point for CLI, native adapters and deferred BenchDock scoring. */
export async function evaluateLabels(judge: LabelJudge, inputs: readonly JudgeInput[], signal?: AbortSignal): Promise<readonly LabelScore[]> {
  if (inputs.every(input=>input.case.grading.mode==="unavailable")) return inputs.map(unavailableReferenceScore);
  if (judge.evaluateBatch) {
    const scores=await judge.evaluateBatch(inputs);
    if(scores.length!==inputs.length || scores.some((score,index)=>score.labelId!==String(inputs[index]!.label.labelId))) throw new Error("JUDGE_BATCH_RESULT_MISMATCH");
    return scores;
  }
  // Preserve compatibility with fixture and third-party single-label judges.
  const scores:LabelScore[]=[];
  for(const input of inputs) {
    if(signal?.aborted) break;
    scores.push(input.case.grading.mode==="unavailable" ? unavailableReferenceScore(input) : await judge.evaluate(input));
  }
  return scores;
}
