import { createSessionEvidenceCompactor, ToolResultReferences } from './evidence-events.js'
import { hostname, platform, release, arch } from 'node:os'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context, Message } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Snapshotter, extractCorrelation } from './snapshot.js'
import { buildIntegrationMap, buildRuntimeCatalog, buildRuntimeSnapshot, snapshotFiber, type LooseFiber } from './introspect.js'
import { eventFingerprint, isStreamRecord, objectRecord, packSessionDeltas, reduceSessionEvents, mergeRemainingStreams, type SessionRecord } from './session-events.js'
import { RunWriter, createRunId } from './writer.js'
import type { ContentMode, EvidenceSource, JsonObject, JsonValue, ProbeConfig } from './types.js'

export const name = 'evaldock-runtime-probe'
export const inject: string[] = []

export interface Config {
  outputDir?: string
  runId?: string
  contentMode?: ContentMode
  captureDispatch?: boolean
  captureLogs?: boolean
  captureServiceValues?: boolean
  snapshotIntervalMs?: number
  maxDepth?: number
  maxBreadth?: number
  maxStringLength?: number
  maxNodes?: number
  includeErrorStacks?: boolean
  redactKeyPattern?: string
  deepPipelineCapture?: boolean
  captureLlmChunks?: boolean
}

export const Config: Schema<Config> = Schema.object({
  outputDir: Schema.string().default('./var/batch-runtime/probe'),
  runId: Schema.string(),
  contentMode: Schema.union(['full', 'hash', 'omit']).default('full'),
  captureDispatch: Schema.boolean().default(true),
  captureLogs: Schema.boolean().default(true),
  captureServiceValues: Schema.boolean().default(false),
  // Compatibility option only; capture is event-driven, without periodic snapshots.
  snapshotIntervalMs: Schema.number().min(0).max(3_600_000).default(0),
  maxDepth: Schema.number().min(2).max(50).default(32),
  maxBreadth: Schema.number().min(10).max(100_000).default(500),
  maxStringLength: Schema.number().min(256).max(50_000_000).default(2_000_000),
  maxNodes: Schema.number().min(100).max(10_000_000).default(50_000),
  includeErrorStacks: Schema.boolean().default(true),
  redactKeyPattern: Schema.string().default('(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie|credential|password|passwd|private[_-]?key|client[_-]?secret|secret)(?:$|[_-])'),
  deepPipelineCapture: Schema.boolean().default(false),
  captureLlmChunks: Schema.boolean().default(false),
})

const PUBLIC_EVENT_SOURCE: EvidenceSource = {
  channel: 'cordis-event',
  stability: 'public',
  component: 'dsh',
}
const INTERNAL_EVENT_SOURCE: EvidenceSource = {
  channel: 'cordis-event',
  stability: 'internal-version-pinned',
  component: '@deepseek-ai/cordis',
  version: '4.0.1',
}
const REFLECTION_SOURCE: EvidenceSource = {
  channel: 'cordis-reflection',
  stability: 'internal-version-pinned',
  component: '@deepseek-ai/cordis',
  version: '4.0.1',
}
const SESSION_SOURCE: EvidenceSource = {
  channel: 'dsh-session',
  stability: 'public',
  component: '@deepseek-ai/dsh-session',
}
const LOG_SOURCE: EvidenceSource = {
  channel: 'cordis-log',
  stability: 'public',
  component: '@deepseek-ai/cordis',
  version: '4.0.1',
}

