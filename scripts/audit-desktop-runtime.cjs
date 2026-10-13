const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');

const emptySnapshots = {
  historicalAgents: [],
  resourceSnapshot: {capturedAt:null,datasets:[],agents:[]},
  observationPlanSnapshot: {capturedAt:null,web:{version:null,profile:null,installRoot:null,home:null,bundles:[],tools:[]},plans:{}},
};
const snapshotFiles = {
  'workbench/design-prototypes/historical-snapshot.js': ['historicalAgents'],
  'workbench/design-prototypes/catalog-snapshot.js': ['resourceSnapshot'],
  'workbench/design-prototypes/observation-plan-snapshot.js': ['observationPlanSnapshot'],
  'workbench/design-prototypes/index.html': Object.keys(emptySnapshots),
};
function inspectFile(relative, bytes, failures) {
  const parts=relative.split('/'), name=parts.at(-1);
  if (parts.some(part=>/^(?:\.git|\.ssh|\.config|\.cache|\.evaldock|\.env(?:\..*)?|\.DS_Store|\.venv|venv|__pycache__|var|secrets|credentials|dataset-history|runtime-details|reports|Cache|Code Cache|GPUCache|Local Storage|IndexedDB|Cookies|Preferences)$/.test(part)) || /\.(?:log|pem|key|p12|pfx|pyc|env)$/.test(name) || name==='live-observation.json') failures.push(relative+' contains user state');
  if (!/\.(?:md|json|map|mjs|cjs|js|ts|py|html|txt|ya?ml|svg|css|strings)$/.test(name)) return;
  const text=bytes.toString('utf8');
  if (/\/(?:Users|home)\/(?!your-user(?:\/|\b))[A-Za-z0-9._-]+/.test(text.replace(/https?:\/\/[^\s<>"']+/g,''))) failures.push(relative+' contains a personal home path');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|gho_)[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bsk-[A-Za-z0-9_-]{20,}/.test(text)) failures.push(relative+' contains credential material');
  for (const name of snapshotFiles[relative]??[]) {
    const match=text.match(new RegExp('(?:^|\\n)const '+name+'\\s*=\\s*([^\\n]*);'));
    try {if (!match || JSON.stringify(JSON.parse(match[1]))!==JSON.stringify(emptySnapshots[name])) throw Error();}
    catch {failures.push(relative+' must contain an empty '+name);}
  }
  if (relative==='planning/case-difficulty.json' || relative==='workbench/design-prototypes/question-inventory/index.json') {
    try {
      const value=JSON.parse(text),field=relative.startsWith('planning/')?'cases':'datasets';
      const timestamp=field==='cases'?'assessedAt':'capturedAt';
      if (!Array.isArray(value[field]) || value[field].length || value[timestamp]!==null) throw Error();
    } catch {failures.push(relative+' contains task or assessment history');}
  }
}
function digest(relative,bytes) {return {path:relative,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
function assertClean(failures) {if (failures.length) throw Error('Desktop publication boundary failed:\n'+[...new Set(failures)].join('\n'));}

// Audit the bytes being shipped, including generated output and dependencies.
function auditDesktopRuntime(root) {
  const failures = [], inventory = [];
  const allowedRoots = new Set(['adapters','workbench','labels','planning','trace','observer-lab','src','config','datasets','environments','desktop','dist','node_modules','package.json']);
  const configs = new Set(['config/agents.example.json','config/benchdock-pilot.json','config/macos-vm.json','config/targets/fixture-dsh.json','config/targets/real-dsh.json']);
  function visit(relative) {
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    const parts = relative.split('/');
    if (!allowedRoots.has(parts[0]) || relative==='dist/tests' || relative==='workbench/tests') failures.push(relative);
    if (parts[0]==='datasets'&&relative!=='datasets'&&relative!=='datasets/catalog.md') failures.push(relative+' is not the empty desktop library');
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { failures.push(relative + ' is not a regular file/directory'); return; }
    if (stat.isDirectory()) { for (const child of fs.readdirSync(absolute).sort()) visit(relative + '/' + child); return; }
    if (parts[0] === 'config' && !configs.has(relative)) failures.push(relative + ' is not a public config template');
    if (parts[0] === 'environments' && relative !== 'environments/macos.json') failures.push(relative + ' is not the public environment schema');
    const bytes = fs.readFileSync(absolute);
    inspectFile(relative,bytes,failures);
    inventory.push(digest(relative,bytes));
  }
  for (const name of fs.readdirSync(root).sort()) visit(name);
  const actual=path.join(root,'datasets/catalog.md'),expected=path.join(__dirname,'../desktop/empty-library/catalog.md');
  if (!fs.existsSync(actual)||!fs.readFileSync(actual).equals(fs.readFileSync(expected))) failures.push('datasets/catalog.md differs from the empty desktop library');
  else {
    try {
      const source=fs.readFileSync(actual,'utf8'),match=source.match(/```json evaldock-dataset-catalog\s*\n([\s\S]*?)\n```/);
      const value=JSON.parse(match[1]);
      if (!Array.isArray(value.datasets)||value.datasets.length) throw Error();
    } catch {failures.push('Desktop library must contain zero datasets');}
  }
  assertClean(failures);
  return inventory;
}

// The Electron entry point and updater dependencies live outside runtime, in ASAR.
function auditDesktopArchive(archive) {
  const asar=createRequire(require.resolve('electron-builder'))('@electron/asar');
  const failures=[],inventory=[];
  const desktopFiles=new Set(['desktop/main.mjs','desktop/preload.cjs','desktop/workspace.mjs','desktop/library-archive.mjs','desktop/updates.mjs','desktop/assets/icon.png']);
  for (const entry of asar.listPackage(archive)) {
    const relative=entry.replace(/^\//,''),stat=asar.statFile(archive,relative,false);
    if (stat.link) {failures.push(relative+' is an archive link');continue;}
    if (stat.files) continue;
    if (!(relative==='package.json'||relative.startsWith('node_modules/')||desktopFiles.has(relative))) failures.push(relative+' is not an application resource');
    const bytes=asar.extractFile(archive,relative);
    inspectFile(relative,bytes,failures);inventory.push(digest(relative,bytes));
  }
  const unpacked=archive+'.unpacked',declared=new Set(inventory.map(file=>file.path));
  if (fs.existsSync(unpacked)) {
    function visit(relative='') {
      const file=path.join(unpacked,relative),stat=fs.lstatSync(file);
      if (stat.isDirectory()) {for (const name of fs.readdirSync(file)) visit(path.join(relative,name));return;}
      if (!stat.isFile() || !declared.has(relative)) failures.push(relative+' is an undeclared unpacked resource');
    }
    visit();
  }
  assertClean(failures);return inventory;
}
function auditDesktopBundle(bundle) {
  const resources=path.join(bundle,'Contents/Resources'),failures=[];
  const allowed=new Set(['runtime','app.asar','app.asar.unpacked','icon.icns','app-update.yml']);
  for (const name of fs.readdirSync(resources)) if (!allowed.has(name)&&!/^\w+\.lproj$/.test(name)) failures.push('Resources/'+name+' is not an application resource');
  const updates=path.join(resources,'app-update.yml');
  if (fs.existsSync(updates)) inspectFile('app-update.yml',fs.readFileSync(updates),failures);
  assertClean(failures);
  return [
    ...auditDesktopRuntime(path.join(resources,'runtime')).map(file=>({...file,path:'Contents/Resources/runtime/'+file.path})),
    ...auditDesktopArchive(path.join(resources,'app.asar')).map(file=>({...file,path:'Contents/Resources/app.asar/'+file.path})),
  ];
}
module.exports = {auditDesktopRuntime,auditDesktopArchive,auditDesktopBundle};
if (require.main === module) {
  const root=path.resolve(process.argv[2]||'artifacts/desktop-runtime');
  const inventory = root.endsWith('.app')?auditDesktopBundle(root):auditDesktopRuntime(root);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify({schema:'evaldock.release-files/v1',files:inventory},null,2)+'\n');
  console.log('Desktop publication boundary passed: ' + inventory.length + ' files.');
}
