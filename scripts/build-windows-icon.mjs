import {readFile,writeFile} from 'node:fs/promises';
// Reuse the existing icon's 256px PNG frame; no redraw and no platform tool needed.
const source=await readFile(new URL('../desktop/assets/icon.icns',import.meta.url));
if(source.toString('ascii',0,4)!=='icns'||source.readUInt32BE(4)!==source.length)throw Error('Invalid source ICNS');
let png;
for(let offset=8;offset+8<=source.length;){
  const size=source.readUInt32BE(offset+4);if(size<8||offset+size>source.length)throw Error('Invalid ICNS frame');
  if(source.toString('ascii',offset,offset+4)==='ic08')png=source.subarray(offset+8,offset+size);
  offset+=size;
}
if(!png||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(16)!==256||png.readUInt32BE(20)!==256)throw Error('Source icon requires a 256px PNG frame');
const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
await writeFile(new URL('../desktop/assets/icon.ico',import.meta.url),Buffer.concat([header,png]));
console.log('Windows ICO generated from the existing 256px app icon.');