function effectiveConfig(input: Config): ProbeConfig {
  let redactKeyPattern: RegExp
  try {
    redactKeyPattern = new RegExp(input.redactKeyPattern ?? '(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie|credential|password|passwd|private[_-]?key|client[_-]?secret|secret)(?:$|[_-])', 'i')
  } catch (error) {
    throw new Error(`evaldock-runtime-probe: invalid redactKeyPattern: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    outputDir: resolve(input.outputDir ?? './var/batch-runtime/probe'),
    ...(input.runId ? { runId: input.runId } : {}),
    contentMode: input.contentMode ?? 'full',
    captureDispatch: input.captureDispatch ?? true,
    captureLogs: input.captureLogs ?? true,
    captureServiceValues: input.captureServiceValues ?? false,
    snapshotIntervalMs: input.snapshotIntervalMs ?? 0,
    maxDepth: input.maxDepth ?? 32,
    maxBreadth: input.maxBreadth ?? 500,
    maxStringLength: input.maxStringLength ?? 2_000_000,
    maxNodes: input.maxNodes ?? 50_000,
    includeErrorStacks: input.includeErrorStacks ?? true,
    redactKeyPattern: redactKeyPattern.source,
  }
}

function jsonStats(stats: ReturnType<Snapshotter['capture']>['stats']): JsonObject {
  return { ...stats }
}

function sessionIdOf(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== 'object') return undefined
  try {
    const id = (candidate as { id?: unknown }).id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

export async function apply(ctx: Context, rawConfig: Config = {}): Promise<() => Promise<void>> {
  const config = effectiveConfig(rawConfig)
  const deepPipelineCapture = rawConfig.deepPipelineCapture ?? process.env.DSH_EVAL_DEEP_CAPTURE === '1'
  const captureLlmChunks = rawConfig.captureLlmChunks ?? process.env.DSH_EVAL_CAPTURE_LLM_CHUNKS === '1'
  const writer = await RunWriter.create(config.outputDir, config.runId ?? process.env.DSH_EVAL_RUN_ID ?? createRunId())
  const snapshotter = new Snapshotter({
    contentMode: config.contentMode,
    maxDepth: config.maxDepth,
    maxBreadth: config.maxBreadth,
    maxStringLength: config.maxStringLength,
    maxNodes: config.maxNodes,
    includeErrorStacks: config.includeErrorStacks,
    redactKeyPattern: new RegExp(config.redactKeyPattern, 'i'),
  })
  let stopping = false
  let debounceTimer: NodeJS.Timeout | undefined
  let snapshotTail = Promise.resolve()
  let bestSnapshotScore = -1
  let previousSnapshotDigest: string | undefined
  const filtering: Record<string, number> = {}
  const count = (reason: string, amount = 1): void => { filtering[reason] = (filtering[reason] ?? 0) + amount }
  const seenEvents = new Map<string, string>()
  const toolResultReferences = new ToolResultReferences()
  const pendingResults = new Set<{execution:Record<string,unknown>;result:unknown;timer:NodeJS.Timeout}>()
  const flushToolResult = (item:{execution:Record<string,unknown>;result:unknown;timer:NodeJS.Timeout}):void => {
    clearTimeout(item.timer); pendingResults.delete(item)
    const e=item.execution
    captureRecord('tool.final-result', PUBLIC_EVENT_SOURCE, {
      execution: {callId:e.callId,rootCallId:e.rootCallId,name:e.name,arguments:e.arguments,
        agentId:objectRecord(e.agent)?.id,hasParent:e.parent!==undefined},
      result:toolResultReferences.result(e.callId,item.result),
    }, e)
  }
  const compactors = new Map<string, ReturnType<typeof createSessionEvidenceCompactor>>()
  const pending = new Map<string, { records: SessionRecord[]; bytes: number; timer: NodeJS.Timeout }>()


  const captureRecord = (
    kind: string,
    source: EvidenceSource,
    value: unknown,
    correlationInput: unknown = value,
    stream: 'events' | 'logs' = 'events',
  ): void => {
    try {
      const capture = snapshotter.capture(value)
      void writer.record(kind, source, {
        payload: capture.value,
        capture: jsonStats(capture.stats),
      }, extractCorrelation(correlationInput), stream).catch(() => undefined)
    } catch (error) {
      const failure = snapshotter.capture(error)
      void writer.record('capture.error', REFLECTION_SOURCE, {
        attemptedKind: kind,
        error: failure.value,
      }).catch(() => undefined)
    }
  }

  const flushSession = (sessionId: string, committed?: SessionRecord): void => {
    const batch = pending.get(sessionId)
    if (batch) { clearTimeout(batch.timer); pending.delete(sessionId) }
    const reduced = reduceSessionEvents([...(batch?.records ?? []), ...(committed ? [committed] : [])])
    count('coveredStreamRecords', reduced.stats.coveredStreamRecords)
    count('retainedStreamRecords', reduced.stats.retainedStreamRecords)
    const packed = packSessionDeltas(mergeRemainingStreams(reduced.records), config.maxBreadth)
    count('packedStreamRowsSaved', reduced.records.length - packed.length)
    const compactor = compactors.get(sessionId) ?? createSessionEvidenceCompactor()
    compactors.set(sessionId, compactor)
    for (const original of packed) {
      const event = compactor.accept(original)
      if (!event) continue
      captureRecord('session.event', SESSION_SOURCE, { sessionId, event }, { sessionId, event })
    }
  }
  const recordSessionEvent = (sessionId: string, candidate: unknown): void => {
    const event = objectRecord(candidate)
    if (event) toolResultReferences.observe(sessionId,event)
    if (!event) { captureRecord('session.event', SESSION_SOURCE, { sessionId, event: candidate }); return }
    // Same seq+same bytes is an adoption/live-hook duplicate. Equal calls at different seqs stay.
    if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq)) {
      const key = JSON.stringify([sessionId, event.seq])
      const digest = eventFingerprint(event)
      if (seenEvents.get(key) === digest) { count('duplicateSessionEvents'); return }
      if (seenEvents.has(key)) {
        captureRecord('capture.error', SESSION_SOURCE, { operation: 'session-sequence-conflict', sessionId, seq: event.seq })
      }
      seenEvents.set(key, digest)
      if (seenEvents.size > 100_000) seenEvents.delete(seenEvents.keys().next().value!)
    }
    if (!isStreamRecord(event)) { flushSession(sessionId, event); return }
    let batch = pending.get(sessionId)
    if (!batch) {
      const timer = setTimeout(() => flushSession(sessionId), 5_000)
      timer.unref()
      batch = { records: [], bytes: 0, timer }
      pending.set(sessionId, batch)
    }
    batch.records.push(event)
    batch.bytes += Buffer.byteLength(JSON.stringify(event))
    // Uncommitted fragments cannot be discarded. Bound memory and delay, then persist them verbatim.
    if (batch.bytes >= 512 * 1024) { count('pendingLimitFlushes'); flushSession(sessionId) }
  }

  const captureSnapshot = (reason: string): Promise<void> => {
    snapshotTail = snapshotTail.then(async () => {
      if (stopping && reason !== 'shutdown') return
      try {
        const snapshot = buildRuntimeSnapshot(ctx, snapshotter, reason, config.captureServiceValues)
        const snapshotDigest = createHash('sha256')
          .update(JSON.stringify({ ...snapshot, capturedAt: undefined, reason: undefined }))
          .digest('hex')
        if (snapshotDigest === previousSnapshotDigest) { count('unchangedSnapshots'); return }
        previousSnapshotDigest = snapshotDigest
        const score = snapshot.services.filter((service) => service.active).length * 10
          + snapshot.fibers.filter((fiber) => fiber.state === 'ACTIVE').length
          + snapshot.agents.length * 100
        if (score >= bestSnapshotScore) {
          bestSnapshotScore = score
          await writer.writeJson('runtime-snapshot.json', snapshot as unknown as JsonValue)
          await writer.writeJson('runtime-catalog.json', buildRuntimeCatalog(snapshot))
          await writer.writeJson('integration-map.json', buildIntegrationMap(snapshot))
        }
        const retainFull = false // Full configuration is stored once in runtime-catalog, never repeated in evidence.
        if (retainFull) {
          await writer.record('runtime.snapshot', REFLECTION_SOURCE, snapshot as unknown as JsonValue)
        } else {
          await writer.record('runtime.snapshot.summary', REFLECTION_SOURCE, {
            capturedAt: snapshot.capturedAt,
            reason,
            score,
            fibers: snapshot.fibers.length,
            activeFibers: snapshot.fibers.filter((fiber) => fiber.state === 'ACTIVE').length,
            services: snapshot.services.length,
            activeServices: snapshot.services.filter((service) => service.active).length,
            agents: snapshot.agents.length,
            sessions: snapshot.sessions.length,
            tools: snapshot.tools.length,
            captureErrors: snapshot.captureErrors,
          })
        }
      } catch (error) {
        captureRecord('capture.error', REFLECTION_SOURCE, { operation: 'runtime-snapshot', reason, error })
      }
    })
    return snapshotTail
  }

  const scheduleSnapshot = (reason: string): void => {
    if (stopping || debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void captureSnapshot(reason)
    }, 25)
    debounceTimer.unref()
  }

  await writer.writeInitialManifest({
    host: {
      pid: process.pid,
      ppid: process.ppid,
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      hostname: hostname(),
      cwd: process.cwd(),
      argv: snapshotter.capture(process.argv).value,
    },
    probe: {
      state: 'active',
      startedAt: new Date().toISOString(),
      config: snapshotter.capture(config).value,
      observationRoutes: ['cordis-reflection', 'cordis-internal-lifecycle', 'cordis-dispatch', 'dsh-session-firehose', 'cordis-structured-logs'],
      deepPipelineCapture,
      captureLlmChunks,
      filteringPolicy: 'session-semantic-v1',
      pendingStreamMaxMs: 5_000,
      pendingStreamMaxBytes: 512 * 1024,
    },
  })
  captureRecord('probe.start', REFLECTION_SOURCE, {
    runDir: writer.runDir,
    contentMode: config.contentMode,
    captureDispatch: config.captureDispatch,
    captureLogs: config.captureLogs,
    captureServiceValues: config.captureServiceValues,
  })

  type UntypedOn = (event: string, listener: (...args: unknown[]) => unknown, options?: { global?: boolean; prepend?: boolean }) => () => boolean
  const on = ctx.on.bind(ctx) as unknown as UntypedOn

  on('internal/plugin', (candidate) => {
    const fiber = candidate as unknown as LooseFiber
    captureRecord('plugin.lifecycle', INTERNAL_EVENT_SOURCE, {
      action: fiber.uid === null ? 'disposed' : 'registered',
      fiber: snapshotFiber(fiber, snapshotter),
    }, fiber)
    scheduleSnapshot('plugin-lifecycle')
  }, { global: true })

  on('internal/status', (candidate, oldState) => {
    const fiber = candidate as unknown as LooseFiber
    captureRecord('plugin.status', INTERNAL_EVENT_SOURCE, {
      oldState,
      fiber: snapshotFiber(fiber, snapshotter),
    }, fiber)
    scheduleSnapshot('plugin-status')
  }, { global: true })

  on('internal/service', (serviceName, value) => {
    captureRecord('service.lifecycle', INTERNAL_EVENT_SOURCE, { serviceName, available: value != null, valueType: typeof value })
    scheduleSnapshot('service-lifecycle')
  }, { global: true })

  if (config.captureDispatch) {
    on('internal/dispatch', (mode, eventName, args, thisArg) => {
      if (typeof eventName !== 'string') return
      // A dispatch mirror is not a second Agent action. Dedicated hooks own these payloads.
      if (['session/event', 'session/created', 'session/disposed', 'session/flush',
        'tools/result', 'tools/change', 'system-prompt/change'].includes(eventName)) {
        count('mirroredDispatch:' + eventName); return
      }
      if (/^(internal|loader)\//u.test(eventName)) {
        count('frameworkDispatch:' + eventName); return
      }
      // Pipeline arguments contain the complete request/context; final Session events own its content.
      if (['llm/stream', 'system-prompt/assemble'].includes(eventName)) {
        count('pipelineDispatch:' + eventName); return
      }
      // Unknown plugin events remain available; no label- or plugin-prefix allowlist.
      captureRecord('runtime.event.dispatch', INTERNAL_EVENT_SOURCE, { mode, eventName, args,
        hasContext: thisArg !== undefined }, args)
    }, { global: true })
  }

  on('session/created', (session) => {
    captureRecord('session.lifecycle', SESSION_SOURCE, { action: 'created', sessionId: sessionIdOf(session) }, session)
    scheduleSnapshot('session-created')
  }, { global: true })

  on('session/disposed', (session) => {
    flushSession(sessionIdOf(session) ?? '[unknown]')
    captureRecord('session.lifecycle', SESSION_SOURCE, { action: 'disposed', sessionId: sessionIdOf(session) }, session)
    scheduleSnapshot('session-disposed')
  }, { global: true })

  on('session/event', (session, event) => {
    recordSessionEvent(sessionIdOf(session) ?? '[unknown]', event)
  }, { global: true })

  on('session/flush', () => count('sessionFlushNotifications'), { global: true })

  on('tools/result', (execution, result) => {
    const item={execution:objectRecord(execution) ?? {},result,timer:undefined as unknown as NodeJS.Timeout}
    item.timer=setTimeout(()=>flushToolResult(item),250)
    item.timer.unref()
    pendingResults.add(item)
    if(pendingResults.size>100)flushToolResult(pendingResults.values().next().value!)
  }, { global: true })
  on('tools/change', () => scheduleSnapshot('tools-change'), { global: true })
  on('system-prompt/change', () => scheduleSnapshot('system-prompt-change'), { global: true })

  if (deepPipelineCapture) {
    on('tools/pre-execute', async (execution, next) => {
      captureRecord('pipeline.tools.pre.input', PUBLIC_EVENT_SOURCE, { execution, intrusive: true }, execution)
      try {
        const result = await (next as () => Promise<unknown>)()
        captureRecord('pipeline.tools.pre.output', PUBLIC_EVENT_SOURCE, { execution, decision: result, intrusive: true }, execution)
        return result
      } catch (error) {
        captureRecord('pipeline.tools.pre.error', PUBLIC_EVENT_SOURCE, { execution, error, intrusive: true }, execution)
        throw error
      }
    }, { global: true })
    on('tools/execute', async (execution, next) => {
      captureRecord('pipeline.tools.execute.input', PUBLIC_EVENT_SOURCE, { execution, intrusive: true }, execution)
      try {
        const result = await (next as () => Promise<unknown>)()
        captureRecord('pipeline.tools.execute.output', PUBLIC_EVENT_SOURCE, { execution, result, intrusive: true }, execution)
        return result
      } catch (error) {
        captureRecord('pipeline.tools.execute.error', PUBLIC_EVENT_SOURCE, { execution, error, intrusive: true }, execution)
        throw error
      }
    }, { global: true })
    on('tools/post-execute', async (execution, result, next) => {
      captureRecord('pipeline.tools.post.input', PUBLIC_EVENT_SOURCE, { execution, result, intrusive: true }, execution)
      try {
        const decision = await (next as () => Promise<unknown>)()
        captureRecord('pipeline.tools.post.output', PUBLIC_EVENT_SOURCE, { execution, decision, intrusive: true }, execution)
        return decision
      } catch (error) {
        captureRecord('pipeline.tools.post.error', PUBLIC_EVENT_SOURCE, { execution, error, intrusive: true }, execution)
        throw error
      }
    }, { global: true })
    on('system-prompt/assemble', async (assembly, context, next) => {
      captureRecord('pipeline.prompt.input', PUBLIC_EVENT_SOURCE, { assembly, context, intrusive: true }, context)
      try {
        const result = await (next as () => Promise<unknown>)()
        captureRecord('pipeline.prompt.output', PUBLIC_EVENT_SOURCE, { assembly: result, context, intrusive: true }, context)
        return result
      } catch (error) {
        captureRecord('pipeline.prompt.error', PUBLIC_EVENT_SOURCE, { context, error, intrusive: true }, context)
        throw error
      }
    }, { global: true })
    on('llm/stream', (options, next) => {
      captureRecord('pipeline.llm.request', PUBLIC_EVENT_SOURCE, { options, intrusive: true }, options)
      const started = performance.now()
      const stream = (next as () => AsyncIterable<unknown>)()
      const wrapped = async function* (): AsyncIterable<unknown> {
        let chunks = 0
        try {
          for await (const chunk of stream) {
            chunks++
            if (captureLlmChunks) captureRecord('pipeline.llm.chunk', PUBLIC_EVENT_SOURCE, { chunk, chunkIndex: chunks, intrusive: true }, options)
            yield chunk
          }
          captureRecord('pipeline.llm.complete', PUBLIC_EVENT_SOURCE, { chunks, durationMs: performance.now() - started, intrusive: true }, options)
        } catch (error) {
          captureRecord('pipeline.llm.error', PUBLIC_EVENT_SOURCE, { error, chunks, durationMs: performance.now() - started, intrusive: true }, options)
          throw error
        }
      }
      return wrapped()
    }, { global: true })
  }

  const recordLog = (message: Message, historical: boolean): void => {
    const fiber = message.fiber?.deref()
    captureRecord('runtime.log', LOG_SOURCE, {
      loggerSeq: message.sn,
      timestampMs: message.ts,
      logger: message.name,
      level: message.type,
      numericLevel: message.level,
      historical,
      args: message.args,
      ...(fiber ? { fiber: { uid: fiber.uid, name: fiber.name, state: fiber.state } } : {}),
    }, message.args, 'logs')
  }

  if (config.captureLogs) {
    for (const message of ctx.logger.buffer) recordLog(message, true)
    ctx.logger.exporter({ export: (message) => recordLog(message, false) })
  }

  try {
    const sessions = ctx.get('sessions', false) as { list?: () => Array<{ id?: string; events?: readonly unknown[] }> } | undefined
    for (const session of sessions?.list?.() ?? []) {
      captureRecord('session.adopted', SESSION_SOURCE, { sessionId: session.id, historicalEvents: session.events?.length ?? 0 }, session)
      for (const event of session.events ?? []) {
        recordSessionEvent(session.id ?? '[unknown]', event)
      }
    }
  } catch (error) {
    captureRecord('capture.error', REFLECTION_SOURCE, { operation: 'session-adoption-sweep', error })
  }

  // Snapshots are event-driven (plus startup/shutdown). Do not sample on a
  // wall-clock interval: periodic snapshots duplicate unchanged state and
  // inflate the trace without adding evidence.
  await captureSnapshot('startup')

  return async () => {
    if (stopping) return
    stopping = true
    if (debounceTimer) clearTimeout(debounceTimer)
    stopping = false
    await captureSnapshot('shutdown')
    stopping = true
    for (const sessionId of pending.keys()) flushSession(sessionId)
    for (const item of pendingResults) flushToolResult(item)
    captureRecord('probe.stop', REFLECTION_SOURCE, { reason: 'plugin-dispose', writerFailure: writer.failure?.message ?? null,
      filtering: { policy: 'session-semantic-v2', counts: filtering } })
    await writer.updateManifest({
      probe: {
        state: writer.failure ? 'failed' : 'stopped',
        filtering: { policy: 'session-semantic-v2', counts: filtering },
        stoppedAt: new Date().toISOString(),
        ...(writer.failure ? { error: writer.failure.message } : {}),
      },
    })
    await writer.close(writer.failure ? 'partial' : 'completed')
  }
}

export default apply
