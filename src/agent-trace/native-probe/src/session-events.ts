/**
 * Session 采集去重，不依赖标签。只移除可由同一次提交逐字重建的已知流式片段。
 * 未知字段、未知事件、失败、未提交片段均原样保留。
 */
import { createHash } from 'node:crypto'

export type SessionRecord = Record<string, unknown>
export const objectRecord = (value: unknown): SessionRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as SessionRecord : undefined
const exact = (value: SessionRecord, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const packedTypes = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
export const isStreamRecord = (record: SessionRecord): boolean =>
  record.type === 'assistant/chunk' || packedTypes.has(String(record.type))

/** DSH 0.1.1-rc.2 chunk-rows: dt 有 n-1 项，成员序号为 seq0+k。未知形状不猜测。 */
export function sequenceSpan(record: SessionRecord): { first: number; last: number } | undefined {
  if (!packedTypes.has(String(record.type))) {
    return integer(record.seq) && record.seq >= 0 ? { first: record.seq, last: record.seq } : undefined
  }
  const data = objectRecord(record.data)
  if (!exact(record, ['type', 'seq0', 'time0', 'data']) || !data ||
      !integer(record.seq0) || record.seq0 < 0 || !integer(record.time0)) return undefined
  const tool = record.type === 'tool-call-chunks'
  const keys = tool ? ['turn', 'step', 'index', 'id', 'dt', 'args'] : ['turn', 'step', 'index', 'dt', 'texts']
  if (tool && Object.hasOwn(data, 'name')) keys.push('name')
  if (!exact(data, keys) || !['turn', 'step', 'index'].every(key => typeof data[key] === 'number') ||
      (tool && (typeof data.id !== 'string' || (Object.hasOwn(data, 'name') && typeof data.name !== 'string')))) return undefined
  const parts = tool ? data.args : data.texts
  if (!Array.isArray(parts) || !parts.length || !parts.every(part => typeof part === 'string') ||
      !Array.isArray(data.dt) || data.dt.length !== parts.length - 1 || !data.dt.every(integer)) return undefined
  let time = record.time0
  for (const gap of data.dt) {
    time += gap as number
    if (!Number.isSafeInteger(time)) return undefined
  }
  const last = record.seq0 + parts.length - 1
  return Number.isSafeInteger(last) ? { first: record.seq0, last } : undefined
}

export function eventFingerprint(record: SessionRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

interface Delta {
  index: number
  type: string
  text: string
  id?: string
  name?: string
}
function deltaOf(record: SessionRecord): Delta | undefined {
  const data = objectRecord(record.data)
  if (!data || !sequenceSpan(record)) return undefined
  if (packedTypes.has(String(record.type))) {
    const tool = record.type === 'tool-call-chunks'
    return {
      index: data.index as number,
      type: tool ? 'tool-call' : record.type === 'text-chunks' ? 'text' : 'reasoning',
      text: (tool ? data.args as string[] : data.texts as string[]).join(''),
      ...(tool ? { id: data.id as string } : {}),
      ...(typeof data.name === 'string' ? { name: data.name } : {}),
    }
  }
  if (record.type !== 'assistant/chunk' || !exact(record, ['type', 'seq', 'time', 'data']) ||
      !exact(data, ['turn', 'step', 'chunk'])) return undefined
  const chunk = objectRecord(data.chunk)
  if (!chunk || typeof chunk.index !== 'number') return undefined
  if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
      exact(chunk, ['type', 'index', 'text']) && typeof chunk.text === 'string') {
    return { index: chunk.index, type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text }
  }
  const keys = ['type', 'index', 'id', 'argumentsDelta']
  if (Object.hasOwn(chunk, 'name')) keys.push('name')
  if (chunk.type === 'tool-call-delta' && exact(chunk, keys) &&
      typeof chunk.id === 'string' && typeof chunk.argumentsDelta === 'string' &&
      (!Object.hasOwn(chunk, 'name') || typeof chunk.name === 'string')) {
    return { index: chunk.index, type: 'tool-call', text: chunk.argumentsDelta, id: chunk.id,
      ...(typeof chunk.name === 'string' ? { name: chunk.name } : {}) }
  }
  return undefined
}

export interface ReductionStats {
  inputRecords: number
  duplicateRecords: number
  coveredStreamRecords: number
  retainedStreamRecords: number
  conflictingSequences: number
}

export function reduceSessionEvents(input: readonly SessionRecord[]): {
  records: SessionRecord[]
  stats: ReductionStats
} {
  const stats: ReductionStats = { inputRecords: input.length, duplicateRecords: 0, coveredStreamRecords: 0,
    retainedStreamRecords: 0, conflictingSequences: 0 }
  const seen = new Map<string, string>()
  const conflicts = new Set<string>()
  const records = input.filter(record => {
    const span = sequenceSpan(record)
    if (!span) return true
    const key = `${span.first}:${span.last}`
    const digest = eventFingerprint(record)
    const previous = seen.get(key)
    if (previous === digest) { stats.duplicateRecords++; return false }
    if (previous !== undefined) { stats.conflictingSequences++; conflicts.add(key) }
    seen.set(key, digest)
    return true
  })
  const covered = new Set<SessionRecord>()
  for (const message of records) {
    if (message.type !== 'assistant/message' || !integer(message.seq)) continue
    const data = objectRecord(message.data)
    const content = objectRecord(data?.message)?.content
    if (!data || !Array.isArray(content) || !Array.isArray(message.sourceEventSeqs) ||
        !message.sourceEventSeqs.every(integer)) continue
    const sources = new Set(message.sourceEventSeqs as number[])
    const candidates = records.filter(record => {
      if (!isStreamRecord(record)) return false
      const span = sequenceSpan(record)
      const value = objectRecord(record.data)
      if (!span || conflicts.has(`${span.first}:${span.last}`) || span.last >= (message.seq as number) || !value ||
          value.turn !== data.turn || value.step !== data.step) return false
      for (let seq = span.first; seq <= span.last; seq++) if (!sources.has(seq)) return false
      return true
    })
    const groups = new Map<string, { parts: Delta[]; records: SessionRecord[] }>()
    for (const record of candidates) {
      const delta = deltaOf(record)
      if (!delta) continue
      const key = JSON.stringify([delta.index, delta.type, delta.id])
      const group = groups.get(key) ?? { parts: [], records: [] }
      group.parts.push(delta); group.records.push(record); groups.set(key, group)
    }
    for (const group of groups.values()) {
      const first = group.parts[0]!
      const block = objectRecord(content[first.index])
      if (!block || block.type !== first.type ||
          (first.type === 'tool-call' && (block.id !== first.id ||
            group.parts.some(part => part.name !== undefined && part.name !== block.name)))) continue
      const final = first.type === 'tool-call' ? block.arguments : block.text
      if (typeof final === 'string' && group.parts.map(part => part.text).join('') === final) {
        for (const record of group.records) covered.add(record)
      }
    }
    // 保留 finish/error 等控制事件；只删除与最终 block/usage 严格相同的包装。
    for (const record of candidates) {
      if (record.type !== 'assistant/chunk' || !exact(record, ['type', 'seq', 'time', 'data'])) continue
      const value = objectRecord(record.data)!
      if (!exact(value, ['turn', 'step', 'chunk'])) continue
      const chunk = objectRecord(value.chunk)
      if (!chunk) continue
      const block = typeof chunk.index === 'number' ? content[chunk.index] : undefined
      if (chunk.type === 'block-end' && exact(chunk, ['type', 'index', 'block']) &&
          JSON.stringify(chunk.block) === JSON.stringify(block)) covered.add(record)
      if (chunk.type === 'block-start' && exact(chunk, ['type', 'index', 'blockType']) &&
          chunk.blockType === objectRecord(block)?.type) covered.add(record)
      if (chunk.type === 'usage' && exact(chunk, ['type', 'usage']) &&
          JSON.stringify(chunk.usage) === JSON.stringify(data.usage)) covered.add(record)
    }
  }
  const retained = records.filter(record => {
    if (covered.has(record)) { stats.coveredStreamRecords++; return false }
    if (isStreamRecord(record)) stats.retainedStreamRecords++
    return true
  })
  return { records: retained, stats }
}

/** Uncommitted deltas are packed losslessly, using DSH's existing storage-row vocabulary. */
export function packSessionDeltas(records: readonly SessionRecord[], maxMembers = 500): SessionRecord[] {
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 3) throw new Error("Invalid chunk row member limit")
  const output: SessionRecord[] = []
  let run: SessionRecord[] = []
  let signature: string | undefined
  const flush = (): void => {
    if (run.length < 3) { output.push(...run); run = []; return }
    const first = run[0]!
    const data = objectRecord(first.data)!
    const delta = deltaOf(first)!
    const tool = delta.type === 'tool-call'
    output.push({
      type: tool ? 'tool-call-chunks' : delta.type === 'text' ? 'text-chunks' : 'reasoning-chunks',
      seq0: first.seq, time0: first.time,
      data: {
        turn: data.turn, step: data.step, index: delta.index,
        dt: run.slice(1).map((record, index) => (record.time as number) - (run[index]!.time as number)),
        ...(tool ? { id: delta.id, ...(delta.name !== undefined ? { name: delta.name } : {}),
          args: run.map(record => deltaOf(record)!.text) } : { texts: run.map(record => deltaOf(record)!.text) }),
      },
    })
    run = []
  }
  for (const record of records) {
    const delta = record.type === 'assistant/chunk' ? deltaOf(record) : undefined
    if (!delta || !integer(record.time)) { flush(); output.push(record); signature = undefined; continue }
    const data = objectRecord(record.data)!
    const key = JSON.stringify([data.turn, data.step, delta.type, delta.index, delta.id, delta.name])
    const previous = run.at(-1)
    if (previous && (key !== signature || record.seq !== (previous.seq as number) + 1 ||
        !Number.isSafeInteger(record.time - (previous.time as number)))) flush()
    signature = key
    run.push(record)
    if (run.length >= maxMembers) flush()
  }
  flush()
  return output
}

