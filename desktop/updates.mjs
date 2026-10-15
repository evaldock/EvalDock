/** Keep update discovery, download and installation separate from evaluation readiness. */
export class DesktopUpdates {
  constructor({updater,enabled,version,canInstall,beforeInstall=async()=>{},onChange=()=>{},platform=process.platform}){
    Object.assign(this,{updater,canInstall,beforeInstall,onChange});
    this.value={state:enabled?'IDLE':'DISABLED',version,availableVersion:null,percent:0,error:null,reason:enabled?null:platform==='darwin'?'自动更新需要已安装的 Developer ID 签名版。当前开发版或临时签名版请通过发布页下载安装。':'当前平台尚未启用自动更新，请使用经验证的安装包手动更新。配置、题库和记录保留在本机。'};
    updater.autoDownload=false;updater.autoInstallOnAppQuit=false;
    updater.allowPrerelease=false;updater.allowDowngrade=false;
    updater.on('checking-for-update',()=>this.set({state:'CHECKING',error:null}));
    updater.on('update-available',info=>this.set({state:'AVAILABLE',availableVersion:info.version,percent:0,error:null}));
    updater.on('update-not-available',()=>this.set({state:'CURRENT',availableVersion:null,error:null}));
    updater.on('download-progress',progress=>this.set({state:'DOWNLOADING',percent:Math.max(0,Math.min(100,progress.percent))}));
    updater.on('update-downloaded',info=>this.set({state:'READY',availableVersion:info.version,percent:100,error:null}));
    updater.on('error',()=>this.set({state:'FAILED',error:'更新检查或下载失败，请检查网络及发布包后重试。'}));
  }
  status(){return {...this.value};}
  set(change){this.value={...this.value,...change};this.onChange(this.status());}
  async check(){
    if(this.value.state==='DISABLED'||this.pending||['DOWNLOADING','READY','INSTALLING'].includes(this.value.state))return this.status();
    this.pending=this.updater.checkForUpdates().catch(()=>{this.set({state:'FAILED',error:'无法检查更新，请稍后重试。'});}).finally(()=>{this.pending=null;});
    await this.pending;return this.status();
  }
  async download(){
    if(this.pending||this.value.state!=='AVAILABLE')throw Error('请先检查到可用更新');
    this.set({state:'DOWNLOADING',percent:0,error:null});
    this.pending=this.updater.downloadUpdate().catch(()=>{this.set({state:'FAILED',error:'更新下载失败，当前安装及本地数据保留，请重新检查更新。'});}).finally(()=>{this.pending=null;});
    await this.pending;return this.status();
  }
  async install(){
    if(this.value.state!=='READY'||this.installing)throw Error('请等待更新下载完成');
    this.installing=true;
    try{
      if(!await this.canInstall())throw Error('请等待评测、题库准备和导入完成后安装更新');
      this.set({state:'INSTALLING'});await this.beforeInstall();this.updater.quitAndInstall();
    }catch(error){this.set({state:'READY'});throw error;}
    finally{this.installing=false;}
  }
}

export function updateEligible({packaged,platform,signature}){
  return packaged&&platform==='darwin'&&/^Authority=Developer ID Application:/m.test(signature)&&/^TeamIdentifier=[A-Z0-9]{10}$/m.test(signature);
}
