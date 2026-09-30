/**
 * 文件功能：定义 EvalDock 中会被传递和保存的全部数据结构。
 *
 * 这里相当于全系统的数据字典，例如 Agent 快照、评测计划、Case、Attempt、Evidence、
 * 运行与采集记录分别有哪些字段。它也提供公共校验：ID 和路径是否合法、
 * 一条记录属于哪个 Run/Case/Attempt、状态是否按正确顺序变化，以及摘要是否匹配。
 *
 * 主要交互：planning 创建目标和计划数据；runtime、observation、evaluation 继续产生
 * 执行、证据和判定数据；storage 使用这里的引用和摘要保存它们；contracts 使用这里的
 * 类型规定模块接口。
 *
 * 阅读建议：不要从头到尾背类型。先从主流程找到一个对象，再回来查看它的字段定义。
 */
import { createHash } from "node:crypto";

import type { FailureDraft, FailureRecord } from "./errors.js";

/** 可以直接写入 JSON 的基本值。 */
export type JsonPrimitive = null | boolean | number | string;
/** EvalDock 允许计算摘要的 JSON 值。 */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
/** 只包含合法 JSON 值的对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** TypeScript 内部标记，用来防止把任意字符串误当成 EvalDock ID。 */
declare const stableIdBrand: unique symbol;
/** 普通对象 ID；类型参数用于区分 RunId、CaseId、AttemptId 等不同 ID。 */
export type StableId<Tag extends string = string> = string & {
  readonly [stableIdBrand]: Tag;
};
/** TypeScript 内部标记，用来识别带版本的数据集、标签和指标 ID。 */
declare const versionedAssetIdBrand: unique symbol;
/** 带版本的资源 ID，例如某个 Dataset 或 Label 的 `/v1` 版本。 */
export type VersionedAssetId<Tag extends string = string> = string & {
  readonly [versionedAssetIdBrand]: Tag;
};
/** 计划无法生成时，用来指出受影响对象或资源的 ID。 */
export type AssetIdentifier = StableId | VersionedAssetId;
/** 经过格式检查的时间字符串。 */
export type IsoDateTime = string;
/** 相对于评测工作区的安全路径，不允许绝对路径或 `..`。 */
export type PortablePath = string;

/** 被评测目标的稳定标识。 */
export type TargetId = StableId<"TargetId">;
/** 一次冻结目标快照的稳定标识。 */
export type TargetSnapshotId = StableId<"TargetSnapshotId">;
/** 一次评测运行的稳定标识。 */
export type RunId = StableId<"RunId">;
/** 运行内单个 Case 的稳定标识。 */
export type CaseId = StableId<"CaseId">;
/** Case 内单次执行尝试的稳定标识。 */
export type AttemptId = StableId<"AttemptId">;
/** 一次观察会话的稳定标识。 */
export type SessionId = StableId<"SessionId">;
/** 外部采集源单次运行的稳定标识。 */
export type SourceRunId = StableId<"SourceRunId">;
/** 已提交产物的稳定标识。 */
export type ArtifactId = StableId<"ArtifactId">;
/** Catalog 中 Dataset 的版本化标识。 */
export type DatasetId = VersionedAssetId<"DatasetId">;
/** 固定标签词表中 Label 的版本化标识。 */
export type LabelId = VersionedAssetId<"LabelId">;
/** Dataset 绑定环境定义的版本化标识。 */
export type EnvironmentDefinitionId = VersionedAssetId<"EnvironmentDefinitionId">;

/** 普通稳定 ID 的格式校验规则。 */
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** 版本化 Catalog 资产 ID 的格式校验规则。 */
const VERSIONED_ASSET_ID_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/v([1-9][0-9]*)$/u;
/** 小写十六进制 SHA-256 值的格式校验规则。 */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
/** V0.1 领域记录 schema 的格式校验规则。 */
const SCHEMA_PATTERN = /^evaldock\.(?:mvp\.)?[a-z0-9][a-z0-9-]*\/v1$/u;

/** 数据不符合上述规则时抛出的错误；上层会把它转换成结构化失败记录。 */
export class ContractViolation extends Error {
  public readonly code: string;

  /** 保存稳定错误码并保留原始 cause，供上层做结构化归类。 */
  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContractViolation";
    this.code = code;
  }
}

/** 检查普通 ID 格式，并把它标记为具体的 RunId、CaseId 等类型。 */
export function validateStableId<Tag extends string = string>(
  value: unknown,
  fieldName = "id",
): StableId<Tag> {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    throw new ContractViolation(
      "INVALID_STABLE_ID",
      `${fieldName} must contain 1-128 ASCII letters, digits, '.', '_' or '-' and start with a letter or digit`,
    );
  }
  return value as StableId<Tag>;
}

/** 检查 Dataset、Label 等资源 ID 是否包含合法版本号。 */
export function validateVersionedAssetId<Tag extends string = string>(
  value: unknown,
  fieldName = "assetId",
): VersionedAssetId<Tag> {
  if (typeof value !== "string" || !VERSIONED_ASSET_ID_PATTERN.test(value)) {
    throw new ContractViolation(
      "INVALID_VERSIONED_ASSET_ID",
      `${fieldName} must be a strict StableId base followed by '/v' and a positive decimal major version`,
    );
  }
  return value as VersionedAssetId<Tag>;
}

/** 检查一条记录声明的数据格式版本是否合法。 */
export function validateSchemaId(value: unknown, fieldName = "schema"): string {
  if (typeof value !== "string" || !SCHEMA_PATTERN.test(value)) {
    throw new ContractViolation(
      "INVALID_SCHEMA",
      `${fieldName} must be a evaldock.<name>/v1 schema`,
    );
  }
  return value;
}

/** 检查时间字段能否被正确解析。 */
export function validateIsoDateTime(value: unknown, fieldName = "time"): IsoDateTime {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ContractViolation("INVALID_TIME", `${fieldName} must be an ISO-8601 timestamp`);
  }
  return value;
}

/**
 * 检查数据集提供的工作区路径是否安全。
 * 绝对路径、`..`、通配符和变量表达式都不允许进入执行与观测流程。
 */
