import { createHash } from 'node:crypto'
import type {
  CaptureStats,
  ContentMode,
  Correlation,
  JsonObject,
  JsonValue,
  SerializedCapture,
} from './types.js'

export interface SnapshotOptions {
  contentMode: ContentMode
  maxDepth: number
  maxBreadth: number
  maxStringLength: number
  maxNodes: number
  includeErrorStacks: boolean
  redactKeyPattern: RegExp
}

const DEFAULT_SECRET_KEY = /(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie|credential|password|passwd|private[_-]?key|client[_-]?secret|secret)(?:$|[_-])/i
const CONTENT_KEY = /^(?:content|prompt|system|systemPrompt|reasoning|text|input|output|arguments|message|messages|body)$/i
const IDENTIFIER_KEY = /(?:^|_)(?:id|name|type|role|status|model|provider|path|url|mode|code|version|hash)$/i
const PEM_SECRET = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i
const API_KEY_SECRET = /\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{20,}\b/
const JWT_SECRET = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
const SECRET_NAME = String.raw`(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie|credential|password|passwd|private[_-]?key|client[_-]?secret|secret)`
const QUOTED_INLINE_SECRET = new RegExp(String.raw`\b(${SECRET_NAME})(\s*[:=]\s*)(["'])([^\r\n]*?)\3`, 'gi')
const INLINE_SECRET = new RegExp(String.raw`\b(${SECRET_NAME})(\s*[:=]\s*)([^\s&;,}\]"']+)`, 'gi')

function redactInlineSecrets(input: string): string {
  return input
    .replace(QUOTED_INLINE_SECRET, '$1$2$3[REDACTED]$3')
    .replace(INLINE_SECRET, '$1$2[REDACTED]')
}

export const defaultSnapshotOptions: SnapshotOptions = {
  contentMode: 'full',
  maxDepth: 32,
  maxBreadth: 500,
  maxStringLength: 2_000_000,
  maxNodes: 50_000,
  includeErrorStacks: true,
  redactKeyPattern: DEFAULT_SECRET_KEY,
}

