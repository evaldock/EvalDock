import {createRequire} from 'node:module';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [sourceRoot,profile]=process.argv.slice(2);
const send=value=>new Promise(resolve=>process.stdout.write('EVALDOCK_PREFLIGHT '+JSON.stringify(value)+'\n',resolve));
try{
  const require=createRequire(path.join(sourceRoot,'package.json'));
  const {loadLayeredEnv}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
  const lib=path.join(sourceRoot,'lib');let entry;
  for(const name of await readdir(lib))if(/^profile-boot-.*\.js$/.test(name)&&(await readFile(path.join(lib,name),'utf8')).includes('export { runProfile };')){entry=path.join(lib,name);break;}
  if(!entry)throw Error('DSH_STARTUP_INTERFACE_UNAVAILABLE');
  const {runProfile}=await import(pathToFileURL(entry));
  const app=await runProfile({environment:loadLayeredEnv('dsh'),profile,patchFiles:[],args:['--host','127.0.0.1','--port','0','--no-open']});
  const ready=app.ctx.fiber.state===2&&Number.isInteger(app.ctx.get('webServer')?.port);
  await send({ready,error:ready?undefined:'DSH_WEB_NOT_READY'});
  await app.shutdown.shutdown(ready?0:1);
}catch(error){await send({ready:false,error:String(error.message??error).slice(0,6000)});process.exitCode=1;}
