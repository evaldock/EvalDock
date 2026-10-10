/** 环境与 Probe 配置的结构校验，不含评分标准。 */
import { ContractViolation, assertDigestEquals, digestValue, validateContentDigest, validateStableId, validateVersionedAssetId, type JsonValue, type SourceRequirement, type SourceTrust } from "../core/models.js";
function asObject(value: unknown, field: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractViolation("INVALID_EXECUTION_INPUT", `${field} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

/** 把未知值收窄为 JSON 数组。 */
function asArray(value: unknown, field: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new ContractViolation("INVALID_EXECUTION_INPUT", `${field} must be an array`);
  }
  return value;
}

/** 读取必填非空字符串。 */
function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractViolation("INVALID_EXECUTION_INPUT", `${field} must be a non-empty string`);
  }
  return value;
}

/** 检查字段集合完全一致，避免拼错字段被静默忽略。 */
function assertExactFields(
  value: Record<string, JsonValue>,
  fields: readonly string[],
  label: string,
): void {
  const expected = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !expected.has(field)).sort();
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (unknown.length > 0 || missing.length > 0) {
    throw new ContractViolation(
      "INVALID_EXECUTION_INPUT_FIELDS",
      `${label} fields differ (unknown=${unknown.join(",") || "-"}, missing=${missing.join(",") || "-"})`,
    );
  }
}

/** 生成稳定、去重、排序后的只读字符串数组。 */
function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right, "en")));
}

/** 读取稳定且无重复的字符串数组。 */
function stringSet(value: unknown, field: string): readonly string[] {
  const values = asArray(value, field).map((item, index) => asString(item, `${field}[${index}]`));
  const canonical = sortedUnique(values);
  if (canonical.length !== values.length) {
    throw new ContractViolation("INVALID_EXECUTION_INPUT", `${field} must not contain duplicates`);
  }
  return canonical;
}

/** 验证 SourceRequirement，并确认能力摘要来自声明的能力集合。 */
export function parseSourceRequirement(value: unknown, field: string): SourceRequirement {
  const source = asObject(value, field);
  assertExactFields(source, [
    "sourceRequirementId",
    "sourceType",
    "sensorImplementationId",
    "sensorImplementationVersion",
    "sensorCapabilityDigest",
    "requiredCapabilities",
    "resourceBinding",
    "mandatory",
    "minimumTrust",
    "contentMode",
    "maxBytes",
    "timeoutMs",
    "watermarkDefinition",
  ], field);
  const capabilities = stringSet(source.requiredCapabilities, `${field}.requiredCapabilities`);
  const declaredDigest = validateContentDigest(source.sensorCapabilityDigest, `${field}.sensorCapabilityDigest`);
  assertDigestEquals(digestValue(capabilities), declaredDigest, "SENSOR_CAPABILITY_DIGEST_MISMATCH");
  const minimumTrust = asString(source.minimumTrust, `${field}.minimumTrust`);
  if (minimumTrust !== "INDEPENDENT" && minimumTrust !== "COOPERATIVE" && minimumTrust !== "UNVERIFIED") {
    throw new ContractViolation("INVALID_EXECUTION_INPUT", `${field}.minimumTrust is invalid`);
  }
  if (typeof source.mandatory !== "boolean") {
    throw new ContractViolation("INVALID_EXECUTION_INPUT", `${field}.mandatory must be a boolean`);
  }
  for (const numeric of ["maxBytes", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(source[numeric]) || Number(source[numeric]) <= 0) {
      throw new ContractViolation("INVALID_EXECUTION_INPUT", `${field}.${numeric} must be positive`);
    }
  }
  return Object.freeze({
    sourceRequirementId: validateVersionedAssetId<"SourceRequirementId">(source.sourceRequirementId, `${field}.sourceRequirementId`),
    sourceType: asString(source.sourceType, `${field}.sourceType`),
    sensorImplementationId: validateStableId<"SensorImplementationId">(source.sensorImplementationId, `${field}.sensorImplementationId`),
    sensorImplementationVersion: asString(source.sensorImplementationVersion, `${field}.sensorImplementationVersion`),
    sensorCapabilityDigest: declaredDigest,
    requiredCapabilities: capabilities,
    resourceBinding: asString(source.resourceBinding, `${field}.resourceBinding`),
    mandatory: source.mandatory,
    minimumTrust: minimumTrust as SourceTrust,
    contentMode: asString(source.contentMode, `${field}.contentMode`),
    maxBytes: Number(source.maxBytes),
    timeoutMs: Number(source.timeoutMs),
    watermarkDefinition: source.watermarkDefinition!,
  });
}

