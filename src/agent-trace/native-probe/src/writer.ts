import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { FileHandle } from 'node:fs/promises'
import {
  MANIFEST_SCHEMA,
  TRACE_SCHEMA,
  type Correlation,
  type EvidenceSource,
  type JsonObject,
  type JsonValue,
  type RunManifest,
  type TraceEnvelope,
} from './types.js'

const COLLECTOR_VERSION = '0.2.0'

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeObjects(left: unknown, right: unknown): JsonObject {
  const output: Record<string, JsonValue> = {}
  if (isObject(left)) {
    for (const [key, value] of Object.entries(left)) output[key] = value as JsonValue
  }
  if (isObject(right)) {
    for (const [key, value] of Object.entries(right)) {
      output[key] = isObject(output[key]) && isObject(value)
        ? mergeObjects(output[key], value)
        : value as JsonValue
    }
  }
  return output
}

export function safeRunId(input: string): string {
  const normalized = input.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!normalized || normalized === '.' || normalized === '..') throw new Error(`invalid run id: ${JSON.stringify(input)}`)
  return normalized.slice(0, 160)
}

export function createRunId(now = new Date()): string {
  return `run-${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}`
}

export class RunWriter {
  readonly runDir: string
  readonly eventsPath: string
  readonly logsPath: string
  private eventHandle: FileHandle | undefined
  private logHandle: FileHandle | undefined
  private tail: Promise<void> = Promise.resolve()
  private sequence = 0
  private pendingRecords = 0
  private droppedRecords = 0
  private previousHash = '0'.repeat(64)
  private closed = false
  private firstFailure?: Error
  private readonly startedAt = new Date().toISOString()

  private constructor(
    readonly outputDir: string,
    readonly runId: string,
  ) {
    this.runDir = join(outputDir, runId)
    this.eventsPath = join(this.runDir, 'events.jsonl')
    this.logsPath = join(this.runDir, 'logs.jsonl')
  }

  static async create(outputDir: string, runId = createRunId()): Promise<RunWriter> {
    const writer = new RunWriter(outputDir, safeRunId(runId))
    await mkdir(writer.runDir, { recursive: true })
    await chmod(writer.runDir, 0o700)
    writer.eventHandle = await open(writer.eventsPath, 'a', 0o600)
    writer.logHandle = await open(writer.logsPath, 'a', 0o600)
    return writer
  }

  get failure(): Error | undefined {
    return this.firstFailure
  }

  async writeInitialManifest(extra: JsonObject = {}): Promise<void> {
    const base: RunManifest = {
      schema: MANIFEST_SCHEMA,
      runId: this.runId,
      createdAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      status: 'running',
      collector: {
        name: 'evaldock-runtime-probe',
        version: COLLECTOR_VERSION,
        traceSchema: TRACE_SCHEMA,
      },
    }
    const existing = await this.readJsonIfPresent(join(this.runDir, 'manifest.json'))
    await this.writeJson('manifest.json', mergeObjects(mergeObjects(base, existing), extra))
  }

  async updateManifest(extra: JsonObject): Promise<void> {
    const path = join(this.runDir, 'manifest.json')
    const existing = await this.readJsonIfPresent(path)
    const merged = mergeObjects(existing, { ...extra, updatedAt: new Date().toISOString() })
    await this.writeJson('manifest.json', merged)
  }

  record(
    kind: string,
    source: EvidenceSource,
    data: JsonValue,
    correlation: Correlation = {},
    stream: 'events' | 'logs' = 'events',
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error('run writer is closed'))
    if (this.pendingRecords >= 10_000) {
      this.droppedRecords++
      return Promise.resolve()
    }
    this.pendingRecords++
    const calledAt = new Date().toISOString()
    const monotonicNs = String(Math.trunc((performance.timeOrigin + performance.now()) * 1_000_000))
    return this.enqueue(async () => {
      try {
        const handle = stream === 'logs' ? this.logHandle : this.eventHandle
        if (!handle) throw new Error(`${stream} stream is unavailable`)
        const lines: string[] = []
        if (this.droppedRecords > 0) {
          const dropped = this.droppedRecords
          this.droppedRecords = 0
          lines.push(this.encode({
            schema: TRACE_SCHEMA,
            runId: this.runId,
            seq: ++this.sequence,
            ts: calledAt,
            monotonicNs,
            kind: 'collector.dropped',
            source: { channel: 'supervisor', stability: 'derived', component: 'RunWriter' },
            correlation: {},
            data: { dropped, reason: 'pending-record-limit', limit: 10_000 },
          }))
        }
        lines.push(this.encode({
          schema: TRACE_SCHEMA,
          runId: this.runId,
          seq: ++this.sequence,
          ts: calledAt,
          monotonicNs,
          kind,
          source,
          correlation,
          data,
        }))
        await handle.appendFile(`${lines.join('\n')}\n`, 'utf8')
      } finally {
        this.pendingRecords--
      }
    })
  }

  private encode(input: Omit<TraceEnvelope, 'integrity'>): string {
    let draft = input
    let encoded = JSON.stringify(draft)
    const bytes = Buffer.byteLength(encoded)
    if (bytes > 64 * 1024 * 1024) {
      draft = {
        ...input,
        data: {
          $type: 'oversize-record',
          originalBytes: bytes,
          maxBytes: 64 * 1024 * 1024,
          sha256: createHash('sha256').update(encoded).digest('hex'),
        },
      }
      encoded = JSON.stringify(draft)
    }
    const previous = this.previousHash
    const hash = createHash('sha256').update(previous).update('\n').update(encoded).digest('hex')
    this.previousHash = hash
    return JSON.stringify({ ...draft, integrity: { algorithm: 'sha256-chain-v1', previous, hash } } satisfies TraceEnvelope)
  }

  writeJson(relativePath: string, value: JsonValue): Promise<void> {
    return this.enqueue(() => atomicWrite(join(this.runDir, relativePath), `${JSON.stringify(value, null, 2)}\n`))
  }

  writeText(relativePath: string, value: string): Promise<void> {
    return this.enqueue(() => atomicWrite(join(this.runDir, relativePath), value))
  }

  async drain(): Promise<void> {
    await this.tail
    if (this.firstFailure) throw this.firstFailure
  }

  async close(status: RunManifest['status'] = 'completed'): Promise<void> {
    if (this.closed) return
    await this.tail
    await this.updateManifest({
      status,
      files: {
        events: 'events.jsonl',
        logs: 'logs.jsonl',
        lastSeq: this.sequence,
      },
      ...(this.firstFailure ? { errors: [{ message: this.firstFailure.message }] } : {}),
    })
    await this.drain().catch(() => undefined)
    this.closed = true
    await Promise.allSettled([this.eventHandle?.close(), this.logHandle?.close()].filter(Boolean) as Promise<void>[])
    this.eventHandle = undefined
    this.logHandle = undefined
    if (this.firstFailure) throw this.firstFailure
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.tail.then(operation)
    this.tail = current.catch((error: unknown) => {
      if (!this.firstFailure) this.firstFailure = error instanceof Error ? error : new Error(String(error))
    })
    return current
  }

  private async readJsonIfPresent(path: string): Promise<JsonValue> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as JsonValue
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return {}
      if (error instanceof SyntaxError) return {}
      throw error
    }
  }
}

export async function atomicWrite(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, value, { mode: 0o600 })
  await rename(temporary, path)
}
