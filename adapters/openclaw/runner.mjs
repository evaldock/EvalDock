import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
const [node,cli,...args]=process.argv.slice(2),emit=r=>process.stdout.write(JSON.stringify(r)+'\n');
const child=spawn(node,[cli,...args],{env:process.env,stdio:['ignore','pipe','pipe']});
let output='',overflow=false,diagnostic='';const decoder=new StringDecoder('utf8');
child.stderr.on('data',b=>{diagnostic=(diagnostic+b.toString('utf8')).slice(-4000);});
child.stdout.on('data',b=>{const s=decoder.write(b);if(!overflow){output+=s;if(Buffer.byteLength(output)>512*1024){overflow=true;output='';}}});
child.once('error',()=>{emit({type:'runtime/error',data:{code:'OPENCLAW_PROCESS_START_FAILED'}});process.exitCode=1;});
child.once('close',code=>{
 output+=decoder.end();
 try{if(overflow)throw Error('OUTPUT_LIMIT');emit({type:'runtime/result',data:JSON.parse(output)});process.exitCode=code??1;}
 catch{emit({type:'runtime/error',data:{code:overflow?'OPENCLAW_OUTPUT_LIMIT':'OPENCLAW_RESULT_INVALID',exitCode:code,diagnostic}});process.exitCode=1;}
});
// EvalDock owns and terminates the detached process group, including descendants.
