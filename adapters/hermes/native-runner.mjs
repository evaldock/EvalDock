// Older Hermes writes native SQLite evidence instead of JSON stdout. Discard all console text.
import {spawn} from 'node:child_process';
const [command,...args]=process.argv.slice(2);
const child=spawn(command,args,{env:process.env,stdio:['ignore','ignore','ignore']});
child.once('error',()=>{process.stdout.write(JSON.stringify({type:'native-exit',exit_code:1})+'\n');process.exitCode=1;});
child.once('close',code=>{process.stdout.write(JSON.stringify({type:'native-exit',exit_code:code})+'\n');process.exitCode=code??1;});
