import {pythonExecutable} from './python-support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {selectCliProfile} from '../../adapters/shared/cli-interface.mjs';
import {inspectHermes} from '../../adapters/hermes/adapter.mjs';
import {piLaunch} from '../../adapters/pi/launch.mjs';
import {temporary} from './support.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPiAdapter} from '../../adapters/pi/adapter.mjs';

test('CLI negotiation uses advertised contracts and excludes evaluator credentials',async()=>{
 const previous=process.env.EVALDOCK_JUDGE_API_KEY;process.env.EVALDOCK_JUDGE_API_KEY='private-judge-fixture';
 try{
  const profiles=[{id:'modern',required:['--query-file','--format'],values:['stream-json']},{id:'archive',required:['--query-file','--oneshot']}];
  for(const [help,id] of [['--query-file --oneshot --format {text,stream-json}','modern'],['--query-file --oneshot','archive']]){
   const selected=await selectCliProfile({command:'/fixture',args:['--help'],profiles,execCommand:async(_,args,options)=>{assert.equal(options.env.EVALDOCK_JUDGE_API_KEY,undefined);assert.deepEqual(args,['--help']);return {stdout:help}}});
   assert.equal(selected.id,id);
  }
  await assert.rejects(selectCliProfile({command:'/fixture',args:['--help'],profiles,execCommand:async()=>({stdout:'--query-file --format text'})}),/INTERFACE_CHANGED/);
 }finally{if(previous===undefined)delete process.env.EVALDOCK_JUDGE_API_KEY;else process.env.EVALDOCK_JUDGE_API_KEY=previous;}
});
test('older Hermes can select its owned native archive without a JSON stdout flag',async()=>{
 const s=await inspectHermes({name:'Hermes',sourceRoot:'/fixture',executable:'/fixture/hermes'},{loadEnvironment:async()=>({}),execCommand:async(_,args)=>({stdout:args[0]==='--version'?'Hermes 0.21.3':'--query-file --oneshot --provider --model --toolsets --ignore-rules --max-turns'})});
 assert.equal(s.evaluationReady,true);assert.equal(s.protocol.id,'hermes.native-archive/v1');
});
test('Pi omits unavailable optional flags while retaining isolated runtime and explicit extensions',async t=>{
 const home=await temporary(t);
 const launch=await piLaunch({executable:'/fixture/pi',model:'fixture'},{extensions:[],protocol:{id:'pi.json-stream/v1',flags:['--mode','--print','--no-session','--provider','--model']}},home);
 assert.ok(!launch.args.includes('--no-context-files'));assert.ok(!launch.args.includes('--no-themes'));
 assert.ok(launch.args.includes('--no-session'));assert.equal(launch.env.PI_CODING_AGENT_DIR,path.join(home,'.pi','agent'));
});

test('Pi print execution accepts both credential grammars and protects literal prompt arguments',async t=>{
 const root=await temporary(t),executable=path.join(root,'pi.mjs');
 // The older print parser rejects the terminator and interprets a leading @ as a file.
 await writeFile(executable,`import {readFileSync} from 'node:fs';import path from 'node:path';
 const args=process.argv.slice(2),prompt=args.at(-1);
 if(args.includes('--')||prompt.startsWith('@')||prompt.startsWith('-')){process.stderr.write('Error: Unknown option or file argument');process.exit(1);}
 const models=JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'models.json')));
 const reference=models.providers['deepseek-evaldock'].apiKey;
 const key=process.env.FIXTURE_GRAMMAR==='legacy'?process.env[reference]:reference.startsWith('$')?process.env[reference.slice(1)]:reference;
 if(key!=='fixture-target-key'){process.stderr.write('Authentication failed');process.exit(1);}
 console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'READY'}],stopReason:'stop'}}));
 console.log(JSON.stringify({type:'agent_end'}));
 `);
 const adapter=createPiAdapter({id:'fixture-pi',kind:'pi',name:'Pi',executable});
 const cwd=path.join(root,'work');await mkdir(cwd);
 for(const grammar of ['legacy','template']){
  const result=await adapter.run({context:{env:{DEEPSEEK_API_KEY:'fixture-target-key',FIXTURE_GRAMMAR:grammar},inspection:{extensions:[],protocol:{flags:['--mode','--print','--no-session','--provider','--model']}}},caseDirectory:root,cwd,prompt:'@public-input contains --literal text',deadlineMs:5000});
  assert.equal(result.error,null,grammar);assert.equal(result.final,'READY');assert.equal(result.cleanup,'STOPPED');
 }
});

