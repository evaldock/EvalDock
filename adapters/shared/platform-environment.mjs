/** Only OS/runtime variables; evaluator credentials and arbitrary Node options stay out. */
export function platformEnvironment(source=process.env,{platform=process.platform,includeHome=false}={}){
  const names=['PATH','LANG','TMPDIR','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS',...(includeHome?['HOME']:[])];
  if(platform==='win32')names.push('SystemRoot','WINDIR','ComSpec','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA');
  const result={};
  for(const name of names){
    const key=Object.hasOwn(source,name)?name:platform==='win32'?Object.keys(source).find(k=>k.toUpperCase()===name.toUpperCase()):undefined;
    if(key&&source[key])result[name]=source[key];
  }
  return result;
}
