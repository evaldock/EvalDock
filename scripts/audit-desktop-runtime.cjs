const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Audit the bytes being shipped, including generated output and dependencies.
function auditDesktopRuntime(root) {
  const failures = [], inventory = [];
  const allowedRoots = new Set(['adapters','workbench','labels','planning','trace','observer-lab','src','config','datasets','environments','desktop','dist','node_modules','package.json']);
  const configs = new Set(['config/agents.example.json','config/benchdock-pilot.json','config/macos-vm.json','config/targets/fixture-dsh.json','config/targets/real-dsh.json']);
  const demo = new Set(['catalog.md','README.md','basic-file-delivery/case-001/question.json','basic-file-delivery/case-001/input/numbers.json','basic-file-delivery/case-001/private/final.json']);
  function visit(relative) {
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    const parts = relative.split('/'), name = parts.at(-1);
    if (!allowedRoots.has(parts[0]) || /^(?:\.git|\.ssh|\.env(?:\..*)?|\.DS_Store|\.venv|venv|__pycache__|var|secrets|credentials|dataset-history|runtime-details|reports)$/.test(name) || /\.(?:log|pem|key|p12|pfx|pyc)$/.test(name)) failures.push(relative);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { failures.push(relative + ' is not a regular file/directory'); return; }
    if (stat.isDirectory()) { for (const child of fs.readdirSync(absolute).sort()) visit(relative + '/' + child); return; }
    if (parts[0] === 'config' && !configs.has(relative)) failures.push(relative + ' is not a public config template');
    if (parts[0] === 'datasets' && !demo.has(parts.slice(1).join('/'))) failures.push(relative + ' is not the synthetic demo');
    if (parts[0] === 'environments' && relative !== 'environments/macos.json') failures.push(relative + ' is not the public environment schema');
    const bytes = fs.readFileSync(absolute);
    if (/\.(?:md|json|map|mjs|cjs|js|ts|py|html|txt|ya?ml|svg|css)$/.test(name)) {
      const text = bytes.toString('utf8');
      if (/\/(?:Users|home)\/(?!your-user(?:\/|\b))[A-Za-z0-9._-]+/.test(text.replace(/https?:\/\/[^\s<>"']+/g,''))) failures.push(relative + ' contains a personal home path');
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|gho_)[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/.test(text)) failures.push(relative + ' contains credential material');
    }
    inventory.push({path:relative,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  for (const name of fs.readdirSync(root).sort()) visit(name);
  // A tracked demo can also be edited locally; verify its actual bytes.
  for (const relative of demo) {
    if (relative === 'README.md') continue;
    const actual = path.join(root,'datasets',relative), expected = path.join(__dirname,'../examples/datasets/minimal',relative);
    if (!fs.existsSync(actual) || !fs.readFileSync(actual).equals(fs.readFileSync(expected))) failures.push('datasets/' + relative + ' differs from the synthetic demo');
  }
  if (failures.length) throw Error('Desktop publication boundary failed:\n' + [...new Set(failures)].join('\n'));
  return inventory;
}
module.exports = {auditDesktopRuntime};
if (require.main === module) {
  const inventory = auditDesktopRuntime(path.resolve(process.argv[2] || 'artifacts/desktop-runtime'));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify({schema:'evaldock.release-files/v1',files:inventory},null,2)+'\n');
  console.log('Desktop publication boundary passed: ' + inventory.length + ' files.');
}
