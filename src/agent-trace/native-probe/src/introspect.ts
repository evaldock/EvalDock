import type { Context } from '@deepseek-ai/cordis'
import { SNAPSHOT_SCHEMA, type FiberSnapshot, type JsonObject, type JsonValue, type RuntimeSnapshot, type ServiceSnapshot } from './types.js'
import { Snapshotter } from './snapshot.js'

const FIBER_STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'UNLOADING', 'DISPOSED'] as const

type LooseContext = Context & Record<string, unknown>
export interface LooseFiber {
  uid: number | null
  name: string
  state: number
  parent: Context
  inject: Record<string, unknown>
  config: unknown
  runtime: { name?: string } | null
  _error?: unknown
  getEffects?: () => unknown
  store?: Record<string, { name?: string }>
}

interface ImplLike {
  name?: string
  fiber?: LooseFiber
  value?: unknown
  check?: () => boolean
}

function errorJson(error: unknown): JsonValue {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack ?? '' }
  return { message: String(error) }
}

function stringifySymbol(symbol: symbol): string {
  return symbol.description ? `Symbol(${symbol.description})` : String(symbol)
}

function fiberState(code: number): string {
  return FIBER_STATES[code] ?? `UNKNOWN(${code})`
}

function safeCall<T>(errors: JsonValue[], label: string, callback: () => T, fallback: T): T {
  try {
    return callback()
  } catch (error) {
    errors.push({ operation: label, error: errorJson(error) })
    return fallback
  }
}

function objectShape(value: unknown): ServiceSnapshot['shape'] {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return { constructor: typeof value, ownProperties: [], methods: [] }
  }
  const ownProperties = Reflect.ownKeys(value).map(String).sort()
  const methods = new Set<string>()
  let cursor: object | null = value
  let depth = 0
  while (cursor && cursor !== Object.prototype && depth++ < 8) {
    for (const key of Reflect.ownKeys(cursor)) {
      if (key === 'constructor') continue
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key)
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') methods.add(String(key))
    }
    cursor = Object.getPrototypeOf(cursor) as object | null
  }
  return {
    constructor: (value as { constructor?: { name?: string } }).constructor?.name ?? typeof value,
    ownProperties,
    methods: [...methods].sort(),
  }
}

export function listFibers(ctx: Context): LooseFiber[] {
  const fibers: LooseFiber[] = []
  const seen = new Set<LooseFiber>()
  const root = ctx.root.fiber as unknown as LooseFiber
  fibers.push(root)
  seen.add(root)
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers as unknown as Iterable<LooseFiber>) {
      if (!seen.has(fiber)) {
        seen.add(fiber)
        fibers.push(fiber)
      }
    }
  }
  return fibers.sort((a, b) => (a.uid ?? Number.MAX_SAFE_INTEGER) - (b.uid ?? Number.MAX_SAFE_INTEGER))
}

export function snapshotFiber(fiber: LooseFiber, snapshotter: Snapshotter): FiberSnapshot {
  const provided = Object.values(fiber.store ?? {}).map((impl) => impl?.name).filter((name): name is string => Boolean(name)).sort()
  let effects: JsonValue = []
  try {
    effects = snapshotter.capture(fiber.getEffects?.() ?? []).value
  } catch (error) {
    effects = { $type: 'capture-error', message: error instanceof Error ? error.message : String(error) }
  }
  return {
    uid: fiber.uid,
    name: fiber.name,
    state: fiberState(fiber.state),
    stateCode: fiber.state,
    parentUid: fiber.parent?.fiber?.uid ?? null,
    inject: Object.keys(fiber.inject ?? {}).sort(),
    provide: provided,
    config: snapshotter.capture(fiber.config).value,
    effects,
    ...(fiber._error === undefined ? {} : { error: snapshotter.capture(fiber._error).value }),
  }
}

export function snapshotServices(ctx: Context, snapshotter: Snapshotter, includeValues: boolean): ServiceSnapshot[] {
  const output: ServiceSnapshot[] = []
  for (const label of Reflect.ownKeys(ctx.reflect.store)) {
    const impl = (ctx.reflect.store as unknown as Record<symbol, ImplLike>)[label as symbol]
    if (!impl?.name) continue
    let active = impl.fiber?.state === 2
    try {
      if (impl.check) active = active && Boolean(impl.check())
    } catch {
      active = false
    }
    output.push({
      name: impl.name,
      isolation: typeof label === 'symbol' ? stringifySymbol(label) : String(label),
      providerFiberUid: impl.fiber?.uid ?? null,
      providerPlugin: impl.fiber?.name ?? 'unknown',
      active,
      shape: objectShape(impl.value),
      ...(includeValues ? { value: snapshotter.capture(impl.value).value } : {}),
    })
  }
  return output.sort((a, b) => a.name.localeCompare(b.name) || a.isolation.localeCompare(b.isolation))
}

