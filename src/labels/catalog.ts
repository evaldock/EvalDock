/** labels/ 是评分标准的唯一来源。加载后深度冻结，Judge 不再读取磁盘。 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { freezeJson, digestValue, validateVersionedAssetId, type ContentDigest, type JsonObject, type LabelId } from "../core/models.js";

export interface LabelDefinition {
  readonly schema: "evaldock.label/v2";
  readonly version: string;
  readonly labelId: LabelId;
  readonly title: string;
  readonly scoringStandard: JsonObject;
  readonly judge: { readonly modelRole: string; readonly instructions: readonly string[] };
  readonly contentDigest: ContentDigest;
}
export async function loadLabels(root: string): Promise<readonly LabelDefinition[]> {
  const labels: LabelDefinition[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = JSON.parse(await readFile(path.join(root,entry.name),"utf8"));
    if (raw.schema !== "evaldock.label/v2" || typeof raw.version !== "string" ||
        typeof raw.title !== "string" || !raw.scoringStandard || !raw.judge ||
        typeof raw.judge.modelRole !== "string" || !Array.isArray(raw.judge.instructions) ||
        raw.judge.instructions.some((item: unknown) => typeof item !== "string")) {
      throw new Error(`Invalid label asset: ${entry.name}`);
    }
    const scale = raw.scoringStandard.scoring_scale;
    if (!Number.isFinite(scale?.min) || !Number.isFinite(scale?.max) || scale.max <= scale.min) {
      throw new Error(`Invalid label scoring scale: ${entry.name}`);
    }
    const labelId = validateVersionedAssetId<"LabelId">(raw.labelId);
    if (labels.some(label => label.labelId === labelId)) throw new Error(`Duplicate label ${labelId}`);
    if (["evidence", "metricId"].some(key => key in raw) || "passScore" in raw.judge) {
      throw new Error(`Obsolete label rules in ${entry.name}`);
    }
    labels.push(freezeJson({ ...raw, labelId, contentDigest: digestValue(raw) }));
  }
  return Object.freeze(labels);
}
