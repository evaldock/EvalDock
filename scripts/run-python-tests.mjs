import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export function selectPython({platform=process.platform,environment=process.env,run=spawnSync}={}){
  const candidates=environment.EVALDOCK_PYTHON?[[environment.EVALDOCK_PYTHON,[]]]:platform==='win32'?[['python',[]],['py',['-3']],['python3',[]]]:[['python3',[]],['python',[]]];
  for(const [command,prefix] of candidates){
    const result=run(command,[...prefix,'-c','import sys; print(sys.version_info.major)'],{encoding:'utf8',timeout:5000,windowsHide:true});
    if(!result.error&&result.status===0&&result.stdout.trim()==='3')return {command,prefix};
  }
  throw Error('Python 3 is required; set EVALDOCK_PYTHON to its executable path.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {command,prefix}=selectPython();
  console.log('Python test interpreter:',command,...prefix);
  const result=spawnSync(command,[...prefix,'-m','unittest','discover','-s','tests','-p','test_benchdock_import.py'],{stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  // Never retry a failed test suite with a different interpreter.
  process.exitCode=result.status??1;
}
