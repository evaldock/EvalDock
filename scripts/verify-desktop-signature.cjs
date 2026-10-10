const path = require('node:path');
const {execFileSync} = require('node:child_process');
function verifySignature(appPath) {
  // Integrity verification is mandatory even for ad-hoc builds. It does not
  // establish Developer ID trust or prove that notarization has completed.
  try {
    execFileSync('/usr/bin/codesign', ['--verify','--deep','--strict','--verbose=2',appPath], {stdio:'pipe'});
  } catch (error) { throw new Error('Desktop signature verification failed: '+(error.stderr?.toString().trim() || error.message)); }
  console.log('Desktop code signature integrity passed.');
}
module.exports = async context => verifySignature(path.join(context.appOutDir,'EvalDock.app'));
module.exports.verifySignature = verifySignature;
if (require.main === module) verifySignature(path.resolve(process.argv[2]));
