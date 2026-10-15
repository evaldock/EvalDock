/** Enforce one portable name for each entry, including implicit parent directories. */
export class LibraryPaths {
  constructor({platform=process.platform}={}){this.platform=platform;this.entries=new Map();}
  add(name,{directory=false}={}){
    const parts=name.split('/');
    for(const part of parts){
      if(!part||part==='.'||part==='..'||/[\\:\x00-\x1f]/.test(part))throw Error('题库包含无效文件路径');
      if(this.platform==='win32'&&(/[<>"|?*]/.test(part)||/[. ]$/.test(part)||/^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))throw Error('题库包含不兼容 Windows 的文件路径');
    }
    for(let i=0;i<parts.length;i++){
      const spelling=parts.slice(0,i+1).join('/'),key=spelling.normalize('NFC').toLowerCase(),final=i===parts.length-1,isDirectory=!final||directory;
      const prior=this.entries.get(key);
      if(prior&&(prior.spelling!==spelling||prior.directory!==isDirectory||final&&prior.explicit))throw Error('题库包含重复、大小写或 Unicode 冲突的路径');
      this.entries.set(key,{spelling,directory:isDirectory,explicit:!!prior?.explicit||final});
    }
    return name;
  }
}
