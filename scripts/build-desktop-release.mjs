import {spawnSync} from 'node:child_process';

// Build locally without publishing. Distribution credentials remain in the user's environment.
const identity=process.env.EVALDOCK_SIGNING_IDENTITY;
if(!identity?.startsWith('Developer ID Application:'))throw Error('请在 EVALDOCK_SIGNING_IDENTITY 指定已有的 Developer ID Application 证书；开发构建继续使用 desktop:pack 或 desktop:dmg。');
if(!(process.env.APPLE_ID&&process.env.APPLE_APP_SPECIFIC_PASSWORD&&process.env.APPLE_TEAM_ID)&&!(process.env.APPLE_API_KEY&&process.env.APPLE_API_KEY_ID&&process.env.APPLE_API_ISSUER))throw Error('请配置 Apple 公证凭据后构建发行包；凭据不得写入仓库。');
for(const args of [['run','desktop:prepare'],['exec','electron-builder','--mac','dmg','zip','--publish','never','--config.mac.identity='+identity,'--config.mac.hardenedRuntime=true','--config.mac.notarize=true']]){
  const result=spawnSync('pnpm',args,{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
