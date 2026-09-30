/**
 * Replay a REAL DSH archive; never starts an Agent or substitutes a fixture Judge.
 * Usage: node scripts/replay-session-capture.mjs ARCHIVE REPORT_JSON DSH_INSTALL_ROOT
 * Prints only verification/statistics. Does not rewrite the archive or historical report.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { dshSessionsToProbeJsonl, readDshSessionArchive } from '../dist/src/runtime/dsh-session-trace.js';
import { Snapshotter } from '../src/agent-trace/native-probe/lib/snapshot.js';
import { parseProbeJsonl } from '../dist/src/agent-trace/reader.js';
import { reduceSessionEvents, packSessionDeltas, isStreamRecord } from '../src/agent-trace/native-probe/lib/session-events.js';

const [archivePath, reportPath, dshRoot] = process.argv.slice(2);
assert(archivePath && reportPath && dshRoot, 'Supply real archive, report.json and DSH installation root');
const { decodeStorageRecord } = await import(pathToFileURL(join(resolve(dshRoot),
  'node_modules/@deepseek-ai/dsh-session/lib/types/chunk-rows.js')).href);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
assert.equal(report.fixture, false, 'Verification requires a real run report');
const archive = await readDshSessionArchive(archivePath, 256 * 1024 * 1024);
assert.equal(archive.truncated, false);
const rows = archive.jsonl.trim().split('\n').map(JSON.parse);
const header = rows.shift();
assert.equal(header.type, 'session');
const decoded = rows.flatMap(decodeStorageRecord);
const previous = report.allTrace.entries.filter(entry => entry.layer === 'AGENT');
const first = previous[0].content;
const last = previous.at(-1).content;
assert(first.data.sessionIds.includes(header.id));
const input = {
  sessions: [{ sessionId: header.id, jsonl: archive.jsonl }],
  sourceRunId: first.runId, pid: first.pid, startedAt: first.at, endedAt: last.at,
};
const result = dshSessionsToProbeJsonl(input);
const envelopes = result.toString().trim().split('\n').map(JSON.parse);
assert.deepEqual(envelopes[0].captureDiagnostics.issues, []);
const retained = envelopes.filter(event => event.kind === 'session/event').map(event => event.data.event);
const committed = values => values.filter(event => !isStreamRecord(event));
// Every non-stream semantic event (including unknown plugin events) must remain byte-for-byte equivalent.
assert.deepEqual(committed(retained), committed(rows));
const decodedReduced = reduceSessionEvents(decoded);
assert.deepEqual(retained.flatMap(decodeStorageRecord), decodedReduced.records);
assert.deepEqual(packSessionDeltas(decoded).flatMap(decodeStorageRecord), decoded);
const doubled = reduceSessionEvents([...decoded, ...decoded]);
assert.deepEqual(doubled.records, decodedReduced.records);

// Replay a real interrupted prefix: its current step has no assistant/message yet.
const cutoff = decoded.findLastIndex(event => event.type === 'assistant/message');
const prefix = decoded.slice(0, cutoff);
const unfinished = prefix.filter(event => event.type === 'assistant/chunk' &&
  event.data.turn === decoded[cutoff].data.turn && event.data.step === decoded[cutoff].data.step);
assert(unfinished.length > 0);
const prefixOutput = reduceSessionEvents(prefix).records;
assert.deepEqual(prefixOutput.filter(event => unfinished.some(original => original.seq === event.seq)), unfinished);
assert.deepEqual(packSessionDeltas(prefixOutput).flatMap(decodeStorageRecord), prefixOutput);
// Same actual event with a conflicting sequence payload must be retained and diagnosed.
const conflict = { ...decoded[0], time: decoded[0].time + 1 };
assert.equal(reduceSessionEvents([decoded[0], conflict]).stats.conflictingSequences, 1);
const missingRows = [header, ...rows.filter((_, index) => index !== 1)];
const damaged = dshSessionsToProbeJsonl({ ...input, sessions: [{ sessionId: header.id,
  jsonl: missingRows.map(row => JSON.stringify(row)).join('\n') }] });
assert(JSON.parse(damaged.toString().split('\n')[0]).captureDiagnostics.issues
  .some(issue => issue.code === 'SESSION_SEQUENCE_GAP_OR_DUPLICATE'));

// Real live delivery order with the Probe's 5s / 512KiB bounds, using recorded timestamps.
let pending = [], pendingBytes = 0, pendingAt;
const live = [];
const liveFlush = committedEvent => {
  const reduced = reduceSessionEvents([...pending, ...(committedEvent ? [committedEvent] : [])]);
  live.push(...packSessionDeltas(reduced.records));
  pending = []; pendingBytes = 0; pendingAt = undefined;
};
for (const event of decoded) {
  if (pending.length && event.time - pendingAt >= 5_000) liveFlush();
  if (!isStreamRecord(event)) { liveFlush(event); continue; }
  if (!pending.length) pendingAt = event.time;
  pending.push(event); pendingBytes += Buffer.byteLength(JSON.stringify(event));
  if (pendingBytes >= 512 * 1024) liveFlush();
}
liveFlush();
assert.deepEqual(committed(live), committed(decoded));
const serializer = new Snapshotter();
let serializationTruncations = 0;
for (const event of live) {
  const captured = serializer.capture({ sessionId: header.id, event });
  serializationTruncations += captured.stats.truncated;
}
assert.equal(serializationTruncations, 0, 'Native serialization must not truncate this real replay');

const parsed = parseProbeJsonl(result, {
  expectedRunId: first.runId, expectedPid: first.pid,
  attemptId: previous[0].observation.attemptId,
  sourceRef: previous[0].observation.sourceRef,
  collectionStatusId: 'collection.session-capture-replay',
  openedAt: first.at, closedAt: last.at, observedAt: last.at,
});
assert.deepEqual(parsed.issues, []);
const jsonlBytes = values => Buffer.byteLength(values.map(value => JSON.stringify(value)).join('\n') + '\n');
const counts = values => values.reduce((result, row) => {
  result[row.type] = (result[row.type] ?? 0) + 1; return result;
}, {});
console.log(JSON.stringify({
  verification: 'REAL_SESSION_ARCHIVE_REPLAY', sessionId: header.id,
  archivePath, archiveSha256: createHash('sha256').update(await readFile(archivePath)).digest('hex'),
  historicalReportUnchanged: true, liveNativeProbeInstalledOrRestarted: false,
  archiveRows: rows.length, expandedSessionEvents: decoded.length,
  previousProbeRecords: previous.length, filteredProbeRecords: envelopes.length,
  previousProbeJsonlBytes: jsonlBytes(previous.map(entry => entry.content)),
  filteredProbeJsonlBytes: result.length,
  filtering: envelopes[0].data.filtering,
  retainedTypes: counts(retained),
  simulatedLiveOrdering: {
    records: live.length, expandedJsonlBytes: jsonlBytes(decoded), retainedJsonlBytes: jsonlBytes(live),
    note: 'Real events/timestamps replayed through pending-buffer policy; not a live plugin installation test',
  },
  checks: {
    allSemanticEventsUnchanged: true, nativeCodecRoundTrip: true, expandedAndPackedReductionAgree: true,
    duplicateReplayDeduplicated: true, interruptedStreamRetained: true,
    conflictingEventsRetained: true, realSequenceGapDetected: true, nativeSerializationTruncations: serializationTruncations, downstreamReaderIssues: parsed.issues,
  },
}, null, 2));
