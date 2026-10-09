import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {temporary,json,trace} from './support.mjs';
import {extractToolRegistrations,collectToolProvenance} from '../../dist/src/planning/tool-provenance.js';
import {toolAttribution,renderToolAttribution} from '../../dist/src/reporting/tool-attribution.js';
import {projectRuntime} from '../../workbench/lib/trace-preview.mjs';
import {renderTraceOverview,projectTraceOverview} from '../../dist/src/reporting/trace-overview.js';
import {previewJson} from '../../dist/src/reporting/html-preview.js';
import {reportLoaderSource} from '../../dist/src/reporting/trace-loader.js';

const declaration=(name,plugin,kind='TESTED_PLUGIN')=>({name,attribution:{kind,plugins:[plugin],basis:'STATIC_REGISTRATION',evidence:[{package:plugin,file:'lib/index.js',line:10,sha256:'a'.repeat(64)}]}});
test('static scanner resolves literal registration factories and wrappers without running code',()=>{
 const code=`import {defineTool as tool} from '@deepseek-ai/dsh-tools';
 globalThis.shouldNeverExecute();
 const NAME='sheet_edit';
 function factory(ctx){return tool({name:NAME,description:'Edit a sheet',execute(){throw Error('never run')}})}
 function wrap(definition){return {...definition,output:{render(){}}}}
 ctx.tools.register(wrap(factory(ctx)));
 // ctx.tools.register({name:'comment_only'})
 other.register({name:'unrelated'});
 ctx.tools.register({name:process.env.DYNAMIC_TOOL});`;
 const result=extractToolRegistrations(code,'index.js');
 assert.equal(result.length,1);assert.equal(result[0].name,'sheet_edit');assert.equal(result[0].description,'Edit a sheet');assert.equal(result[0].line,6);
 assert.deepEqual(extractToolRegistrations("function defineTool(x){return {name:'actual'}};ctx.tools.register(defineTool({name:'wrong'}))",'index.js').map(t=>t.name),['actual']);
 assert.deepEqual(extractToolRegistrations("const x={name:'a'};function f(){const x={name:'b'};ctx.tools.register(x)}",'index.js'),[]);
});

test('catalog scans enabled bundle declarations and baseline dependencies; disabled packages do not contribute',async t=>{
 const root=await temporary(t),profile=path.join(root,'profile'),source=path.join(root,'source');
 const pkg=async(name,code,dependencies={})=>{const dir=path.join(profile,'node_modules',name);await json(path.join(dir,'package.json'),{name,version:'1',main:'lib/index.js',dependencies});await mkdir(path.join(dir,'lib'),{recursive:true});await writeFile(path.join(dir,'lib/index.js'),code);};
 await pkg('tested-plugin',"import './tools.js';");
 await writeFile(path.join(profile,'node_modules/tested-plugin/lib/tools.js'),"ctx.tools.register({name:'plugin_tool',description:'registered'})");
 await pkg('disabled-plugin',"ctx.tools.register({name:'disabled_tool'})");
 await pkg('@deepseek-ai/dsh-base','',{'@deepseek-ai/dsh-tool-bash':'1'});
 await pkg('@deepseek-ai/dsh-tool-bash',"ctx.tools.register({name:'bash'})");
 const tools=await collectToolProvenance(source,profile,['@deepseek-ai/dsh-base','tested-plugin']);
 assert.deepEqual(tools.map(t=>t.name),['bash','plugin_tool']);
 assert.equal(toolAttribution('bash',tools).kind,'BASELINE');
 const plugin=toolAttribution('plugin_tool',tools);assert.equal(plugin.kind,'TESTED_PLUGIN');assert.equal(plugin.evidence[0].file,'lib/tools.js');assert.match(plugin.evidence[0].sha256,/^[a-f0-9]{64}$/);
});

test('exact recorded ownership supports shared names and leaves old evidence unknown',()=>{
 const a=declaration('edit','plugin-a'),b=declaration('edit','plugin-b');
 assert.equal(toolAttribution('edit',[a]).kind,'TESTED_PLUGIN');
 assert.equal(toolAttribution('edit',[a,b]).kind,'AMBIGUOUS');
 assert.equal(toolAttribution('edit',[a,declaration('edit','base','BASELINE')]).kind,'AMBIGUOUS');
 assert.equal(toolAttribution('plugin-a_edit',[a]).kind,'UNKNOWN');
 assert.equal(toolAttribution('bash',[]).kind,'UNKNOWN');
 assert.equal(toolAttribution('edit',[{name:'edit',classification:'ADDED'}]).kind,'UNKNOWN');
});

test('Trace attribution is a read-only projection and never tags environmental changes',()=>{
 const event=(id,type,data)=>({id,layer:'AGENT',content:{data:{sessionId:'s',event:{type,data}}}});
 const input=trace([event('header','request/header',{header:{tools:[{name:'plugin_tool'},{name:'bash'}]}}),event('call','tool/call',{callId:'c',name:'plugin_tool',arguments:'{}'}),event('result','tool/result',{callId:'c',result:'ok'}),{id:'env',layer:'ENVIRONMENT',content:{changes:[{path:'plugin_tool'}]}}]);
 const before=JSON.stringify(input),ref={traceId:'trace',manifestDigest:{value:'digest'},entryCount:4};
 const result=projectRuntime(input,ref,{toolSchemas:[declaration('plugin_tool','plugin')]});
 assert.equal(result.trace.pluginToolCallCount,1);assert.equal(result.trace.toolCalls[0].attribution.kind,'TESTED_PLUGIN');
 assert.equal(result.toolDeclarations.find(t=>t.name==='bash').attribution.kind,'UNKNOWN');
 assert.equal(result.environmentSummary.attribution,undefined);assert.equal(JSON.stringify(input),before);
 assert.equal(projectRuntime(input,ref).trace.pluginToolCallCount,0);
});

test('workbench badges, static tools and Trace rows escape provider evidence',async()=>{
 const escape=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const context=vm.createContext({activeRun:null,esc:escape,toolPurpose:{},document:{addEventListener(){}},Map});
 vm.runInContext(await readFile('workbench/design-prototypes/trace-ui.js','utf8'),context);
 const a=toolAttribution('x',[declaration('x','<img src=x onerror=alert(1)>')]);context.attr=a;
 const badge=vm.runInContext('pluginAttributionBadge(attr)',context);assert.ok(badge.includes('被测插件'));assert.ok(!badge.includes('<img'));
 const list=vm.runInContext("observedToolList(['native','x'],[{name:'x',attribution:attr}])",context);assert.ok(list.indexOf('tool:x')<list.indexOf('tool:native'));
 assert.ok(renderToolAttribution(a).includes('&lt;img'));assert.ok(!renderToolAttribution(a).includes('<img'));
});

test('standalone report renderer retains attribution when serialized for the browser',()=>{
 const context=vm.createContext({});
 vm.runInContext(`const toolAttribution=${toolAttribution.toString()};const renderToolAttribution=${renderToolAttribution.toString()};const previewJson=${previewJson.toString()};const projectTraceOverview=${projectTraceOverview.toString()};const renderTraceOverview=${renderTraceOverview.toString()};`,context);
 context.trace={entries:[{id:'call',layer:'AGENT',content:{data:{event:{type:'tool/call',data:{name:'edit',callId:'c'}}}}}]};context.declarations=[declaration('edit','plugin')];
 const html=vm.runInContext('renderTraceOverview(trace,declarations)',context);assert.ok(html.includes('被测插件'));assert.ok(html.includes('lib/index.js'));
 new vm.Script(reportLoaderSource());
});