/** Merge adjacent, valid uncommitted deltas without claiming they were a completed reply. */
export function mergeRemainingStreams(records: readonly SessionRecord[]): SessionRecord[] {
  const output: SessionRecord[] = [];
  let group: {first:SessionRecord; last:number; text:string; delta:Delta; count:number} | undefined;
  const flush=()=> {
    if(!group)return;
    const data=objectRecord(group.first.data)!;
    output.push({type:"assistant/partial-message",seq:sequenceSpan(group.first)!.first,
      time:group.first.time ?? group.first.time0,
      data:{turn:data.turn,step:data.step,partial:true,sourceSeqEnd:group.last,sourceRecords:group.count,
        block:{type:group.delta.type,index:group.delta.index,text:group.text,
          ...(group.delta.id?{id:group.delta.id}:{}),...(group.delta.name?{name:group.delta.name}:{})}}});
    group=undefined;
  };
  for(const record of records) {
    const d=deltaOf(record), span=sequenceSpan(record), data=objectRecord(record.data);
    if(!d||!span||!data){flush();output.push(record);continue;}
    const previous=group&&objectRecord(group.first.data);
    if(group&&(span.first!==group.last+1||previous?.turn!==data.turn||previous?.step!==data.step||
      group.delta.index!==d.index||group.delta.type!==d.type||group.delta.id!==d.id||group.delta.name!==d.name))flush();
    if(group){group.last=span.last;group.text+=d.text;group.count++;}
    else group={first:record,last:span.last,text:d.text,delta:d,count:1};
  }
  flush();return output;
}
