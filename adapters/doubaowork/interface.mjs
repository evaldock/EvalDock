/** Serialized into the renderer. Bind known API contracts instead of trusting chunk numbers. */
export function doubaoModule(r,{id,properties,marker}){
 const valid=value=>value&&Object.entries(properties).every(([key,type])=>typeof value[key]===type&&(type!=='object'||value[key]!==null));
 // A familiar ID is only a hint; its exported interface must still match.
 if(r.m[id]){let value;try{value=r(id);}catch{}if(valid(value))return value;}
 if(!marker)throw Error('AGENT_INTERFACE_CHANGED');
 const candidates=[];
 for(const [key,factory]of Object.entries(r.m)){
  if(typeof factory!=='function')continue;
  const source=Function.prototype.toString.call(factory);
  if(source.includes(marker)&&Object.keys(properties).every(key=>source.includes(key)))candidates.push(key);
  if(candidates.length>16)throw Error('AGENT_INTERFACE_AMBIGUOUS');
 }
 const matches=[];
 for(const key of candidates){let value;try{value=r(key);}catch{continue;}if(valid(value))matches.push(value);}
 if(matches.length!==1)throw Error(matches.length?'AGENT_INTERFACE_AMBIGUOUS':'AGENT_INTERFACE_CHANGED');
 return matches[0];
}

export function bindDoubao(r,resolve){
 const specs={
  auth:{id:35673,properties:{getIsLoggedIn:'function'},marker:'getIsLoggedIn'},
  injection:{id:788925,properties:{D:'function'}},
  send:{id:957165,properties:{createSendMessage:'function'},marker:'createSendMessage'},
  text:{id:446276,properties:{mapTextToTextBlock:'function'},marker:'mapTextToTextBlock'},
  bot:{id:656207,properties:{IO:'function'}},
  conversation:{id:71834,properties:{NW:'object'}},
  input:{id:521109,properties:{Wp:'function'}},
  mode:{id:63487,properties:{MR:'function'}},
  types:{id:201753,properties:{zcD:'object'},marker:'BLOCK_COMPLEX_TASK'},
  terminate:{id:609347,properties:{iv:'object'},marker:'AGWTaskTerminate'},
  thread:{id:639732,properties:{V:'function'},marker:'ThreadInfo'},
  messages:{id:734835,properties:{I:'object'},marker:'messageMap'},
  release:{id:421540,properties:{rS:'function'}},
  communicate:{id:886735,properties:{_:'function'}},
  environment:{id:209715,properties:{sandboxEnvironmentController:'object'},marker:'sandboxEnvironmentController'},
  workspace:{id:209874,properties:{buildGeneralAgentCompletionTaskParam:'function'},marker:'buildGeneralAgentCompletionTaskParam'},
  authorization:{id:40111,properties:{wn:'function'}},
  sandbox:{id:876207,properties:{H:'function'}},
 };
 const modules=Object.fromEntries(Object.entries(specs).map(([name,spec])=>[name,resolve(r,spec)]));
 if(typeof modules.terminate.iv.AGWTaskTerminate!=='function'||typeof modules.messages.I.getState!=='function'||typeof modules.messages.I.subscribe!=='function'||typeof modules.environment.sandboxEnvironmentController.query!=='function'||typeof modules.conversation.NW.getState!=='function')throw Error('AGENT_INTERFACE_CHANGED');
 return modules;
}
