import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {verifySignature}=createRequire(import.meta.url)('../../scripts/verify-desktop-signature.cjs');
test('desktop signature check rejects missing sealed resources', {skip:process.platform!=='darwin'}, async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'evaldock-signature-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const app=path.join(root,'Fixture.app'),contents=path.join(app,'Contents');
 await mkdir(path.join(contents,'MacOS'),{recursive:true});await mkdir(path.join(contents,'Resources'));
 await copyFile('/usr/bin/true',path.join(contents,'MacOS/Fixture'));
 await writeFile(path.join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.evaldock.signature-fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
 const resource=path.join(contents,'Resources/sealed.txt');await writeFile(resource,'synthetic resource');
 execFileSync('/usr/bin/codesign',['--force','--sign','-',app],{stdio:'pipe'});
 assert.doesNotThrow(()=>verifySignature(app));
 await rm(resource);assert.throws(()=>verifySignature(app),/Desktop signature verification failed/);
});
