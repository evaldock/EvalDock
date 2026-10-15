import {spawnSync} from 'node:child_process';
import {selectPython} from '../../scripts/run-python-tests.mjs';
const selected=selectPython();
const result=spawnSync(selected.command,[...selected.prefix,'-c','import sys; print(sys.executable)'],{encoding:'utf8',timeout:5000,windowsHide:true});
if(result.error||result.status!==0||!result.stdout.trim())throw Error('Cannot resolve the selected Python 3 interpreter');
export const pythonExecutable=result.stdout.trim();
