export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const TRACE_SCHEMA = 'evaldock.trace/v1' as const
export const MANIFEST_SCHEMA = 'evaldock.manifest/v1' as const
export const SNAPSHOT_SCHEMA = 'evaldock.runtime-snapshot/v1' as const

export type ContentMode = 'full' | 'hash' | 'omit'
export type EvidenceStability = 'public' | 'internal-version-pinned' | 'derived' | 'external'

export interface ProbeConfig {
  outputDir: string
  runId?: string
  contentMode: ContentMode
  captureDispatch: boolean
  captureLogs: boolean
  captureServiceValues: boolean
  snapshotIntervalMs: number
  maxDepth: number
  maxBreadth: number
  maxStringLength: number
  maxNodes: number
  includeErrorStacks: boolean
  redactKeyPattern: string
}

export interface EvidenceSource {
  channel: 'cordis-event' | 'cordis-reflection' | 'cordis-log' | 'dsh-session' | 'sdk-jsonrpc' | 'web-api' | 'websocket' | 'filesystem' | 'supervisor'
  stability: EvidenceStability
  component?: string
  version?: string
}

export interface WebEvidenceRecord {
  schema: 'evaldock.web-evidence/v1'
  runId: string
  sourceSeq: number
  ts: string
  channel: 'baseline' | 'events.mux' | 'events.host'
  method: string
  correlation: Correlation
  payload: JsonValue
}

export interface Correlation {
  sessionId?: string
  agentId?: string
  turn?: number
  step?: number
  requestId?: string
  callId?: string
  toolCallId?: string
  subCallId?: string
  parentRunId?: string
  subagentRunId?: string
}

export interface TraceEnvelope {
  schema: typeof TRACE_SCHEMA
  runId: string
  seq: number
  ts: string
  monotonicNs: string
  kind: string
  source: EvidenceSource
  correlation: Correlation
  data: JsonValue
  integrity: {
    algorithm: 'sha256-chain-v1'
    previous: string
    hash: string
  }
}

export interface CaptureStats {
  redacted: number
  omitted: number
  truncated: number
  circular: number
  unsupported: number
  getterSkipped: number
}

export interface SerializedCapture {
  value: JsonValue
  stats: CaptureStats
}

export interface FiberSnapshot {
  uid: number | null
  name: string
  state: string
  stateCode: number
  parentUid: number | null
  inject: string[]
  provide: string[]
  config: JsonValue
  effects: JsonValue
  error?: JsonValue
}

export interface ServiceSnapshot {
  name: string
  isolation: string
  providerFiberUid: number | null
  providerPlugin: string
  active: boolean
  shape: {
    constructor: string
    ownProperties: string[]
    methods: string[]
  }
  value?: JsonValue
}

export interface RuntimeSnapshot {
  schema: typeof SNAPSHOT_SCHEMA
  capturedAt: string
  reason: string
  fibers: FiberSnapshot[]
  services: ServiceSnapshot[]
  declaredProperties: Array<{ name: string; type: string }>
  eventListeners: Array<{ event: string; listeners: number; owners: string[] }>
  agents: JsonValue[]
  sessions: JsonValue[]
  tools: JsonValue[]
  scopedTools: Array<{ agentId: string; tools: JsonValue[] }>
  workspaces: JsonValue[]
  optionalSurfaces: JsonObject
  captureErrors: JsonValue[]
}

export interface RunManifest {
  schema: typeof MANIFEST_SCHEMA
  runId: string
  createdAt: string
  updatedAt: string
  status: 'running' | 'completed' | 'crashed' | 'partial'
  collector: {
    name: string
    version: string
    traceSchema: string
  }
  host?: JsonObject
  dsh?: JsonObject
  probe?: JsonObject
  supervisor?: JsonObject
  files?: JsonObject
  errors?: JsonValue[]
}

export type CoverageState = 'observed' | 'available-not-exercised' | 'not-available' | 'capture-error'

export interface CoverageEntry {
  id: string
  domain: string
  description: string
  state: CoverageState
  evidence: string[]
  notes: string[]
}

export interface FileState {
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtimeMs: number
  mode: number
  sha256?: string
  symlinkTarget?: string
  hashSkipped?: string
}

export interface DirectorySnapshot {
  schema: 'evaldock.directory-snapshot/v1'
  root: string
  capturedAt: string
  entries: FileState[]
  errors: Array<{ path: string; message: string }>
}
