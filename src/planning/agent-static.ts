/** 文件功能：把已完成的 DSH Inspection 投影成统一 Planner 使用的非敏感静态信息。 */
import type {
  InspectionSnapshot,
  JsonObject,
  JsonValue,
  TargetDescriptor,
} from "../core/models.js";

export interface AgentStaticInfo extends JsonObject {
  readonly target_type: "FULL_AGENT";
  readonly tools: readonly JsonValue[];
  readonly tool_delta: JsonObject;
  readonly permission_preset: string;
  readonly sandbox_mode: string;
  readonly probe: JsonObject;
  readonly limitations: readonly JsonValue[];
}

export interface DshStaticInfo extends AgentStaticInfo {
  readonly dsh_version: JsonValue;
  readonly profile: JsonValue;
  readonly plugins: readonly JsonValue[];
}

export type StaticInfoInspection = Pick<
  InspectionSnapshot,
  | "dshVersionStatus"
  | "profile"
  | "pluginCatalog"
  | "probeConfigured"
  | "probeSchema"
  | "probeOrderStatus"
  | "toolSchemas"
  | "toolDelta"
  | "permissionPreset"
  | "sandboxMode"
  | "limitations"
>;

/** 纯投影已有 Inspector 事实；不会再次扫描 DSH，也不会调用模型。 */
export function projectDshStaticInfo(
  descriptor: Pick<TargetDescriptor, "targetType">,
  inspection: StaticInfoInspection,
): DshStaticInfo {
  return Object.freeze({
    target_type: descriptor.targetType,
    dsh_version: inspection.dshVersionStatus,
    profile: inspection.profile,
    plugins: inspection.pluginCatalog,
    tools: inspection.toolSchemas,
    tool_delta: inspection.toolDelta,
    permission_preset: inspection.permissionPreset,
    sandbox_mode: inspection.sandboxMode,
    probe: Object.freeze({
      configured: inspection.probeConfigured,
      schema: inspection.probeSchema,
      order_status: inspection.probeOrderStatus,
    }),
    limitations: inspection.limitations,
  });
}
