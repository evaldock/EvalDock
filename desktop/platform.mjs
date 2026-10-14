export function backendEnvironment({environment=process.env,platform=process.platform,root,automaticLibrary=false}){
  const result={...environment,ELECTRON_RUN_AS_NODE:'1',EVALDOCK_AUTO_DATASETS:automaticLibrary?'1':'0',EVALDOCK_DATASETS_ROOT:root};
  const key=Object.hasOwn(environment,'PATH')?'PATH':Object.keys(environment).find(k=>k.toUpperCase()==='PATH');
  if(platform==='win32'){
    for(const name of Object.keys(result))if(name.toUpperCase()==='PATH')delete result[name];
    if(key)result.PATH=environment[key];
  }else{
    result.PATH=[environment.PATH,...platform==='darwin'?['/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin']:['/usr/local/bin','/usr/bin','/bin']].filter(Boolean).join(':');
  }
  return result;
}
export function windowPlatformOptions(platform,icon){
  return platform==='darwin'?{titleBarStyle:'hiddenInset'}:{titleBarStyle:'default',icon};
}
export function applicationMenu(platform,actions){
  return {label:'EvalDock',submenu:[{role:'about'},...actions,{type:'separator'},...platform==='darwin'?[{role:'hide'},{role:'hideOthers'},{type:'separator'}]:[],{role:'quit'}]};
}
