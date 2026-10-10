import test from 'node:test';import assert from 'node:assert/strict';
import {ConsumptionMask} from '../src/consumption-mask.js';import {MaskDisplay} from '../src/mask-display.js';
const oldDocument=globalThis.document,oldImageData=globalThis.ImageData;
test('remaining-building bitmap subtracts consumed cells, flips north, and updates dirty chunks only',()=>{
 try{globalThis.ImageData=class{constructor(w,h){this.data=new Uint8ClampedArray(w*h*4);}};globalThis.document={createElement:()=>({getContext:()=>({putImageData(){}})})};
  const mask=new ConsumptionMask(),bits=new Uint8Array(8192);bits[0]=3;mask.ingestCoverage('0,0',bits);const display=new MaskDisplay(mask);display.update();const pixels=display.images.get('0,0').pixels.data,alpha=x=>pixels[((255*256)+x)*4+3];assert.equal(alpha(0),255);assert.equal(alpha(1),255);
  const result=mask.consumeCircle([-1499,-1499],.1);assert.equal(result.areaM2,4);for(const key of result.changedChunks)display.changed(key);display.update();assert.equal(alpha(0),0);assert.equal(alpha(1),255);const rebuilt=display.stats.rebuiltChunks;
  display.update();assert.equal(display.stats.rebuiltChunks,rebuilt);mask.evictCoverage('0,0');display.update();assert.equal(display.images.size,0);mask.ingestCoverage('0,0',bits);display.update();assert.equal(display.images.get('0,0').pixels.data[(255*256)*4+3],0);
 }finally{globalThis.document=oldDocument;globalThis.ImageData=oldImageData;}
});
test('render bitmap work depends on one dirty resident chunk, not lifetime consumed chunks',()=>{
 try{globalThis.ImageData=class{constructor(w,h){this.data=new Uint8ClampedArray(w*h*4);}};globalThis.document={createElement:()=>({getContext:()=>({putImageData(){}})})};
  const full=new Uint8Array(8192).fill(255);for(const count of [0,20,36]){const mask=new ConsumptionMask();mask.restoreConsumed(Array.from({length:count},(_,i)=>[`${i%6},${Math.floor(i/6)}`,full]));mask.ingestCoverage('0,0',full);const display=new MaskDisplay(mask);display.update();assert.equal(display.images.size,1);assert.equal(display.stats.rebuiltChunks,1);display.changed('0,0');display.update();assert.equal(display.stats.rebuiltChunks,2);}
 }finally{globalThis.document=oldDocument;globalThis.ImageData=oldImageData;}
});
test('smooth replacements remove only certified footprint cells and restore fallback on reset',()=>{
 try{globalThis.ImageData=class{constructor(w,h){this.data=new Uint8ClampedArray(w*h*4);}};globalThis.document={createElement:()=>({getContext:()=>({putImageData(){}})})};const mask=new ConsumptionMask(),bits=new Uint8Array(8192);bits[0]=3;mask.ingestCoverage('0,0',bits);const display=new MaskDisplay(mask),replacement=new Uint8Array(8192);replacement[0]=1;display.setReplacements(new Map([['0,0',replacement]]));display.update();const pixels=display.images.get('0,0').pixels.data;assert.equal(pixels[255*256*4+3],0);assert.equal(pixels[(255*256+1)*4+3],255);display.setReplacements(new Map());display.update();assert.equal(pixels[255*256*4+3],255);assert.equal(pixels[(255*256+1)*4+3],255);}finally{globalThis.document=oldDocument;globalThis.ImageData=oldImageData;}
});