function idOf(value: unknown): string {
  if (!value || typeof value !== 'object') return 'unknown'
  try {
    const id = (value as Record<string, unknown>).id
    return typeof id === 'string' ? id : String(id ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

function getService(ctx: Context, name: string): unknown {
  try {
    return ctx.get(name, false)
  } catch {
    return undefined
  }
}

function listService(ctx: Context, name: string, errors: JsonValue[]): unknown[] {
  const service = getService(ctx, name) as { list?: () => unknown[] } | undefined
  if (!service || typeof service.list !== 'function') return []
  return safeCall(errors, `${name}.list()`, () => service.list?.() ?? [], [])
}

function snapshotDeclaredProperties(ctx: Context): Array<{ name: string; type: string }> {
  return Object.entries(ctx.reflect.props)
    .map(([name, value]) => ({ name, type: value.type }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function snapshotEventListeners(ctx: Context): RuntimeSnapshot['eventListeners'] {
  const hooks = ctx.events._hooks as Record<string | symbol, Array<{ ctx?: Context }>>
  return Reflect.ownKeys(hooks).map((event) => {
    const entries = hooks[event] ?? []
    const owners = entries.map((entry) => entry.ctx?.fiber?.name ?? 'unknown')
    return { event: typeof event === 'symbol' ? stringifySymbol(event) : event, listeners: entries.length, owners }
  }).sort((a, b) => a.event.localeCompare(b.event))
}

export function buildRuntimeSnapshot(
  ctx: Context,
  snapshotter: Snapshotter,
  reason: string,
  includeServiceValues: boolean,
): RuntimeSnapshot {
  const errors: JsonValue[] = []
  const rawAgents = listService(ctx, 'agents', errors)
  const rawSessions = listService(ctx, 'sessions', errors)
  const agents = rawAgents.map((agent) => snapshotter.capture(agent).value)
  const sessions = rawSessions.map((session) => snapshotter.capture(session).value)

  const toolsService = getService(ctx, 'tools') as { schemas?: (scope?: unknown) => unknown[] } | undefined
  const tools = toolsService && typeof toolsService.schemas === 'function'
    ? safeCall(errors, 'tools.schemas()', () => toolsService.schemas?.() ?? [], []).map((tool) => snapshotter.capture(tool).value)
    : []
  const scopedTools = rawAgents.map((agent) => ({
    agentId: idOf(agent),
    tools: toolsService && typeof toolsService.schemas === 'function'
      ? safeCall(errors, `tools.schemas(${idOf(agent)})`, () => toolsService.schemas?.(agent) ?? [], []).map((tool) => snapshotter.capture(tool).value)
      : [],
  }))
  const workspaces = listService(ctx, 'workspaceRegistry', errors).map((item) => snapshotter.capture(item).value)

  const optionalSurfaces: JsonObject = {}
  for (const name of ['llm', 'systemPrompt', 'compaction', 'subagents', 'approval', 'authorization', 'sandbox', 'sessionPersistence', 'sessionProjection', 'telemetry', 'skills', 'commands', 'jobs', 'storage']) {
    const value = getService(ctx, name)
    optionalSurfaces[name] = value === undefined
      ? { available: false }
      : { available: true, shape: snapshotter.capture(objectShape(value)).value }
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    capturedAt: new Date().toISOString(),
    reason,
    fibers: listFibers(ctx).map((fiber) => snapshotFiber(fiber, snapshotter)),
    services: snapshotServices(ctx, snapshotter, includeServiceValues),
    declaredProperties: snapshotDeclaredProperties(ctx),
    eventListeners: snapshotEventListeners(ctx),
    agents,
    sessions,
    tools,
    scopedTools,
    workspaces,
    optionalSurfaces,
    captureErrors: errors,
  }
}

export function buildRuntimeCatalog(snapshot: RuntimeSnapshot): JsonObject {
  return {
    schema: 'evaldock.runtime-catalog/v1',
    capturedAt: snapshot.capturedAt,
    plugins: snapshot.fibers.map((fiber) => ({ uid: fiber.uid, name: fiber.name, state: fiber.state })),
    services: snapshot.services.map((service) => ({
      name: service.name,
      providerPlugin: service.providerPlugin,
      providerFiberUid: service.providerFiberUid,
      isolation: service.isolation,
      active: service.active,
      methods: service.shape.methods,
    })),
    declaredProperties: snapshot.declaredProperties,
    registeredEvents: snapshot.eventListeners,
    tools: snapshot.tools,
    scopedTools: snapshot.scopedTools,
  }
}

export function buildIntegrationMap(snapshot: RuntimeSnapshot): JsonObject {
  const providers = new Map<string, Array<{ uid: number | null; plugin: string }>>()
  for (const service of snapshot.services) {
    const entries = providers.get(service.name) ?? []
    entries.push({ uid: service.providerFiberUid, plugin: service.providerPlugin })
    providers.set(service.name, entries)
  }
  return {
    schema: 'evaldock.integration-map/v1',
    capturedAt: snapshot.capturedAt,
    plugins: snapshot.fibers.map((fiber) => ({
      uid: fiber.uid,
      plugin: fiber.name,
      state: fiber.state,
      provides: fiber.provide,
      requires: fiber.inject.map((service) => ({ service, providers: providers.get(service) ?? [] })),
      parentUid: fiber.parentUid,
    })),
  }
}
