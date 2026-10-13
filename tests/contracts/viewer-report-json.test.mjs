import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdir, writeFile, readFile, rm, symlink, open} from 'node:fs/promises';
import path from 'node:path';
import {temporary} from './support.mjs';
import {startViewer} from '../../dist/src/platform/viewer.js';
import {renderReportHtml} from '../../dist/src/reporting/html.js';
import {buildResult, serializeReportDocument} from '../../dist/src/reporting/record.js';

// Use raw request paths so traversal cases are not normalized by fetch/URL.
function http(viewer, target, {method = 'GET', headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const req = request({hostname: viewer.host, port: viewer.port, path: target, method, headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Viewer request timed out')));
    req.end();
  });
}

async function fixture(t, check) {
  const root = await temporary(t), runId = 'viewer.contract';
  const runRoot = path.join(root, 'runs'), reportRoot = path.join(root, 'reports');
  const reportDir = path.join(reportRoot, runId), runDir = path.join(runRoot, runId);
  await mkdir(reportDir, {recursive: true});
  await mkdir(runDir, {recursive: true});
  const report = buildResult({runId, scope: {targetId: 'target.fixture', targetSnapshotId: 'snapshot.fixture',
    runId, caseId: 'case.fixture', attemptId: 'attempt.fixture'}, target: {}, labels: [], scores: [],
    dimensions: [], timeline: [], artifacts: [], currentPhase: 'REPORTED', runState: 'COMPLETED',
    operationalHealth: 'HEALTHY', fixture: true, securityIsolation: 'FIXTURE',
    environmentState: 'FIXTURE', failures: [], case: {task: '只读报告契约样例'}}, '2026-10-13T00:00:00Z');
  const json = Buffer.from(serializeReportDocument(report));
  const html = Buffer.from(renderReportHtml(report));
  const status = Buffer.from('<!doctype html><title>Fixture status</title>');
  await writeFile(path.join(reportDir, 'report.json'), json);
  await writeFile(path.join(reportDir, 'report.html'), html);
  await writeFile(path.join(runDir, 'status.html'), status);
  const viewer = await startViewer({runRoot, reportRoot, runId, port: 0});
  try { await check({viewer, root, reportRoot, reportDir, json, html, status}); }
  finally { await viewer.close(); }
}

test('Viewer serves the actual rendered report.json link from both report entry points', async t => {
  await fixture(t, async ({viewer, reportDir}) => {
    for (const entry of ['/', '/report']) {
      const page = await http(viewer, entry);
      assert.equal(page.status, 200);
      const link = page.body.toString().match(/href="(report\.json)"/);
      assert.ok(link, 'The report renderer must provide the JSON link');
      const target = new URL(link[1], new URL(entry, viewer.url)).pathname;
      const response = await http(viewer, target);
      assert.equal(response.status, 200, `${entry} -> ${target}`);
      assert.deepEqual(response.body, await readFile(path.join(reportDir, 'report.json')));
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(Number(response.headers['content-length']), response.body.length);
      for (const header of ['cache-control', 'content-security-policy', 'x-content-type-options', 'cross-origin-resource-policy']) {
        assert.ok(page.headers[header]);
        assert.equal(response.headers[header], page.headers[header]);
      }
    }
  });
});

test('Viewer report.json HEAD has GET metadata and no body', async t => {
  await fixture(t, async ({viewer, json}) => {
    const response = await http(viewer, '/report.json', {method: 'HEAD'});
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(Number(response.headers['content-length']), json.length);
    assert.equal(response.body.length, 0);
  });
});

for (const failure of ['missing', 'file-symlink', 'run-symlink', 'oversized']) {
  test(`Viewer rejects ${failure} report.json without serving contents`, async t => {
    await fixture(t, async ({viewer, root, reportDir, json}) => {
      const file = path.join(reportDir, 'report.json');
      if (failure === 'run-symlink') {
        const outside = path.join(root, 'outside');
        await mkdir(outside);
        await writeFile(path.join(outside, 'report.json'), json);
        await rm(reportDir, {recursive: true});
        await symlink(outside, reportDir);
      } else {
        await rm(file);
        if (failure === 'file-symlink') {
          const outside = path.join(root, 'outside.json');
          await writeFile(outside, json);
          await symlink(outside, file);
        } else if (failure === 'oversized') {
          const handle = await open(file, 'w');
          try { await handle.truncate(64 * 1024 * 1024 + 1); }
          finally { await handle.close(); }
        }
      }
      for (const method of ['GET', 'HEAD']) {
        const response = await http(viewer, '/report.json', {method});
        assert.equal(response.status, 404);
        assert.ok(!response.body.includes(json));
        if (method === 'HEAD') assert.equal(response.body.length, 0);
      }
    });
  });
}

test('Viewer keeps arbitrary files and raw traversal paths unavailable', async t => {
  await fixture(t, async ({viewer, reportRoot, reportDir}) => {
    const secret = 'UNEXPOSED_FIXTURE_CONTENT';
    await writeFile(path.join(reportDir, 'private.json'), secret);
    await mkdir(path.join(reportRoot, 'other'));
    await writeFile(path.join(reportRoot, 'other', 'report.json'), secret);
    for (const target of ['/private.json', '/other/report.json', '/../other/report.json',
      '/%2e%2e/other/report.json', '/output/../../other/report.json',
      '/output/%2e%2e/%2e%2e/other/report.json', '/output/%2e%2e%5cprivate.json',
      '/report.json/../private.json', '/report.json%2f..%2fprivate.json']) {
      const response = await http(viewer, target);
      assert.equal(response.status, 404, target);
      assert.ok(!response.body.includes(secret), target);
    }
  });
});

test('Viewer preserves method and Host restrictions for report.json', async t => {
  await fixture(t, async ({viewer, json}) => {
    const post = await http(viewer, '/report.json', {method: 'POST'});
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.ok(!post.body.includes(json));
    const foreign = await http(viewer, '/report.json', {headers: {Host: 'example.invalid'}});
    assert.equal(foreign.status, 421);
    assert.ok(!foreign.body.includes(json));
  });
});

test('Viewer keeps existing report, status and evidence routes working', async t => {
  await fixture(t, async ({viewer, reportDir, html, status}) => {
    const files = {
      'report-data.js': 'globalThis.fixture = true;',
      'all-trace/manifest.json': '{"fixture":true}',
      'all-trace/events.jsonl': '{"event":"fixture"}\n',
      ['all-trace/blobs/' + 'a'.repeat(64)]: '{"blob":"fixture"}',
      'output/answer.txt': 'fixture output'
    };
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(reportDir, relative)), {recursive: true});
      await writeFile(path.join(reportDir, relative), content);
    }
    const routes = {'/': html, '/report': html, '/status': status,
      ...Object.fromEntries(Object.entries(files).map(([file, content]) => ['/' + file, Buffer.from(content)]))};
    for (const [target, bytes] of Object.entries(routes)) {
      const response = await http(viewer, target);
      assert.equal(response.status, 200, target);
      assert.deepEqual(response.body, bytes, target);
      const head = await http(viewer, target, {method: 'HEAD'});
      assert.equal(head.status, 200, target);
      assert.equal(Number(head.headers['content-length']), bytes.length, target);
      assert.equal(head.body.length, 0, target);
      if (target.startsWith('/output/')) assert.equal(response.headers['content-disposition'], 'attachment');
      if (target === '/report-data.js') assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
    }
  });
});
