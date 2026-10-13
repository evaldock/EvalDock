import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../../dist/src/app/cli.js', import.meta.url));

async function invoke(t, argv) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'evaldock-cli-help-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  // An empty directory and environment supply no target config or model credentials.
  const result = spawnSync(process.execPath, [cli, ...argv], {
    cwd, env: {}, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.deepEqual(await readdir(cwd), []);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stdout must contain exactly one JSON response');
  return {...result, summary: JSON.parse(lines[0])};
}

for (const alias of ['help', '--help', '-h']) {
  for (const argv of [[alias], ['--', alias]]) {
    test(`CLI help ${JSON.stringify(argv)} works without configuration`, async t => {
      const result = await invoke(t, argv);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.summary.command, 'help');
      assert.deepEqual(result.summary.commands, ['inspect', 'plan', 'run', 'report']);
    });
  }
}

for (const argv of [
  [], ['--'], ['unknown'], ['--', 'unknown'],
  ['help', 'extra'], ['--', 'help', 'extra'],
  ['help', '--'], ['--', 'help', '--'],
  ['--', '--', 'help'], ['--', '--', 'inspect'],
]) {
  test(`CLI rejects invalid arguments ${JSON.stringify(argv)}`, async t => {
    const result = await invoke(t, argv);
    assert.equal(result.status, 4);
    assert.equal(result.summary.status, 'FAILED');
    assert.equal(result.summary.exitCode, 4);
    assert.deepEqual(result.summary.reasonCodes, ['CLI_USAGE']);
    assert.match(result.stderr, /CliUsageError/);
  });
}

for (const argv of [
  ['report', '--run', 'missing'],
  ['--', 'report', '--run', 'missing'],
]) {
  test(`CLI report preserves operation errors ${JSON.stringify(argv)}`, async t => {
    const result = await invoke(t, argv);
    assert.equal(result.status, 4);
    assert.equal(result.summary.command, 'report');
    assert.equal(result.summary.status, 'FAILED');
    assert.equal(result.summary.exitCode, 4);
    assert.deepEqual(result.summary.reasonCodes, ['CLI_OPERATION_FAILED']);
    assert.deepEqual(result.summary.failureGroups, ['infrastructure_error']);
    assert.match(result.stderr, /ENOENT/);
  });
}