function emptyStats(): CaptureStats {
  return { redacted: 0, omitted: 0, truncated: 0, circular: 0, unsupported: 0, getterSkipped: 0 }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function className(value: object): string {
  return value.constructor?.name || 'Object'
}

function isContextLike(value: object): boolean {
  return 'fiber' in value && 'registry' in value && 'reflect' in value && 'events' in value
}

function isFiberLike(value: object): boolean {
  return 'uid' in value && 'state' in value && 'inject' in value && 'runtime' in value && 'parent' in value
}

function isSessionLike(value: object): boolean {
  return className(value) === 'Session' && 'id' in value && 'seq' in value && 'header' in value
}

function isAgentLike(value: object): boolean {
  return 'id' in value && 'session' in value && 'inbox' in value && 'ctx' in value
}

function safeRead(object: object, key: string): unknown {
  try {
    return (object as Record<string, unknown>)[key]
  } catch (error) {
    return { $type: 'read-error', message: error instanceof Error ? error.message : String(error) }
  }
}

export class Snapshotter {
  readonly options: SnapshotOptions
  private nodesLeft = 0

  constructor(options: Partial<SnapshotOptions> = {}) {
    this.options = { ...defaultSnapshotOptions, ...options }
  }

  capture(input: unknown): SerializedCapture {
    this.nodesLeft = this.options.maxNodes
    const stats = emptyStats()
    const seen = new WeakMap<object, string>()
    try {
      const value = this.visit(input, '$', undefined, 0, seen, stats)
      return { value, stats }
    } catch (error) {
      stats.unsupported++
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = rawMessage
        .replace(BEARER_SECRET, 'Bearer [REDACTED]')
        .replace(API_KEY_SECRET, '[REDACTED_API_KEY]')
        .replace(JWT_SECRET, '[REDACTED_JWT]')
      const sanitizedMessage = redactInlineSecrets(message)
      return { value: { $type: 'capture-error', message: sanitizedMessage }, stats }
    }
  }

  private visit(
    input: unknown,
    path: string,
    key: string | undefined,
    depth: number,
    seen: WeakMap<object, string>,
    stats: CaptureStats,
  ): JsonValue {
    if (key && this.options.redactKeyPattern.test(key)) {
      this.options.redactKeyPattern.lastIndex = 0
      stats.redacted++
      return '[REDACTED:key]'
    }
    this.options.redactKeyPattern.lastIndex = 0

    if (this.nodesLeft-- <= 0) {
      stats.truncated++
      return { $type: 'max-nodes', limit: this.options.maxNodes }
    }

    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') {
      if (Number.isFinite(input) && !Object.is(input, -0)) return input
      stats.unsupported++
      return { $type: 'number', value: String(input) }
    }
    if (typeof input === 'string') return this.string(input, key, stats)
    if (typeof input === 'bigint') return { $type: 'bigint', value: input.toString() }
    if (typeof input === 'undefined') return { $type: 'undefined' }
    if (typeof input === 'symbol') return { $type: 'symbol', value: input.description ?? '' }
    if (typeof input === 'function') {
      stats.unsupported++
      return { $type: 'function', name: input.name || 'anonymous', arity: input.length }
    }

    const object = input as object
    if (depth >= this.options.maxDepth) {
      stats.truncated++
      return { $type: 'max-depth', class: className(object) }
    }
    const prior = seen.get(object)
    if (prior) {
      stats.circular++
      return { $type: 'circular', ref: prior }
    }
    seen.set(object, path)

    if (object instanceof Error) {
      const result: JsonObject = {
        $type: 'error',
        name: object.name,
        message: this.string(object.message, 'message', stats),
      }
      if (this.options.includeErrorStacks && object.stack) result.stack = this.string(object.stack, 'stack', stats)
      if (object.cause !== undefined) result.cause = this.visit(object.cause, `${path}.cause`, 'cause', depth + 1, seen, stats)
      return result
    }
    if (object instanceof Date) return { $type: 'date', value: object.toISOString() }
    if (object instanceof RegExp) return { $type: 'regexp', source: object.source, flags: object.flags }
    if (object instanceof URL) return { $type: 'url', value: object.toString() }
    if (object instanceof AbortSignal) return { $type: 'abort-signal', aborted: object.aborted, reason: this.visit(object.reason, `${path}.reason`, 'reason', depth + 1, seen, stats) }
    if (object instanceof WeakRef) {
      return { $type: 'weak-ref', value: this.visit(object.deref(), `${path}.value`, 'value', depth + 1, seen, stats) }
    }
    if (ArrayBuffer.isView(object)) {
      const view = object as ArrayBufferView
      return { $type: className(object), byteLength: view.byteLength }
    }
    if (object instanceof ArrayBuffer) return { $type: 'ArrayBuffer', byteLength: object.byteLength }

    if (isContextLike(object)) {
      const fiber = safeRead(object, 'fiber')
      return {
        $type: 'cordis-context',
        baseUrl: this.visit(safeRead(object, 'baseUrl'), `${path}.baseUrl`, 'baseUrl', depth + 1, seen, stats),
        fiber: this.visit(fiber, `${path}.fiber`, 'fiber', depth + 1, seen, stats),
      }
    }
    if (isFiberLike(object)) {
      const runtime = safeRead(object, 'runtime') as { name?: unknown } | null
      const parent = safeRead(object, 'parent') as { fiber?: { uid?: unknown } } | null
      return {
        $type: 'cordis-fiber',
        uid: this.visit(safeRead(object, 'uid'), `${path}.uid`, 'uid', depth + 1, seen, stats),
        name: this.visit(safeRead(object, 'name'), `${path}.name`, 'name', depth + 1, seen, stats),
        state: this.visit(safeRead(object, 'state'), `${path}.state`, 'state', depth + 1, seen, stats),
        runtimeName: this.visit(runtime?.name, `${path}.runtimeName`, 'runtimeName', depth + 1, seen, stats),
        parentUid: this.visit(parent?.fiber?.uid, `${path}.parentUid`, 'parentUid', depth + 1, seen, stats),
      }
    }
    if (isSessionLike(object)) return this.session(object, path, depth, seen, stats)
    if (isAgentLike(object)) return this.agent(object, path, depth, seen, stats)

    if (Array.isArray(object)) {
      const retained = object
      // Source sequence references are small scalar provenance, not a sampled collection.
      const breadth = key === 'sourceEventSeqs' && retained.every(Number.isSafeInteger)
        ? retained.length : this.options.maxBreadth
      const length = Math.min(retained.length, breadth)
      const result: JsonValue[] = []
      for (let index = 0; index < length; index++) {
        result.push(this.visit(retained[index], `${path}[${index}]`, String(index), depth + 1, seen, stats))
      }
      if (retained.length > length) {
        stats.truncated++
        result.push({ $type: 'truncated-items', omitted: retained.length - length })
      }
      return result
    }
    if (object instanceof Map) {
      const entries: JsonValue[] = []
      let index = 0
      for (const [entryKey, value] of object) {
        if (index >= this.options.maxBreadth) break
        entries.push([
          this.visit(entryKey, `${path}.mapKey${index}`, 'mapKey', depth + 1, seen, stats),
          this.visit(value, `${path}.mapValue${index}`, 'mapValue', depth + 1, seen, stats),
        ])
        index++
      }
      if (object.size > index) stats.truncated++
      return { $type: 'map', size: object.size, entries }
    }
    if (object instanceof Set) {
      const values: JsonValue[] = []
      let index = 0
      for (const value of object) {
        if (index >= this.options.maxBreadth) break
        values.push(this.visit(value, `${path}.set${index}`, 'setValue', depth + 1, seen, stats))
        index++
      }
      if (object.size > index) stats.truncated++
      return { $type: 'set', size: object.size, values }
    }

    const output: JsonObject = {}
    const allKeys = Reflect.ownKeys(object)
    const keys = allKeys
      .sort((a, b) => String(a).localeCompare(String(b)))
      .slice(0, this.options.maxBreadth)
    if (allKeys.length > keys.length) stats.truncated++
    if (className(object) !== 'Object') output.$class = className(object)
    for (const property of keys) {
      const outputKey = typeof property === 'symbol' ? `[symbol:${property.description ?? ''}]` : property
      const descriptor = Object.getOwnPropertyDescriptor(object, property)
      if (!descriptor) continue
      if (!('value' in descriptor)) {
        stats.getterSkipped++
        output[outputKey] = { $type: 'accessor', get: Boolean(descriptor.get), set: Boolean(descriptor.set) }
        continue
      }
      output[outputKey] = this.visit(descriptor.value, `${path}.${outputKey}`, outputKey, depth + 1, seen, stats)
    }
    return output
  }

  private session(object: object, path: string, depth: number, seen: WeakMap<object, string>, stats: CaptureStats): JsonValue {
    const result: JsonObject = { $type: 'dsh-session' }
    // Session 正文由 session/event 采集，不在每次反射时重新 deriveMessages。
    for (const key of ['id', 'seq', 'firstLiveSeq']) {
      result[key] = this.visit(safeRead(object, key), `${path}.${key}`, key, depth + 1, seen, stats)
    }
    const header = safeRead(object, 'header')
    result.cwd = this.visit(header && typeof header === 'object' ? safeRead(header, 'cwd') : undefined,
      `${path}.cwd`, 'cwd', depth + 1, seen, stats)
    return result
  }

  private agent(object: object, path: string, depth: number, seen: WeakMap<object, string>, stats: CaptureStats): JsonValue {
    const result: JsonObject = { $type: 'dsh-agent' }
    for (const key of ['id', 'status', 'model', 'session']) {
      result[key] = this.visit(safeRead(object, key), `${path}.${key}`, key, depth + 1, seen, stats)
    }
    return result
  }

  private string(input: string, key: string | undefined, stats: CaptureStats): JsonValue {
    if (PEM_SECRET.test(input) || BEARER_SECRET.test(input) || API_KEY_SECRET.test(input) || JWT_SECRET.test(input)) {
      stats.redacted++
      return `[REDACTED:value sha256:${hashText(input)} length:${input.length}]`
    }
    const sanitized = redactInlineSecrets(input)
    if (sanitized !== input) {
      stats.redacted++
      input = sanitized
    }
    if (key && CONTENT_KEY.test(key) && !IDENTIFIER_KEY.test(key)) {
      if (this.options.contentMode === 'omit') {
        stats.omitted++
        return { $type: 'omitted-content', length: input.length, sha256: hashText(input) }
      }
      if (this.options.contentMode === 'hash') {
        return { $type: 'hashed-content', length: input.length, sha256: hashText(input) }
      }
    }
    if (input.length > this.options.maxStringLength) {
      stats.truncated++
      return {
        $type: 'truncated-string',
        length: input.length,
        sha256: hashText(input),
        prefix: input.slice(0, this.options.maxStringLength),
      }
    }
    return input
  }
}

