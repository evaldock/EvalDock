import {readdirSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Explicit argv works in cmd.exe, PowerShell and Unix shells alike.
const directory=path.resolve('tests/contracts');
const files=readdirSync(directory).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>path.join(directory,name));
if(!files.length)throw Error('No contract tests found');
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
