const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {auditDesktopBundle}=require('./audit-desktop-runtime.cjs');
module.exports=async function verifyDesktopPackage(context){
  const platform=context.electronPlatformName;
  if(!['darwin','win32'].includes(platform))throw Error('Unsupported desktop package platform: '+platform);
  const bundle=platform==='darwin'?path.join(context.appOutDir,'EvalDock.app'):context.appOutDir;
  const runtime=path.join(bundle,platform==='darwin'?'Contents/Resources/runtime':'resources/runtime');
  for(const relative of ['adapters/hermes/session-evidence.py','dist/src/runtime/web-auth.js','dist/src/runtime/dsh-web-protocol.js','dist/src/runtime/headless-inspection.js','node_modules/undici/index.js','adapters/compatibility/cli.mjs','adapters/compatibility/check.mjs','adapters/compatibility/contracts.mjs','adapters/compatibility/identity.mjs','adapters/compatibility/store.mjs','adapters/compatibility/dsh.mjs','adapters/shared/factory.mjs','desktop/server.mjs','workbench/control-server.mjs','workbench/design-prototypes/app.html','workbench/design-prototypes/product-pages.js','workbench/lib/app-summary.mjs','workbench/lib/agent-discovery.mjs','dist/src/datasets/loader.js','node_modules/typescript/lib/typescript.js','node_modules/@deepseek-ai/schemastery/lib/index.mjs','datasets/catalog.md']){
    if(!fs.existsSync(path.join(runtime,relative)))throw Error('Desktop package is missing '+relative);
  }
  const resources=path.dirname(runtime);
  for(const relative of ['desktop/workspace.mjs','desktop/library-archive.mjs','desktop/library-paths.mjs','desktop/updates.mjs','adapters/shared/platform-environment.mjs','workbench/lib/initialize-dsh.mjs','workbench/lib/benchdock-library.mjs','workbench/lib/online-selection.mjs','workbench/lib/planner-target.mjs','node_modules/yauzl/index.js'])if(!fs.existsSync(path.join(runtime,relative)))throw Error('Desktop package is missing '+relative);
  if(platform==='darwin'){
  const icon=path.join(resources,'icon.icns');
  if(!fs.existsSync(icon)||!fs.readFileSync(icon).equals(fs.readFileSync(path.join(__dirname,'../desktop/assets/icon.icns'))))throw Error('Desktop package must use the EvalDock app icon');
  const {execFileSync}=require('node:child_process');
  const iconName=execFileSync('/usr/bin/plutil',['-extract','CFBundleIconFile','raw','-o','-',path.join(resources,'../Info.plist')],{encoding:'utf8'}).trim();
  if(iconName!=='icon.icns')throw Error('Desktop bundle does not reference the EvalDock app icon');
  }else{
    const executable=fs.readFileSync(path.join(bundle,'EvalDock.exe'));
    const pe=executable.length>=64?executable.readUInt32LE(60):-1;
    if(executable.toString('ascii',0,2)!=='MZ'||pe<64||pe+26>executable.length||executable.toString('ascii',pe,pe+4)!=='PE\0\0'||executable.readUInt16LE(pe+4)!==0x8664||executable.readUInt16LE(pe+24)!==0x20b)throw Error('Windows candidate must contain an x64 PE executable');
  }
  const inventory=auditDesktopBundle(bundle,{platform});
  if(platform==='win32'){
    const icon=fs.readFileSync(path.join(__dirname,'../desktop/assets/icon.ico'));
    const expected=crypto.createHash('sha256').update(icon).digest('hex');
    if(!inventory.some(file=>file.path==='resources/app.asar/desktop/assets/icon.ico'&&file.sha256===expected))throw Error('Windows package is missing the reviewed ICO resource');
  }
  fs.writeFileSync(path.join(context.appOutDir,'evaldock-package-audit.json'),JSON.stringify({schema:'evaldock.release-files/v1',platform,files:inventory},null,2)+'\n');
  console.log('Audited desktop package files:',inventory.length);
  for(const relative of ['var','config/agents.json','.env']){
    if(fs.existsSync(path.join(runtime,relative)))throw Error('Desktop package contains user state: '+relative);
  }
};