export function extractCorrelation(input: unknown): Correlation {
  const output: Correlation = {}
  const seen = new WeakSet<object>()
  const aliases: Record<string, keyof Correlation> = {
    sessionId: 'sessionId', session_id: 'sessionId',
    agentId: 'agentId', agent_id: 'agentId',
    turn: 'turn', turnIndex: 'turn', turn_id: 'turn',
    step: 'step', stepIndex: 'step', step_id: 'step',
    requestId: 'requestId', request_id: 'requestId',
    callId: 'callId', call_id: 'callId',
    toolCallId: 'toolCallId', tool_call_id: 'toolCallId',
    subCallId: 'subCallId', sub_call_id: 'subCallId',
    parentRunId: 'parentRunId', parent_run_id: 'parentRunId',
    subagentRunId: 'subagentRunId', subagent_run_id: 'subagentRunId',
  }
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) visit(item, depth + 1)
      return
    }
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      const target = aliases[key]
      if (target && output[target] === undefined && (typeof child === 'string' || typeof child === 'number')) {
        if (target === 'turn' || target === 'step') {
          if (typeof child === 'number') output[target] = child
        } else {
          output[target] = String(child) as never
        }
      }
      visit(child, depth + 1)
    }
  }
  visit(input, 0)
  if (!output.sessionId && input && typeof input === 'object') {
    const candidate = safeRead(input as object, 'id')
    if (typeof candidate === 'string' && /session|agent/i.test(className(input as object))) output.sessionId = candidate
  }
  return output
}

export function sanitizeText(input: string): string {
  const sanitized = input
    .replace(/(-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)[\s\S]*?(-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)/g, '$1\n[REDACTED]\n$2')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/(^|\n)(\s*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie|password|private[_-]?key|client[_-]?secret|secret)\s*:\s*)([^\n]+)/gi, '$1$2[REDACTED]')
  return redactInlineSecrets(sanitized)
}

export default Snapshotter
