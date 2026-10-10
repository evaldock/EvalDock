const fs=require('node:fs');
const path=require('node:path');
const {auditDesktopRuntime}=require('./audit-desktop-runtime.cjs');
module.exports=async function verifyDesktopPackage(context){
  const runtime=path.join(context.appOutDir,'EvalDock.app/Contents/Resources/runtime');
  for(const relative of ['adapters/hermes/session-evidence.py','dist/src/runtime/web-auth.js','dist/src/runtime/dsh-web-protocol.js','dist/src/runtime/headless-inspection.js','node_modules/undici/index.js','adapters/compatibility/cli.mjs','adapters/compatibility/check.mjs','adapters/compatibility/contracts.mjs','adapters/compatibility/identity.mjs','adapters/compatibility/store.mjs','adapters/compatibility/dsh.mjs','adapters/shared/factory.mjs','desktop/server.mjs','workbench/control-server.mjs','workbench/design-prototypes/app.html','workbench/design-prototypes/product-pages.js','workbench/lib/app-summary.mjs','workbench/lib/agent-discovery.mjs','dist/src/datasets/loader.js','node_modules/typescript/lib/typescript.js','node_modules/@deepseek-ai/schemastery/lib/index.mjs','datasets/catalog.md']){
    if(!fs.existsSync(path.join(runtime,relative)))throw Error('Desktop package is missing '+relative);
  }
  const resources=path.dirname(runtime);
  const icon=path.join(resources,'icon.icns');
  if(!fs.existsSync(icon)||!fs.readFileSync(icon).equals(fs.readFileSync(path.join(__dirname,'../desktop/assets/icon.icns'))))throw Error('Desktop package must use the EvalDock app icon');
  const {execFileSync}=require('node:child_process');
  const iconName=execFileSync('/usr/bin/plutil',['-extract','CFBundleIconFile','raw','-o','-',path.join(resources,'../Info.plist')],{encoding:'utf8'}).trim();
  if(iconName!=='icon.icns')throw Error('Desktop bundle does not reference the EvalDock app icon');
  auditDesktopRuntime(runtime);
  for(const relative of ['var','config/agents.json','.env']){
    if(fs.existsSync(path.join(runtime,relative)))throw Error('Desktop package contains user state: '+relative);
  }
};
