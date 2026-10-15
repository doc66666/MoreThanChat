import {mkdir,writeFile} from 'node:fs/promises'
import {deflateSync} from 'node:zlib'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..')
const glyphs=[['10001','11011','10101','10101','10001','10001','10001'],['11111','00100','00100','00100','00100','00100','00100'],['01111','10000','10000','10000','10000','10000','01111']]
const colors=['#ec5671','#ef854c','#e7b547','#65b66e','#38b4b7','#5688dc','#9a68ce']
const blocks=[]
for(let g=0;g<3;g++)for(let y=0;y<7;y++)for(let x=0;x<5;x++)if(glyphs[g][y][x]==='1')blocks.push({x:26+(g*6+x)*12,y:86+y*12,color:g===2?colors[y]:'#181818'})
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" shape-rendering="crispEdges"><rect width="256" height="256" fill="white"/>${blocks.map(b=>`<rect x="${b.x}" y="${b.y}" width="12" height="12" fill="${b.color}"/>`).join('')}</svg>\n`
function crc(data){let n=0xffffffff;for(const byte of data){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0)}return(n^0xffffffff)>>>0}
function chunk(type,data){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b}
function png(size){
  const raw=Buffer.alloc(size*(size*4+1),255)
  for(let y=0;y<size;y++){raw[y*(size*4+1)]=0;for(let x=0;x<size;x++){
    const px=(x+0.5)*256/size,py=(y+0.5)*256/size,b=blocks.find(b=>px>=b.x&&px<b.x+12&&py>=b.y&&py<b.y+12)
    if(b){const rgb=Buffer.from(b.color.slice(1),'hex');rgb.copy(raw,y*(size*4+1)+1+x*4)}
  }}
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])
}
const sizes=[16,32,48,64,128,256],frames=sizes.map(png),header=Buffer.alloc(6+16*sizes.length)
header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4)
let offset=header.length
for(let i=0;i<sizes.length;i++){const p=6+i*16;header[p]=header[p+1]=sizes[i]===256?0:sizes[i];header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(frames[i].length,p+8);header.writeUInt32LE(offset,p+12);offset+=frames[i].length}
await mkdir(path.join(root,'assets'),{recursive:true});await mkdir(path.join(root,'src/renderer/public'),{recursive:true})
await writeFile(path.join(root,'assets/icon.png'),png(256));await writeFile(path.join(root,'assets/icon.ico'),Buffer.concat([header,...frames]));await writeFile(path.join(root,'src/renderer/public/mtc-icon.svg'),svg)
console.log('Generated pixel MTC SVG, PNG and multi-resolution ICO from one source.')