export function validatePortablePath(
  value: unknown,
  fieldName = "portablePath",
  options: { readonly allowDot?: boolean } = {},
): PortablePath {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new ContractViolation("INVALID_PORTABLE_PATH", `${fieldName} must be a non-empty path`);
  }
  if (value === "." && options.allowDot === true) {
    return value;
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.includes("\\") ||
    /[*?\[\]{}]/u.test(value) ||
    /\$\{|%[^%]+%/u.test(value)
  ) {
    throw new ContractViolation(
      "INVALID_PORTABLE_PATH",
      `${fieldName} must be a literal, relative POSIX path without glob or variable syntax`,
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ContractViolation(
      "INVALID_PORTABLE_PATH",
      `${fieldName} must not contain empty, '.' or '..' segments`,
    );
  }
  return value;
}

/** 检查字符串是否包含无法正确编码的 Unicode 字符。 */
function assertValidUnicode(value: string, location: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ContractViolation("INVALID_JSON", `${location} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ContractViolation("INVALID_JSON", `${location} contains an unpaired surrogate`);
    }
  }
}

/** 递归生成字段顺序稳定的 JSON 字符串，供摘要计算使用。 */
function canonicalizeValue(value: unknown, ancestors: Set<object>, location: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertValidUnicode(value, location);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ContractViolation("INVALID_JSON", `${location} contains a non-finite number`);
    }
    return JSON.stringify(value);
  }
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new ContractViolation("INVALID_JSON", `${location} is not a JSON value`);
  }
  if (typeof value !== "object") {
    throw new ContractViolation("INVALID_JSON", `${location} is not a JSON value`);
  }
  if (ancestors.has(value)) {
    throw new ContractViolation("INVALID_JSON", `${location} contains a cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new ContractViolation("INVALID_JSON", `${location}[${index}] is an array hole`);
        }
        items.push(canonicalizeValue(value[index], ancestors, `${location}[${index}]`));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ContractViolation("INVALID_JSON", `${location} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ContractViolation("INVALID_JSON", `${location} contains symbol keys`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const fields = keys.map((key) => {
      assertValidUnicode(key, `${location} key`);
      return `${JSON.stringify(key)}:${canonicalizeValue(record[key], ancestors, `${location}.${key}`)}`;
    });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** 把同样的数据稳定地序列化成同样的字符串，避免字段顺序影响摘要。 */
export function canonicalize(value: unknown): string {
  return canonicalizeValue(value, new Set<object>(), "$");
}

/** `canonicalize` 的同义入口，用在调用方需要明确表达“生成规范 JSON”时。 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

/** SHA-256 值及其输入字节长度，所有不可变记录和产物用它绑定内容。 */
export interface ContentDigest {
  readonly algorithm: "sha256";
  readonly value: string;
  readonly byteLength: number;
}

/** 校验外部摘要对象的算法、十六进制值和字节长度。 */
export function validateContentDigest(value: unknown, fieldName = "digest"): ContentDigest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractViolation("INVALID_DIGEST", `${fieldName} must be an object`);
  }
  const digest = value as Partial<ContentDigest>;
  if (
    digest.algorithm !== "sha256" ||
    typeof digest.value !== "string" ||
    !DIGEST_PATTERN.test(digest.value) ||
    !Number.isSafeInteger(digest.byteLength) ||
    (digest.byteLength ?? -1) < 0
  ) {
    throw new ContractViolation("INVALID_DIGEST", `${fieldName} is not a valid SHA-256 digest`);
  }
  return digest as ContentDigest;
}

/** 对 UTF-8 字符串或原始字节计算带长度的 SHA-256 摘要。 */
export function digestBytes(bytes: Uint8Array | string): ContentDigest {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return Object.freeze({
    algorithm: "sha256" as const,
    value: createHash("sha256").update(buffer).digest("hex"),
    byteLength: buffer.byteLength,
  });
}

/** 规范序列化 JSON 值后计算摘要，可排除顶层存储型字段以验证自描述记录。 */
export function digestValue(
  value: unknown,
  excludedTopLevelFields: readonly string[] = [],
): ContentDigest {
  let digestInput = value;
  if (
    excludedTopLevelFields.length > 0 &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const source = value as Record<string, unknown>;
    digestInput = Object.fromEntries(
      Object.entries(source).filter(([key]) => !excludedTopLevelFields.includes(key)),
    );
  }
  return digestBytes(canonicalize(digestInput));
}

/** 为尚无 contentDigest 的不可变对象计算摘要并冻结结果。 */
export function withContentDigest<T extends object>(
  value: T,
): Readonly<T & { readonly contentDigest: ContentDigest }> {
  if (Object.prototype.hasOwnProperty.call(value, "contentDigest")) {
    throw new ContractViolation(
      "DIGEST_FIELD_PRESENT",
      "withContentDigest expects a record without contentDigest",
    );
  }
  return Object.freeze({ ...value, contentDigest: digestValue(value) });
}

/** 比较两个摘要的算法、值与字节长度。 */
export function digestEquals(left: ContentDigest, right: ContentDigest): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.value === right.value &&
    left.byteLength === right.byteLength
  );
}

/** 验证两个摘要完全一致；存储、规划和观察层用它守住内容绑定。 */
export function assertDigestEquals(
  actual: ContentDigest,
  expected: ContentDigest,
  code = "EVIDENCE_INTEGRITY",
): void {
  validateContentDigest(actual, "actual digest");
  validateContentDigest(expected, "expected digest");
  if (!digestEquals(actual, expected)) {
    throw new ContractViolation(code, "content digest does not match the committed digest");
  }
}

/** 由目标逐层细化到观察会话的层级作用域引用。 */
export interface ScopeRef {
  readonly targetId: TargetId;
  readonly targetSnapshotId?: TargetSnapshotId;
  readonly runId?: RunId;
  readonly caseId?: CaseId;
  readonly attemptId?: AttemptId;
  readonly sessionId?: SessionId;
}

/** ScopeRef 允许出现的字段注册表，validateScope 和作用域比较共用。 */
const SCOPE_FIELDS = new Set([
  "targetId",
  "targetSnapshotId",
  "runId",
  "caseId",
  "attemptId",
  "sessionId",
]);

/** 校验作用域字段集合、各级 ID 及父子层级完整性。 */
export function validateScope(value: unknown, fieldName = "scope"): Readonly<ScopeRef> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractViolation("INVALID_SCOPE", `${fieldName} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const unknownFields = Object.keys(raw).filter((key) => !SCOPE_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new ContractViolation(
      "INVALID_SCOPE",
      `${fieldName} contains unknown fields: ${unknownFields.sort().join(", ")}`,
    );
  }
  const targetId = validateStableId<"TargetId">(raw.targetId, `${fieldName}.targetId`);
  const result: ScopeRef = { targetId };
  const order = ["targetSnapshotId", "runId", "caseId", "attemptId"] as const;
  let parentPresent = true;
  for (const key of order) {
    const current = raw[key];
    if (current === undefined) {
      parentPresent = false;
      continue;
    }
    if (!parentPresent) {
      throw new ContractViolation(
        "INVALID_SCOPE",
        `${fieldName}.${key} cannot exist without every parent scope field`,
      );
    }
    Object.assign(result, { [key]: validateStableId(current, `${fieldName}.${key}`) });
  }
  if (raw.sessionId !== undefined) {
    if (result.attemptId === undefined) {
      throw new ContractViolation(
        "INVALID_SCOPE",
        `${fieldName}.sessionId requires an attemptId and every parent field`,
      );
    }
    Object.assign(result, {
      sessionId: validateStableId<"SessionId">(raw.sessionId, `${fieldName}.sessionId`),
    });
  }
  return Object.freeze(result);
}

/** 要求两个完整作用域逐字段相同；跨记录关联校验时调用。 */
export function assertSameScope(left: ScopeRef, right: ScopeRef): void {
  const a = validateScope(left, "left scope");
  const b = validateScope(right, "right scope");
  for (const key of SCOPE_FIELDS) {
    if (a[key as keyof ScopeRef] !== b[key as keyof ScopeRef]) {
      throw new ContractViolation("SCOPE_MISMATCH", `scope field ${key} does not match`);
    }
  }
}

/** 要求多个作用域均到达同一个 attempt 层级；Observation 与 Evaluation 组合证据时调用。 */
export function assertSameAttemptScope(...scopes: readonly ScopeRef[]): void {
  if (scopes.length < 2) return;
  const validated = scopes.map((scope, index) => validateScope(scope, `scope[${index}]`));
  for (const [index, scope] of validated.entries()) {
    if (scope.attemptId === undefined) {
      throw new ContractViolation(
        "INVALID_SCOPE",
        `scope[${index}] must include target, snapshot, run, case and attempt`,
      );
    }
  }
  const expected = validated[0];
  if (expected === undefined) return;
  const attemptFields = ["targetId", "targetSnapshotId", "runId", "caseId", "attemptId"] as const;
  for (const scope of validated.slice(1)) {
    for (const field of attemptFields) {
      if (scope[field] !== expected[field]) {
        throw new ContractViolation("SCOPE_MISMATCH", `attempt scope field ${field} does not match`);
      }
    }
  }
}

/** 指向不可变记录或生命周期投影的摘要引用，泛型只表达被引用类型。 */
export interface Ref<T = unknown> {
  readonly schema: string;
  readonly id: StableId;
  readonly digest: ContentDigest;
  readonly revision?: number;
  // T 只参与静态类型标记，序列化后的 Ref 仍只有上面的实际字段。
  readonly __referent?: T;
}

/** 校验普通或生命周期 Ref 的字段白名单、ID、摘要及 revision 规则。 */
export function validateRef<T>(
  value: unknown,
  options: { readonly lifecycle?: boolean; readonly fieldName?: string } = {},
): Readonly<Ref<T>> {
  const fieldName = options.fieldName ?? "ref";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractViolation("INVALID_REF", `${fieldName} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["schema", "id", "digest", "revision"]);
  const unknownFields = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknownFields.length > 0) {
    throw new ContractViolation(
      "INVALID_REF",
      `${fieldName} contains unknown fields: ${unknownFields.sort().join(", ")}`,
    );
  }
  const schema = validateSchemaId(raw.schema, `${fieldName}.schema`);
  const id = validateStableId(raw.id, `${fieldName}.id`);
  const digest = validateContentDigest(raw.digest, `${fieldName}.digest`);
  if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0)) {
    throw new ContractViolation("INVALID_REF", `${fieldName}.revision must be a non-negative integer`);
  }
  if (options.lifecycle === true && raw.revision === undefined) {
    throw new ContractViolation("INVALID_REF", `${fieldName}.revision is required for lifecycle data`);
  }
  if (options.lifecycle !== true && raw.revision !== undefined) {
    throw new ContractViolation("INVALID_REF", `${fieldName}.revision is only valid for lifecycle data`);
  }
  const ref: Ref<T> =
    raw.revision === undefined
      ? { schema, id, digest }
      : { schema, id, digest, revision: raw.revision as number };
  return Object.freeze(ref);
}

/** 采集源的墙钟、单调时钟和序列位置，用于证据时间边界判断。 */
export interface SourceTime {
  readonly wallTime?: IsoDateTime | undefined;
  readonly monotonicNs?: number | undefined;
  readonly sourceSeq?: number | undefined;
  readonly observedAt: IsoDateTime;
  readonly clockDomain: string;
}

/** 运行基础设施的健康状态，与业务检查结论分开表达。 */
export type OperationalHealth = "HEALTHY" | "DEGRADED" | "FAILED";
/** 证据或采集结果是否完整。 */
export type EvidenceCompleteness = "COMPLETE" | "PARTIAL";
/** 证据源相对目标的信任等级。 */
export type SourceTrust = "INDEPENDENT" | "COOPERATIVE" | "UNVERIFIED";

/** 所有内容寻址不可变领域记录共享的作用域、时间、版本和摘要字段。 */
export interface ImmutableRecordBase {
  readonly schema: string;
  readonly scope: ScopeRef;
  readonly createdAt: IsoDateTime;
  readonly producerVersion: string;
  readonly contentDigest: ContentDigest;
}

/** ArtifactStore 提交成功后返回的不可变产物元数据引用。 */
export interface ArtifactRef extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.artifact/v1";
  readonly artifactId: ArtifactId;
  readonly artifactType: string;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly portablePath: PortablePath;
  readonly byteLength: number;
  readonly artifactContentDigest: ContentDigest;
  readonly sensitivity: "EXPORTABLE" | "RESTRICTED";
  readonly redactionState: "NOT_REQUIRED" | "APPLIED" | "FAILED";
  readonly state: "COMMITTED";
}

/** ArtifactStore 校验读取的授权用途分类。 */
export type ArtifactReadPurpose =
  | "TASK_INPUT"
  | "INSPECTION"
  | "EVIDENCE_CAPTURE"
  | "JUDGE_INPUT"
  | "REPORT_INPUT";

/** 冻结目标时记录的 Headless Driver 能力、版本和执行语义指纹。 */
export interface DriverFingerprint {
  readonly driverCapabilityId: StableId;
  readonly dshEntrypointDigest: ContentDigest;
  readonly dshPackageVersion?: string;
  readonly headlessBundleVersion: string;
  readonly headlessBundleDigest: ContentDigest;
  readonly cliGrammarId: StableId;
  readonly cancelSupported: boolean;
  readonly stdoutSemantics: string;
  readonly stderrSemantics: string;
  readonly exitSemantics: string;
  readonly workspaceSemantics: string;
  readonly profileMutationSemantics: string;
}

/** 用户提供并带摘要的 FULL_AGENT 目标描述，`planning/target.ts` 负责校验和冻结。 */
export interface TargetDescriptor {
  readonly schema: "evaldock.mvp.target-descriptor/v1";
  readonly targetId: TargetId;
  readonly targetType: "FULL_AGENT";
  readonly sourceRoot: string;
  readonly dshExecutable: string;
  readonly dshHome: string;
  /** Existing local DSH Web service; never substitutes a Headless profile. */
  readonly webEndpoint?: string;
  readonly profile: string;
  readonly targetIdentity: string;
  readonly contentDigest: ContentDigest;
}

/** Planner 相关源码、当前 Profile、入口、配置和运行驱动被内容寻址冻结后的轻量快照。 */
export interface TargetSnapshot extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.target-snapshot/v1";
  readonly targetSnapshotId: TargetSnapshotId;
  readonly targetId: TargetId;
  readonly sourceManifestRef: Ref<ArtifactRef>;
  readonly dshExecutablePath: string;
  readonly dshPackageVersion?: string;
  readonly dshEntrypointDigest: ContentDigest;
  readonly dshHomeManifestRef: Ref<ArtifactRef>;
  readonly profile: string;
  readonly profileManifestRef: Ref<ArtifactRef>;
  readonly lockfileRef: Ref<ArtifactRef>;
  readonly effectiveConfigRef: Ref<ArtifactRef>;
  readonly driverFingerprint: DriverFingerprint;
  readonly platform: JsonObject;
  readonly secretRefNames: readonly string[];
}

/** Inspector 从 TargetSnapshot 已提交产物归一化出的规划事实。 */
export interface InspectionSnapshot extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.inspection/v1";
  readonly inspectionId: StableId<"InspectionId">;
  readonly targetSnapshotRef: Ref<TargetSnapshot>;
  readonly dshVersionStatus: JsonValue;
  readonly profile: JsonValue;
  /** Profile bundle 元数据，包含描述、版本、来源及相对原生 DSH 的角色。 */
  readonly pluginCatalog: readonly JsonValue[];
  readonly probeConfigured: boolean | "UNKNOWN";
  readonly probeSchema: string;
  readonly probeOrderStatus: string;
  readonly headlessDriverStatus: string;
  /** 当前有效工具的描述、实现包及 NATIVE/ADDED 分类。 */
  readonly toolSchemas: readonly JsonValue[];
  /** 以同版本 dsh-base 为基线计算的工具增量与缺失项。 */
  readonly toolDelta: JsonObject;
  readonly permissionPreset: string;
  readonly sandboxMode: string;
  readonly limitations: readonly JsonValue[];
  readonly sourceArtifactRefs: readonly Ref<ArtifactRef>[];
}

/** Environment Observer 或 Agent Trace 对单个采集实现、资源、信任与预算的要求。 */
export interface SourceRequirement {
  readonly sourceRequirementId: VersionedAssetId<"SourceRequirementId">;
  /** 采集源类型，例如 DSH_PROBE、FILESYSTEM、DATABASE；由对应注册表解释。 */
  readonly sourceType: string;
  readonly sensorImplementationId: StableId<"SensorImplementationId">;
  readonly sensorImplementationVersion: string;
  readonly sensorCapabilityDigest: ContentDigest;
  /** 本次环境配置实际要求 Adapter 提供的能力集合。 */
  readonly requiredCapabilities?: readonly string[];
  readonly resourceBinding: string;
  readonly mandatory: boolean;
  readonly minimumTrust: SourceTrust;
  readonly contentMode: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly watermarkDefinition: JsonValue;
}

/** Case 与环境配置的冻结执行输入，不含标签评分逻辑。 */
export interface CaseExecutionInput {
  readonly schema: "evaldock.case-execution-input/v1";
  readonly inputId: StableId<"CaseExecutionInputId">;
  readonly datasetId: DatasetId;
  readonly caseDigest: ContentDigest;
  readonly labelIds: readonly LabelId[];
  readonly scenario: JsonObject;
  readonly environment: JsonObject;
  readonly runtimeSourceRequirementId: VersionedAssetId<"SourceRequirementId">;
  readonly environmentObserverSourceRequirementId: VersionedAssetId<"SourceRequirementId">;
  readonly sourceRequirements: readonly SourceRequirement[];
  readonly contentDigest: ContentDigest;
}

/** 应用启动时冻结的路径、预算、安全级别和版本配置。 */
export interface ConfigSnapshot {
  readonly schema: "evaldock.mvp.config/v1";
  readonly configId: StableId<"ConfigId">;
  readonly invocationId: StableId<"InvocationId">;
  readonly targetRoot: string;
  readonly runRoot: string;
  readonly artifactRoot: string;
  readonly reportRoot: string;
  readonly resultRoot: string;
  readonly workspaceRoot: string;
  readonly runtimeDshHomeRoot: string;
  readonly runDeadlineMs: number;
  readonly caseDeadlineMs: number;
  readonly stableWindowMs: number;
  readonly stableMaxWaitMs: number;
  readonly maxArtifactBytes: number;
  readonly contentMode: string;
  readonly allowedModelEndpoints: readonly string[];
  readonly minimumIsolationLevel: "AGENT_SEPARATED" | "SESSION_SEPARATED";
  readonly rendererVersion: string;
  readonly fieldSources: JsonObject;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly evaldockVersion: string;
  readonly secretRefNames: readonly string[];
  readonly createdAt: IsoDateTime;
  readonly contentDigest: ContentDigest;
}

/** EvaluationPlan 内唯一 Case 的任务、环境、路径和检查执行参数。 */
export interface CasePlan {
  readonly casePlanId: StableId<"CasePlanId">;
  readonly order: 1;
  readonly scenarioId: VersionedAssetId<"ScenarioId">;
  readonly datasetId: DatasetId;
  readonly labelIds: readonly LabelId[];
  readonly environmentId: VersionedAssetId<"EnvironmentDefinitionId">;
  readonly environmentObserverSourceRequirementId: VersionedAssetId<"SourceRequirementId">;
  readonly runtimeSourceRequirementId: VersionedAssetId<"SourceRequirementId">;
  readonly agentTaskArtifactRef: Ref<ArtifactRef>;
  readonly visibleInputArtifactRefs: readonly Ref<ArtifactRef>[];
  readonly seedSpec: JsonObject;
  readonly allowedPaths: readonly PortablePath[];
  readonly forbiddenPaths: readonly PortablePath[];
  readonly deadlineMs: number;
  readonly stableWindowMs: number;
  readonly maxAttempts: 1;
}

/** Planner 输出的评测总计划，绑定目标、Catalog 解析、Case、Checks 与预算。 */
export interface EvaluationPlan extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.evaluation-plan/v1";
  readonly evaluationPlanId: StableId<"EvaluationPlanId">;
  readonly targetSnapshotRef: Ref<TargetSnapshot>;
  readonly inspectionRef: Ref<InspectionSnapshot>;
  readonly inputRef: Ref<CaseExecutionInput>;
  readonly casePlan: CasePlan;
  readonly budget: JsonValue;
  readonly exclusions: readonly JsonValue[];
  readonly semanticDigest: ContentDigest;
  readonly status: "FROZEN";
}

/** Environment Observer 执行的环境采集源、边界、稳定窗口与内容策略。 */
export interface ObservationPlan extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.observation-plan/v1";
  readonly observationPlanId: StableId<"ObservationPlanId">;
  readonly evaluationPlanRef: Ref<EvaluationPlan>;
  readonly casePlanId: StableId<"CasePlanId">;
  readonly sourceRequirements: readonly SourceRequirement[];
  readonly boundaryPolicy: JsonValue;
  readonly stablePolicy: JsonValue;
  readonly contentPolicy: JsonValue;
  readonly semanticDigest: ContentDigest;
}

/** Agent 执行期间的 Trace 采集源、生命周期边界与内容策略。 */
export interface AgentTracePlan extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.agent-trace-plan/v1";
  readonly agentTracePlanId: StableId<"AgentTracePlanId">;
  readonly evaluationPlanRef: Ref<EvaluationPlan>;
  readonly casePlanId: StableId<"CasePlanId">;
  readonly sourceRequirements: readonly SourceRequirement[];
  readonly lifecyclePolicy: JsonValue;
  readonly contentPolicy: JsonValue;
  readonly semanticDigest: ContentDigest;
}

/** 规划输入无法满足时返回的稳定、已脱敏诊断项。 */
export interface PlanGap {
  readonly code: string;
  readonly messageRedacted: string;
  readonly affectedIds: readonly AssetIdentifier[];
}

/** Planner 的业务结果：完整冻结计划或一组不可满足缺口。 */
export type PlanBuildResult =
  | {
      readonly status: "FROZEN";
      readonly evaluationPlan: EvaluationPlan;
      readonly agentTracePlan: AgentTracePlan;
      readonly observationPlan: ObservationPlan;
    }
  | {
      readonly status: "UNSATISFIABLE";
      readonly gaps: readonly PlanGap[];
      readonly failureDrafts: readonly FailureDraft[];
    };

/** Sensor 注册表条目；Planner 用三元版本与能力摘要匹配 SourceRequirement。 */
export interface SensorAdapterDescriptor {
  readonly implementationId: StableId<"SensorImplementationId">;
  readonly implementationVersion: string;
  readonly capabilityDigest: ContentDigest;
  readonly sourceType: string;
  readonly capabilities: readonly string[];
}

/** EvaluationRun 生命周期状态。 */
export type RunState =
  | "CREATED"
  | "PREFLIGHTING"
  | "RUNNING"
  | "FINALIZING"
  | "FINISHED"
  | "FAILED"
  | "CANCELLED";
/** EvaluationCase 生命周期状态。 */
export type CaseState = "PENDING" | "RUNNING" | "EVALUATING" | "FINISHED" | "ERRORED" | "ABORTED";
/** ExecutionAttempt 生命周期及目标、超时、环境和 Harness 终态。 */
export type AttemptState =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "TARGET_FAILED"
  | "TIMED_OUT"
  | "HARNESS_ERROR"
  | "ENVIRONMENT_ERROR"
  | "CANCELLED";
/** EnvironmentInstance 从创建到清理或隔离的生命周期状态。 */
export type EnvironmentState =
  | "CREATED"
  | "PREPARED"
  | "SEEDED"
  | "IN_USE"
  | "RESETTING"
  | "VERIFIED"
  | "CLEANED"
  | "QUARANTINED"
  | "CLEANUP_FAILED";
/** ObservationSession 从计划到封存的生命周期状态。 */
export type ObservationSessionState =
  | "PLANNED"
  | "BASELINING"
  | "BASELINED"
  | "ACTIVE"
  | "DRAINING"
  | "SEALED"
  | "FAILED";
/** 所有生命周期投影状态的联合。 */
export type LifecycleState =
  | RunState
  | CaseState
  | AttemptState
  | EnvironmentState
  | ObservationSessionState;

/** 受状态机约束的生命周期聚合 schema 联合。 */
export type LifecycleAggregateSchema =
  | "evaldock.mvp.run/v1"
  | "evaldock.mvp.case/v1"
  | "evaldock.mvp.attempt/v1"
  | "evaldock.mvp.environment/v1"
  | "evaldock.mvp.observation-session/v1";

/** 各生命周期聚合的合法后继状态注册表，由仓储提交状态迁移时校验。 */
const LEGAL_TRANSITIONS: Readonly<Record<LifecycleAggregateSchema, Readonly<Record<string, readonly string[]>>>> = {
  "evaldock.mvp.run/v1": {
    CREATED: ["PREFLIGHTING", "FAILED", "CANCELLED"],
    PREFLIGHTING: ["RUNNING", "FAILED", "CANCELLED"],
    RUNNING: ["FINALIZING", "FAILED", "CANCELLED"],
    FINALIZING: ["FINISHED", "FAILED", "CANCELLED"],
    FINISHED: [],
    FAILED: [],
    CANCELLED: [],
  },
  "evaldock.mvp.case/v1": {
    PENDING: ["RUNNING"],
    RUNNING: ["EVALUATING", "ERRORED", "ABORTED"],
    EVALUATING: ["FINISHED", "ERRORED", "ABORTED"],
    FINISHED: [],
    ERRORED: [],
    ABORTED: [],
  },
  "evaldock.mvp.attempt/v1": {
    PENDING: ["RUNNING"],
    RUNNING: [
      "SUCCEEDED",
      "TARGET_FAILED",
      "TIMED_OUT",
      "HARNESS_ERROR",
      "ENVIRONMENT_ERROR",
      "CANCELLED",
    ],
    SUCCEEDED: [],
    TARGET_FAILED: [],
    TIMED_OUT: [],
    HARNESS_ERROR: [],
    ENVIRONMENT_ERROR: [],
    CANCELLED: [],
  },
  "evaldock.mvp.environment/v1": {
    CREATED: ["PREPARED", "QUARANTINED", "CLEANUP_FAILED"],
    PREPARED: ["SEEDED", "QUARANTINED", "CLEANUP_FAILED"],
    SEEDED: ["IN_USE", "RESETTING", "QUARANTINED", "CLEANUP_FAILED"],
    IN_USE: ["RESETTING", "QUARANTINED", "CLEANUP_FAILED"],
    RESETTING: ["VERIFIED", "QUARANTINED", "CLEANUP_FAILED"],
    VERIFIED: ["CLEANED", "QUARANTINED", "CLEANUP_FAILED"],
    CLEANED: [],
    QUARANTINED: [],
    CLEANUP_FAILED: [],
  },
  "evaldock.mvp.observation-session/v1": {
    PLANNED: ["BASELINING", "FAILED"],
    BASELINING: ["BASELINED", "FAILED"],
    BASELINED: ["ACTIVE", "FAILED"],
    ACTIVE: ["DRAINING", "FAILED"],
    DRAINING: ["SEALED", "FAILED"],
    SEALED: [],
    FAILED: [],
  },
};

/** 判断 schema 是否属于受控生命周期聚合；仓储验证外部投影时调用。 */
export function isLifecycleSchema(schema: string): schema is LifecycleAggregateSchema {
  return Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, schema);
}

/** 根据 LEGAL_TRANSITIONS 拒绝非法状态迁移；RepositoryPort 实现提交 transition 前调用。 */
export function assertLegalTransition(
  schema: LifecycleAggregateSchema,
  fromState: string,
  toState: string,
): void {
  const nextStates = LEGAL_TRANSITIONS[schema][fromState];
  if (nextStates === undefined || !nextStates.includes(toState)) {
    throw new ContractViolation(
      "ILLEGAL_STATE_TRANSITION",
      `${schema} cannot transition from ${fromState} to ${toState}`,
    );
  }
}

/** 所有可变生命周期投影共享的聚合身份、状态、revision 和失败引用。 */
export interface LifecycleProjectionBase<State extends LifecycleState = LifecycleState> {
  readonly schema: LifecycleAggregateSchema;
  readonly aggregateId: StableId;
  readonly scope: ScopeRef;
  readonly state: State;
  readonly revision: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly failureRefs: readonly Ref<FailureRecord>[];
  readonly projectionDigest: ContentDigest;
}

/** 一次评测运行的顶层投影，串联计划、Case 与环境终态。 */
export interface EvaluationRun extends LifecycleProjectionBase<RunState> {
  readonly schema: "evaldock.mvp.run/v1";
  readonly runId: RunId;
  readonly targetSnapshotRef: Ref<TargetSnapshot>;
  readonly evaluationPlanRef: Ref<EvaluationPlan>;
  readonly observationPlanRef: Ref<ObservationPlan>;
  readonly caseId: CaseId;
  readonly operationalHealth: OperationalHealth;
  readonly environmentFinalState?: EnvironmentState;
}

/** 运行内唯一 Case 的生命周期投影及其 Attempt、标签评分关联。 */
export interface EvaluationCase extends LifecycleProjectionBase<CaseState> {
  readonly schema: "evaldock.mvp.case/v1";
  readonly caseId: CaseId;
  readonly runId: RunId;
  readonly casePlanId: StableId<"CasePlanId">;
  readonly attemptId: AttemptId;
  readonly scoreRefs: readonly Ref[];
}

/** 目标进程一次执行尝试的生命周期、工作路径、采集运行 ID 和输出产物。 */
export interface ExecutionAttempt extends LifecycleProjectionBase<AttemptState> {
  readonly schema: "evaldock.mvp.attempt/v1";
  readonly attemptId: AttemptId;
  readonly caseId: CaseId;
  readonly ordinal: 1;
  readonly workspacePath: string;
  readonly runtimeDshHomePath: string;
  readonly sourceRunId: SourceRunId;
  readonly startedAt?: IsoDateTime;
  readonly endedAt?: IsoDateTime;
  readonly terminationKind?: string;
  readonly stdoutArtifactRef?: Ref<ArtifactRef>;
  readonly stderrArtifactRef?: Ref<ArtifactRef>;
}

/** 每次 Attempt 对应的隔离环境实例、重置代次与快照引用。 */
export interface EnvironmentInstance extends LifecycleProjectionBase<EnvironmentState> {
  readonly schema: "evaldock.mvp.environment/v1";
  readonly environmentInstanceId: StableId<"EnvironmentInstanceId">;
  readonly attemptId: AttemptId;
  readonly environmentId: VersionedAssetId<"EnvironmentDefinitionId">;
  readonly workspaceBinding: string;
  readonly resetGeneration: number;
  readonly seedManifestRef?: Ref<SeedManifest>;
  readonly baselineSnapshotRef?: Ref<FileSnapshot>;
}

/** 对目标或环境控制动作的不可变审计记录。 */
export interface ControlEvent extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.control-event/v1";
  readonly controlEventId: StableId<"ControlEventId">;
  readonly operation:
    | "TARGET_START"
    | "TARGET_STOP"
    | "ENV_PREPARE"
    | "ENV_SEED"
    | "ENV_RESET"
    | "ENV_CLEANUP";
  readonly startedAt: IsoDateTime;
  readonly endedAt: IsoDateTime;
  readonly result: "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly failureRefs: readonly Ref<FailureRecord>[];
}

/** SeedManifest 中单个文件系统资源的路径、类型、摘要和目标权限。 */
export interface ResourceEntry {
  readonly portablePath: PortablePath;
  readonly entryType: "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER";
  readonly contentDigest?: ContentDigest;
  readonly mode: number;
  readonly readOnlyForTarget: boolean;
}

/** 环境播种完成后的资源清单，供执行与重置验证绑定初始状态。 */
export interface SeedManifest extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.seed-manifest/v1";
  readonly seedManifestId: StableId<"SeedManifestId">;
  readonly environmentInstanceRef: Ref<EnvironmentInstance>;
  readonly resetGeneration: number;
  readonly resourceEntries: readonly ResourceEntry[];
  readonly completedAt: IsoDateTime;
}

/** Run 启动前身份、根目录、网络、遥测和 Probe 顺序的安全检查记录。 */
export interface SecurityPreflight extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.security-preflight/v1";
  readonly preflightId: StableId<"SecurityPreflightId">;
  readonly runId: RunId;
  readonly targetIdentity: string;
  readonly observerIdentity: string;
  readonly judgeIdentity: string;
  readonly allowedRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly networkPolicyDigest: ContentDigest;
  readonly telemetryDisabled: boolean;
  readonly probeOrderValid: boolean;
  readonly status: "PASSED" | "FAILED";
  readonly failureRefs: readonly Ref<FailureRecord>[];
}

/** 环境重置后干净状态与采集完整性的验证记录。 */
export interface ResetVerification extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.reset-verification/v1";
  readonly verificationId: StableId<"ResetVerificationId">;
  readonly environmentInstanceRef: Ref<EnvironmentInstance>;
  readonly resetGeneration: number;
  readonly expectedCleanDigest: ContentDigest;
  readonly postResetSnapshotRef: Ref<FileSnapshot>;
  readonly collectionStatusRef: Ref<CollectionStatus>;
  readonly result: "MATCH" | "MISMATCH" | "UNAVAILABLE";
  readonly differenceSummary: JsonValue;
}

/** VM 全局执行槽租约，运行时用它避免并发污染共享环境。 */
export interface LeaseRecord extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.lease/v1";
  readonly leaseId: StableId<"LeaseId">;
  readonly runId: RunId;
  readonly slotId: "vm-global";
  readonly state: "ACTIVE" | "RELEASED";
  readonly ownerPid: number;
  readonly ownerProcessStartToken: string;
  readonly acquiredAt: IsoDateTime;
  readonly releasedAt?: IsoDateTime;
}

/** 已实例化采集源的实现、能力、信任、资源和已知盲区描述。 */
export interface SourceDescriptor extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.source/v1";
  readonly sourceId: StableId<"SourceId">;
  readonly sourceType: string;
  readonly externalSchema: string;
  readonly collectorName: string;
  readonly collectorVersion: string;
  readonly collectorCapabilityDigest: ContentDigest;
  readonly trust: SourceTrust;
  readonly resourceBinding: string;
  readonly sequenceMode: string;
  readonly watermarkDefinition: JsonValue;
  readonly contentMode: string;
  readonly knownBlindSpots: readonly string[];
}

/** 采集序列中缺口或无法确认区间的结构化说明。 */
export interface CollectionGap {
  readonly kind: string;
  readonly firstMissingSeq?: number;
  readonly lastMissingSeq?: number;
  readonly reasonCode: string;
  readonly detail?: JsonValue;
}

/** 单个 Source 关闭后的数量、水位、缺口、截断和健康汇总。 */
export interface CollectionStatus extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.collection-status/v1";
  readonly collectionStatusId: StableId<"CollectionStatusId">;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly openedAt: IsoDateTime;
  readonly closedAt: IsoDateTime;
  readonly recordCount: number;
  readonly firstSourceSeq?: number;
  readonly lastSourceSeq?: number;
  readonly finalWatermark?: JsonValue;
  readonly gaps: readonly CollectionGap[];
  readonly truncated: boolean;
  readonly health: OperationalHealth;
  readonly completeness: EvidenceCompleteness;
  readonly failureRefs: readonly Ref<FailureRecord>[];
}

/** Observation 封存前必须闭合的一项完成条件及其支持引用。 */
export interface CompletionLedgerItem {
  readonly kind:
    | "TARGET_TERMINATION"
    | "TOOL_CALLS"
    | "SESSION_FLUSH"
    | "PROBE_WATERMARK"
    | "STABLE_WINDOW"
    | "FINAL_FILE_SNAPSHOT";
  readonly required: boolean;
  readonly status: "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "FAILED";
  readonly reasonCodes: readonly string[];
  readonly supportingRefs: readonly Ref[];
}

/** 固定六项的 Observation 完成账本，Coordinator 据此决定能否封存证据。 */
export type CompletionLedger = readonly [
  CompletionLedgerItem,
  CompletionLedgerItem,
  CompletionLedgerItem,
  CompletionLedgerItem,
  CompletionLedgerItem,
  CompletionLedgerItem,
];

/** 观察会话生命周期投影，串联 Source、边界时间、采集状态与完成账本。 */
export interface ObservationSession extends LifecycleProjectionBase<ObservationSessionState> {
  readonly schema: "evaldock.mvp.observation-session/v1";
  readonly observationSessionId: StableId<"ObservationSessionId">;
  readonly attemptId: AttemptId;
  readonly agentTracePlanRef: Ref<AgentTracePlan>;
  readonly observationPlanRef: Ref<ObservationPlan>;
  readonly sourceRefs: readonly Ref<SourceDescriptor>[];
  readonly baselineStartedAt?: IsoDateTime;
  readonly baselinedAt?: IsoDateTime;
  readonly activeAt?: IsoDateTime;
  readonly targetTerminatedAt?: IsoDateTime;
  readonly drainStartedAt?: IsoDateTime;
  readonly sealedAt?: IsoDateTime;
  readonly collectionStatusRefs: readonly Ref<CollectionStatus>[];
  readonly completionLedger?: CompletionLedger;
}

/** RawObservation 两种载荷表示共享的来源、时间和原始摘要字段。 */
interface RawObservationCommon extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.raw-observation/v1";
  readonly observationId: StableId<"ObservationId">;
  readonly attemptId: AttemptId;
  readonly sourceRef: Ref<SourceDescriptor>;
  readonly externalEventType: string;
  readonly sourceTime: SourceTime;
  readonly captureMetadata: JsonObject;
  readonly rawDigest: ContentDigest;
}

/** Sensor 原始观察；小载荷内联，大载荷以 ArtifactRef 引用。 */
export type RawObservation = RawObservationCommon &
  (
    | { readonly payloadInline: JsonValue; readonly payloadArtifactRef?: never }
    | { readonly payloadInline?: never; readonly payloadArtifactRef: Ref<ArtifactRef> }
  );

/** 文件系统快照中的单个条目及读取、链接和根边界事实。 */
export interface FileEntry {
  readonly portablePath: PortablePath;
  readonly entryType: "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER";
  readonly mode: number;
  readonly byteLength?: number;
  readonly contentDigest?: ContentDigest;
  readonly linkTarget?: string;
  readonly resolvedWithinRoot: boolean;
  readonly readError?: string;
}

/** 扫描文件系统时单个路径的已脱敏读取错误。 */
export interface FileReadError {
  readonly portablePath: PortablePath;
  readonly reasonCode: string;
  readonly messageRedacted: string;
}

/** 某个观察阶段的完整目录快照和独立 snapshotDigest。 */
export interface FileSnapshot extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.file-snapshot/v1";
  readonly snapshotId: StableId<"FileSnapshotId">;
  readonly attemptId: AttemptId;
  readonly phase: "BEFORE" | "AFTER" | "POST_RESET";
  readonly rootBinding: string;
  readonly scanStartedAt: IsoDateTime;
  readonly scanCompletedAt: IsoDateTime;
  readonly entries: readonly FileEntry[];
  readonly readErrors: readonly FileReadError[];
  readonly completeness: EvidenceCompleteness;
  readonly snapshotDigest: ContentDigest;
}

/** 前后文件快照间单个路径的变化类型和两侧条目。 */
export interface FileEntryChange {
  readonly portablePath: PortablePath;
  readonly kind:
    | "ADDED"
    | "REMOVED"
    | "CONTENT_CHANGED"
    | "TYPE_CHANGED"
    | "METADATA_CHANGED"
    | "SYMLINK_CHANGED"
    | "UNREADABLE";
  readonly before?: FileEntry;
  readonly after?: FileEntry;
}

/** 比较两个 FileSnapshot 得到的分类差异记录。 */
export interface FileDiff extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.file-diff/v1";
  readonly diffId: StableId<"FileDiffId">;
  readonly beforeSnapshotRef: Ref<FileSnapshot>;
  readonly afterSnapshotRef: Ref<FileSnapshot>;
  readonly added: readonly FileEntryChange[];
  readonly removed: readonly FileEntryChange[];
  readonly modified: readonly FileEntryChange[];
  readonly typeChanged: readonly FileEntryChange[];
  readonly unchangedCount: number;
  readonly diffDigest: ContentDigest;
}

/** Process Observer 输出的脱敏进程条目；不采集命令参数、环境变量或打开文件。 */
export interface ProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly uid: number;
  readonly gid: number;
  readonly state: string;
  readonly startedAt: string;
  readonly executable: string;
}

/** macOS 目标用户在一个观察阶段的进程快照。 */
export interface ProcessSnapshot extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.process-snapshot/v1";
  readonly processSnapshotId: StableId<"ProcessSnapshotId">;
  readonly attemptId: AttemptId;
  readonly phase: "BEFORE" | "AFTER" | "POST_RESET";
  readonly resourceBinding: string;
  readonly observedUid: number;
  readonly scanStartedAt: IsoDateTime;
  readonly scanCompletedAt: IsoDateTime;
  readonly entries: readonly ProcessEntry[];
  readonly readErrors: readonly string[];
  readonly completeness: EvidenceCompleteness;
  readonly snapshotDigest: ContentDigest;
}

/** 两个进程快照之间的启动、退出和持续运行集合。 */
export interface ProcessDiff extends ImmutableRecordBase {
  readonly schema: "evaldock.mvp.process-diff/v1";
  readonly processDiffId: StableId<"ProcessDiffId">;
  readonly beforeSnapshotRef: Ref<ProcessSnapshot>;
  readonly afterSnapshotRef: Ref<ProcessSnapshot>;
  readonly started: readonly ProcessEntry[];
  readonly exited: readonly ProcessEntry[];
  readonly persisted: readonly ProcessEntry[];
  readonly diffDigest: ContentDigest;
}

/**
 * Environment Controller 为 Observation 准备的最小 Sensor 授权绑定；
 * `readCapabilityToken` 仅在进程内交给适配器执行读取。
 */
export interface PreparedObserverBinding {
  readonly bindingId: StableId<"PreparedObserverBindingId">;
  readonly environmentInstanceId: StableId<"EnvironmentInstanceId">;
  readonly resetGeneration: number;
  readonly sourceRequirementId: VersionedAssetId<"SourceRequirementId">;
  readonly resourceBinding: string;
  readonly sensorImplementationId: StableId<"SensorImplementationId">;
  readonly sensorImplementationVersion: string;
  readonly sensorCapabilityDigest: ContentDigest;
  readonly allowedOperations: readonly ("READ" | "SNAPSHOT" | "DRAIN")[];
  readonly grantDigest: ContentDigest;
  /** 仅供进程内调用的能力令牌，序列化、日志与摘要均不得包含它。 */
  readonly readCapabilityToken: string;
  readonly expiresAt: IsoDateTime;
}

/** Observation Coordinator 对正常 Case 采集或重置后验证的判别请求。 */
export type ObservationExecutionRequest =
  | {
      readonly kind: "CASE_RUN";
      readonly observationPlan: ObservationPlan;
      readonly environment: EnvironmentInstance & { readonly state: "SEEDED" };
      readonly preparedBindings: readonly PreparedObserverBinding[];
      readonly sensorRegistryDigest: ContentDigest;
    }
  | {
      readonly kind: "POST_RESET";
      readonly observationPlan: ObservationPlan;
      readonly environment: EnvironmentInstance & { readonly state: "RESETTING" };
      readonly resetGeneration: number;
      readonly expectedCleanDigest: ContentDigest;
      readonly preparedBindings: readonly PreparedObserverBinding[];
      readonly sensorRegistryDigest: ContentDigest;
    };

/** RepositoryPort.appendTransition 接受的乐观并发状态迁移命令。 */
export interface StateTransition<Projection extends LifecycleProjectionBase = LifecycleProjectionBase> {
  readonly aggregateRef: Ref<Projection> & { readonly revision: number };
  readonly expectedRevision: number;
  readonly fromState: Projection["state"];
  readonly toState: Projection["state"];
  readonly reasonCode: string;
  readonly supportingRefs: readonly Ref[];
  readonly failureRefs: readonly Ref<FailureRecord>[];
  readonly occurredAt: IsoDateTime;
  readonly nextProjection: Projection;
}

/** 每次成功状态迁移对应的不可变审计事件。 */
export interface LifecycleEvent {
  readonly schema: "evaldock.mvp.lifecycle-event/v1";
  readonly eventId: StableId<"LifecycleEventId">;
  readonly aggregateSchema: LifecycleAggregateSchema;
  readonly aggregateId: StableId;
  readonly scope: ScopeRef;
  readonly revision: number;
  readonly fromState: LifecycleState;
  readonly toState: LifecycleState;
  readonly reasonCode: string;
  readonly supportingRefs: readonly Ref[];
  readonly failureRefs: readonly Ref<FailureRecord>[];
  readonly occurredAt: IsoDateTime;
  readonly priorProjectionRef: Ref<LifecycleProjectionBase> & { readonly revision: number };
  readonly nextProjectionDigest: ContentDigest;
  readonly contentDigest: ContentDigest;
}

/** 为尚无 projectionDigest 的生命周期投影计算摘要并冻结。 */
export function withProjectionDigest<T extends object>(
  value: T,
): Readonly<T & { readonly projectionDigest: ContentDigest }> {
  if (Object.prototype.hasOwnProperty.call(value, "projectionDigest")) {
    throw new ContractViolation(
      "DIGEST_FIELD_PRESENT",
      "withProjectionDigest expects a projection without projectionDigest",
    );
  }
  return Object.freeze({ ...value, projectionDigest: digestValue(value) });
}

/** 从不可变领域记录的 schema、稳定 ID 和内容摘要创建 Ref。 */
export function refForImmutable<T extends { readonly schema: string; readonly contentDigest: ContentDigest }>(
  record: T,
  id: StableId,
): Readonly<Ref<T>> {
  return Object.freeze({ schema: record.schema, id, digest: record.contentDigest });
}

/** 从生命周期投影创建带 revision 的 Ref，供仓储乐观并发使用。 */
export function refForProjection<T extends LifecycleProjectionBase>(
  projection: T,
): Readonly<Ref<T> & { readonly revision: number }> {
  return Object.freeze({
    schema: projection.schema,
    id: projection.aggregateId,
    digest: projection.projectionDigest,
    revision: projection.revision,
  });
}

/** 从已提交 ArtifactRef 创建轻量不可变 Ref。 */
export function refForArtifact(
  artifact: ArtifactRef,
): Readonly<Ref<ArtifactRef>> {
  return Object.freeze({
    schema: artifact.schema,
    id: artifact.artifactId,
    digest: artifact.contentDigest,
  });
}

/** 深度冻结加载的 JSON，使运行时使用已读取的内容。 */
export function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
