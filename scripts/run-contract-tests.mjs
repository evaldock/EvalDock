import {readdirSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Explicit argv works in cmd.exe, PowerShell and Unix shells alike.
const directory=path.resolve('tests/contracts');
const files=readdirSync(directory).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>path.join(directory,name));
if(!files.length)throw Error('No contract tests found');
// Fail with a test/file location when a platform-specific fixture never settles.
// This bounds failures; it does not skip tests or relax their assertions.
const result=spawnSync(process.execPath,['--test','--test-timeout=120000',...files],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