test('native Hermes completion is accepted only from one completed owned session',async t=>{
 const {execFileSync}=await import('node:child_process');
 const {restoreHermesEvidence}=await import('../../adapters/hermes/adapter.mjs');
 const root=await temporary(t),file=root+'/session.db';
 const reader=fileURLToPath(new URL('../../adapters/hermes/session-evidence.py',import.meta.url));
 const create=`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.executescript("CREATE TABLE sessions(id TEXT,ended_at REAL);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,content TEXT,timestamp REAL,finish_reason TEXT);INSERT INTO sessions VALUES('owned',1);INSERT INTO messages VALUES(1,'owned','assistant',NULL,NULL,NULL,'delivered',1,'stop');");c.commit()`;
 execFileSync(pythonExecutable,['-c',create,file]);
 const evidence=JSON.parse(execFileSync(pythonExecutable,[reader,file,'--session-archive'],{encoding:'utf8'}));
 assert.equal(evidence.sessionId,'owned');assert.equal(evidence.final,'delivered');
 const captured={queue:[],sessionId:'host-owned',final:evidence.final,result:{stopReason:'end_turn'},cleanup:'STOPPED'};
 assert.equal(restoreHermesEvidence(captured,evidence.rows,{archive:true}).final,'delivered');
 execFileSync(pythonExecutable,['-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"INSERT INTO sessions VALUES('other',1)\");c.commit()",file]);
 assert.throws(()=>execFileSync(pythonExecutable,[reader,file,'--session-archive'],{stdio:'pipe'}));
});

test('Doubao binds moved named contracts and rejects ambiguous or changed exports',async()=>{
 const {doubaoModule}=await import('../../adapters/doubaowork/interface.mjs');
 const installed={9001:{getIsLoggedIn:()=>true},9002:{getIsLoggedIn:()=>false}};
 const r=id=>installed[id];r.m={9001:function(){return {getIsLoggedIn(){}}}};
 const spec={id:35673,properties:{getIsLoggedIn:'function'},marker:'getIsLoggedIn'};
 assert.equal(doubaoModule(r,spec),installed[9001]);
 r.m[9002]=function(){return {getIsLoggedIn(){}}};
 assert.throws(()=>doubaoModule(r,spec),/INTERFACE_AMBIGUOUS/);
 delete r.m[9002];installed[9001]={getIsLoggedIn:true};
 assert.throws(()=>doubaoModule(r,spec),/INTERFACE_CHANGED/);
});

test('custom-scheme desktop endpoints cannot borrow another installation version',async()=>{
 const {assertDesktopOwner}=await import('../../adapters/shared/desktop-owner.mjs');
 let executable='/Applications/Selected.app/Contents/MacOS/Client';
 const deps={resolvePath:async p=>p,execCommand:async command=>({stdout:command.endsWith('lsof')?'p42\nf1\n':executable+'\n'})};
 await assertDesktopOwner('http://127.0.0.1:18493','/Applications/Selected.app',deps);
 executable='/Applications/OtherVersion.app/Contents/MacOS/Client';
 await assert.rejects(assertDesktopOwner('http://127.0.0.1:18493','/Applications/Selected.app',deps),/APP_MISMATCH/);
 await assert.rejects(assertDesktopOwner('https://remote.invalid','/Applications/Selected.app',deps),/INVALID_ENDPOINT/);
});

test('office discovery connects distinct installations without overwriting an existing version',async t=>{
 const {scanLocalAgents}=await import('../../workbench/lib/agent-discovery.mjs');
 const {startControlServer}=await import('../../workbench/control-server.mjs');
 const {readFile}=await import('node:fs/promises');
 const root=await temporary(t),appRoots=[path.join(root,'Apps A'),path.join(root,'Apps B')];
 for(const dir of appRoots)await mkdir(path.join(dir,'QwenWorkCN.app'),{recursive:true});
 const snapshot=await scanLocalAgents({home:root,pathValue:'',systemBins:[],appRoots,readInfo:async app=>({CFBundleIdentifier:'cn.qwenwork.desktop.mac',CFBundleShortVersionString:app.startsWith(appRoots[0])?'1.2.1':'1.2.5'})});
 const entries=snapshot.agents.filter(a=>a.kind==='qwenwork');assert.equal(entries.length,2);
 assert.ok(entries.every(a=>a.target?.appPath===a.path));assert.deepEqual(entries.map(a=>a.version).sort(),['1.2.1','1.2.5']);
 const existing={...entries[0].target,id:'configured',name:'Keep my version',endpoint:'http://127.0.0.1:19100'};
 await mkdir(path.join(root,'config'));await writeFile(path.join(root,'config/agents.json'),JSON.stringify({schema:'evaldock.agent-targets/v1',targets:[existing]}));
 const quiet={active:false,records:async()=>({jobs:[],runs:[]})};let refreshed=0;
 const {server}=await startControlServer({root,port:0,controller:{status:async()=>({jobs:[],runs:[]})},workbuddyController:quiet,agentControllers:{qwenwork:{...quiet,refreshTargets:async()=>{refreshed++;}}},discoveryService:{scan:async()=>snapshot}});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,csrf=(await(await fetch(base+'/api/control/status')).json()).csrf;
 const connect=()=>fetch(base+'/api/control/discovery/connect',{method:'POST',headers:{'content-type':'application/json','x-workbench-token':csrf},body:JSON.stringify({id:entries[1].id})});
 assert.equal((await connect()).status,200);assert.equal((await connect()).status,200);
 const saved=JSON.parse(await readFile(path.join(root,'config/agents.json'),'utf8')).targets;
 assert.equal(saved.length,2);assert.deepEqual(saved[0],existing);assert.equal(saved[1].appPath,entries[1].path);assert.equal(refreshed,2);
});

test('a cold Graph startup timeout is distinct from a missing streaming interface',async t=>{
 const {inspectLangGraph}=await import('../../adapters/langgraph/adapter.mjs');
 const root=await temporary(t);
 const result=await inspectLangGraph({name:'Graph',sourceRoot:root,python:'python',entrypoint:root+'/entry.py:create_graph'},{loadEnvironment:async()=>({}),execCommand:async()=>{const error=new Error('timed out');error.killed=true;error.signal='SIGTERM';throw error;}});
 assert.equal(result.evaluationReady,false);assert.equal(result.reasonCode,'LANGGRAPH_STARTUP_TIMEOUT');
});

test('desktop receipts bind native executable bytes even without app.asar',async t=>{
 const {fingerprint}=await import('../../adapters/compatibility/identity.mjs');
 const root=await temporary(t),app=path.join(root,'Native.app'),executable=path.join(app,'Contents/MacOS/Client');
 await mkdir(path.dirname(executable),{recursive:true});await writeFile(path.join(app,'Contents/Info.plist'),'synthetic metadata');await writeFile(executable,'synthetic build A');
 const adapter={kind:'doubaowork',targetId:'native-fixture'},inspection={version:'same-version',installRoot:app,executable,protocol:{id:'doubao.office-services/v1'}};
 const first=await fingerprint(adapter,inspection);await writeFile(executable,'synthetic build B');
 const second=await fingerprint(adapter,inspection);assert.notEqual(first.digest,second.digest);
 assert.ok(first.identity.files.some(([name])=>name===executable));
});
