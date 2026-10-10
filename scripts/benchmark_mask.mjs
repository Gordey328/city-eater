import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {ConsumptionMask,maskChunksForBounds} from '../src/consumption-mask.js';
import {MaskDisplay} from '../src/mask-display.js';
const full=new Uint8Array(8192).fill(255),results=[];
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
for(const radius of [18,100,500])for(const historyChunks of [0,25,100]){
 const times=[],words=[];
 for(let sample=0;sample<55;sample++){
  const mask=new ConsumptionMask();mask.restoreConsumed(Array.from({length:historyChunks},(_,i)=>[`${i%10},${Math.floor(i/10)}`,full]));
  for(const key of maskChunksForBounds([-radius-100,-radius-100,radius+100,radius+100]))mask.ingestCoverage(key,full);
  const start=performance.now(),result=mask.consumeSweep([0,0],[5,3],radius,{maxRows:640,maxMilliseconds:Infinity}),elapsed=performance.now()-start;
  if(sample>=5){times.push(elapsed);words.push(result.wordsVisited);}
 }
 results.push({radius,historyChunks,historyBytes:historyChunks*8192,medianMs:percentile(times,.5),p95Ms:percentile(times,.95),maxWords:Math.max(...words)});
}
globalThis.ImageData=class{constructor(w,h){this.data=new Uint8ClampedArray(w*h*4);}};globalThis.document={createElement:()=>({getContext:()=>({putImageData(){}})})};
const display=[];
for(const historyChunks of [0,25,100]){const mask=new ConsumptionMask();mask.restoreConsumed(Array.from({length:historyChunks},(_,i)=>[`${i%10},${Math.floor(i/10)}`,full]));mask.ingestCoverage('0,0',full);const layer=new MaskDisplay(mask);layer.update();const times=[];for(let i=0;i<55;i++){layer.changed('0,0');const start=performance.now();layer.update();if(i>=5)times.push(performance.now()-start);}display.push({historyChunks,residentChunks:1,dirtyChunks:1,medianMs:percentile(times,.5),p95Ms:percentile(times,.95)});}
const report={kind:'Node CPU microbenchmark, not network/GPU/mobile FPS',node:process.version,date:new Date().toISOString(),coverage:'Fully occupied synthetic stress mask; never shipped as gameplay data',samples:50,scan:results,bitmapUpdate:display,limits:{cellMeters:2,maxRadiusMeters:500,totalConsumedBytesIncludingPadding:36*8192,residentCoverageBytes:36*8192,residentBitmapBytes:36*256*256*4}};
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
