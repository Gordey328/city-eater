import test from 'node:test';
import assert from 'node:assert/strict';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {decodeVisualTile, drawVisualTile, normalizeVisualView, VISUAL_TILE_SIZE, VISUAL_MAX_DETAIL_SCALE} from '../src/visual-tile-drawing.js';
import {prepareVisualTile, createVisualTileProcessor, decodedVisualTileBytes, VISUAL_DECODED_CACHE_LIMIT, VISUAL_DECODED_CACHE_BYTES} from '../src/visual-tile.worker.js';

const rectangle = (x0, y0, x1, y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];
const pbf = layers => { const bytes = fromGeojsonVt(layers, {extent:4096}); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };
const nativePath = points => points.map(([x,y]) => [x*8,y*8]);
const fixture = () => pbf({
  park: {features:[{type:3,tags:{},geometry:[nativePath(rectangle(184,312,264,392)),nativePath(rectangle(208,336,240,368).reverse())]}]},
  transportation: {features:[{type:2,tags:{class:'primary'},geometry:[nativePath([[180,352],[270,352]])]}]},
});
function context() {
  let matrix = [1,0,0,1,0,0], current = [], stack = [];
  const point = (x,y) => [x*matrix[0]+matrix[4],y*matrix[3]+matrix[5]];
  return {
    calls: [], clips: [], fills: [], strokes: [],
    save() { stack.push([...matrix]); this.calls.push('save'); },
    restore() { matrix = stack.pop(); this.calls.push('restore'); },
    setTransform(...value) { matrix = value; this.calls.push(['transform',...value]); },
    clearRect(...value) { this.calls.push(['clear',...value]); },
    fillRect(...value) { this.calls.push(['background',...value]); },
    beginPath() { current = []; },
    rect(x,y,w,h) { current.push(['rect',...point(x,y),w*matrix[0],h*matrix[3]]); },
    clip() { this.clips.push(current.slice()); this.calls.push('clip'); },
    moveTo(x,y) { current.push(['move',...point(x,y)]); },
    lineTo(x,y) { current.push(['line',...point(x,y)]); },
    closePath() { current.push(['close']); },
    fill(rule) { this.fills.push({rule, paths:current.slice()}); this.calls.push('fill'); },
    setLineDash(value) { this.dash = value; },
    stroke() { this.strokes.push({width:this.lineWidth*matrix[0], paths:current.slice(), dash:this.dash}); this.calls.push('stroke'); },
  };
}
const bitmapCanvas = ctx => ({width:1,height:1,getContext:()=>ctx,transferToImageBitmap(){return {width:this.width,height:this.height};}});

test('z14 to z17 crops rasterize vectors at full 512 resolution with unchanged world road width', () => {
  const decoded = decodeVisualTile(fixture()), original = decoded.commands[1].paths[0].slice(), ctx = context();
  drawVisualTile(ctx, decoded.commands, 512, {scale:8,x:3,y:5});
  assert.deepEqual(ctx.strokes[0].paths, [['move',-96,256],['line',624,256]]);
  assert.equal(ctx.strokes[0].width, 2.8*8); assert.equal(ctx.strokes[1].width, 1.7*8);
  assert.deepEqual(ctx.fills[0].paths[0], ['move',-64,-64]);
  assert.deepEqual(decoded.commands[1].paths[0], original);
  assert.deepEqual(ctx.calls.find(call => call[0] === 'clear'), ['clear',0,0,512,512]);
  assert.equal(ctx.calls.at(-1), 'restore');
});

test('adjacent virtual tiles share exact geometric edges, including maximum z19 detail', () => {
  const commands = [{type:'line',paint:'road',paths:[new Float32Array([256,352,257,352])]}];
  const left=context(), right=context();
  drawVisualTile(left,commands,512,{scale:8,x:3,y:5});
  drawVisualTile(right,commands,512,{scale:8,x:4,y:5});
  assert.deepEqual(left.strokes[0].paths[0],['move',512,256]);
  assert.deepEqual(right.strokes[0].paths[0],['move',0,256]);
  const max=context(); drawVisualTile(max,commands,512,{scale:32,x:16,y:22});
  assert.deepEqual(max.strokes[0].paths[0],['move',0,0]);
  assert.equal(VISUAL_TILE_SIZE,512); assert.equal(VISUAL_MAX_DETAIL_SCALE,32);
});

test('virtual raster clips both its output and canonical native core before filling courtyard holes', () => {
  const ctx=context(); drawVisualTile(ctx,decodeVisualTile(fixture()).commands,512,{scale:8,x:3,y:5});
  assert.deepEqual(ctx.clips, [[['rect',0,0,512,512]],[['rect',-1536,-2560,4096,4096]]]);
  assert.ok(ctx.calls.indexOf('clip') < ctx.calls.indexOf('fill'));
  assert.equal(ctx.fills[0].rule,'evenodd');
  assert.equal(ctx.fills[0].paths.filter(path=>path[0]==='move').length,2);
  const hole=ctx.fills[0].paths.slice(5).filter(path=>path[0]==='move'||path[0]==='line');
  assert.ok(hole.every(([,x,y])=>x>=128&&x<=384&&y>=128&&y<=384));
  const scaled=context(); drawVisualTile(scaled,decodeVisualTile(fixture()).commands,256,{scale:8,x:3,y:5});
  assert.deepEqual(scaled.strokes[0].paths[0],['move',-48,128]);
});

test('view bounds reject invalid crops before drawing or decoding', () => {
  const invalid=[null,{}, {scale:0,x:0,y:0},{scale:3,x:0,y:0},{scale:64,x:0,y:0},{scale:Infinity,x:0,y:0},
    {scale:8,x:-1,y:0},{scale:8,x:8,y:0},{scale:8,x:0,y:8},{scale:8,x:1.5,y:0},{scale:8,x:0,y:NaN},
    {scale:'8',x:0,y:0}];
  let decodes=0; const processor=createVisualTileProcessor({createCanvas:null,decode(){decodes++;return decodeVisualTile(fixture());}});
  for(const view of invalid) {
    const ctx=context(); assert.throws(()=>drawVisualTile(ctx,[],512,view),RangeError); assert.equal(ctx.calls.length,0);
    assert.throws(()=>processor.prepare({buffer:fixture(),sourceKey:'parent',view}),RangeError);
    assert.throws(()=>prepareVisualTile(fixture(),null,view),RangeError);
  }
  assert.equal(decodes,0); assert.equal(processor.stats.decodedParents,0);
  for(const size of [0,-1,NaN,Infinity])assert.throws(()=>drawVisualTile(context(),[],size),RangeError);
  assert.deepEqual(normalizeVisualView(),{scale:1,x:0,y:0});
  for(const scale of [1,2,4,8,16,32])assert.deepEqual(normalizeVisualView({scale,x:scale-1,y:scale-1}),{scale,x:scale-1,y:scale-1});
});

test('prepareVisualTile preserves old signatures and returns an isolated crop with fallback commands', () => {
  const view={scale:8,x:3,y:5}, result=prepareVisualTile(fixture(),null,view);
  assert.equal(result.stats.offscreen,false); assert.deepEqual(result.view,view); assert.notEqual(result.view,view);
  view.x=0; assert.equal(result.view.x,3);
  assert.deepEqual(prepareVisualTile(fixture(),null).view,{scale:1,x:0,y:0});
  const ctx=context(); drawVisualTile(ctx,result.commands,512,result.view);
  assert.deepEqual(ctx.strokes[0].paths[0],['move',-96,256]);
});

test('Offscreen rendering always uses 512-square pixels and releases its backing canvas after transfer', () => {
  const ctx=context(), canvas=bitmapCanvas(ctx);
  const result=prepareVisualTile(fixture(),()=>canvas,{scale:8,x:3,y:5});
  assert.deepEqual(result.bitmap,{width:512,height:512}); assert.equal(result.commands,undefined);
  assert.equal(result.stats.offscreen,true); assert.equal(canvas.width,0); assert.equal(canvas.height,0);
  assert.deepEqual(ctx.strokes[0].paths[0],['move',-96,256]);
  for(const failure of ['context','draw','transfer']) {
    const ctx=context(), canvas=bitmapCanvas(ctx);
    if(failure==='context')canvas.getContext=()=>null;
    if(failure==='draw')ctx.stroke=()=>{throw Error('raster unavailable');};
    if(failure==='transfer')canvas.transferToImageBitmap=()=>{throw Error('transfer unavailable');};
    const result=prepareVisualTile(fixture(),()=>canvas,{scale:8,x:3,y:5});
    assert.equal(result.stats.offscreen,false); assert.equal(result.commands.length,2);
    assert.equal(canvas.width,0); assert.equal(canvas.height,0);
    assert.deepEqual(result.view,{scale:8,x:3,y:5});
  }
});

test('same-parent virtual crops decode once while distinct provider and native keys decode separately', () => {
  const processor=createVisualTileProcessor({createCanvas:null});
  const key='provider-a/14/100/200', first=processor.prepare({buffer:fixture(),sourceKey:key,view:{scale:8,x:3,y:5}});
  const second=processor.prepare({sourceKey:key,view:{scale:8,x:4,y:5}});
  assert.equal(first.stats.decodedCacheHit,false); assert.equal(second.stats.decodedCacheHit,true);
  assert.notEqual(first.commands,second.commands); assert.deepEqual(first.commands,second.commands);
  assert.equal(processor.stats.decodeCalls,1); assert.equal(processor.stats.cacheHits,1);
  processor.prepare({buffer:fixture(),sourceKey:'provider-b/14/100/200'});
  processor.prepare({buffer:fixture(),sourceKey:'provider-a/14/101/200'});
  assert.equal(processor.stats.decodeCalls,3); assert.equal(processor.stats.decodedParents,3);
});

test('transferring fallback copies never detaches decoded-cache paths or another crop output', () => {
  let decoded; const processor=createVisualTileProcessor({createCanvas:()=>{throw Error('no OffscreenCanvas');},decode(buffer){return decoded=decodeVisualTile(buffer);}});
  const first=processor.prepare({buffer:fixture(),sourceKey:'parent',view:{scale:8,x:3,y:5}});
  const nativeBuffer=decoded.commands[0].paths[0].buffer;
  const transfer=first.commands.flatMap(command=>command.paths.map(points=>points.buffer));
  assert.ok(transfer.every(buffer=>buffer!==nativeBuffer));
  const delivered=structuredClone(first,{transfer});
  assert.equal(first.commands[0].paths[0].byteLength,0); assert.ok(nativeBuffer.byteLength>0);
  const second=processor.prepare({sourceKey:'parent',view:{scale:8,x:4,y:5}});
  assert.deepEqual(second.commands,delivered.commands); assert.equal(processor.stats.decodeCalls,1);
  delivered.commands[0].paths[0][0]=999;
  assert.notEqual(second.commands[0].paths[0][0],999); assert.notEqual(decoded.commands[0].paths[0][0],999);
});

test('decoded parent LRU retains no more than four and promotes reused parents', () => {
  const processor=createVisualTileProcessor({createCanvas:null});
  const load=sourceKey=>processor.prepare({buffer:fixture(),sourceKey});
  for(const key of ['a','b','c','d'])load(key);
  assert.equal(load('a').stats.decodedCacheHit,true); load('e');
  assert.equal(processor.stats.decodedParents,VISUAL_DECODED_CACHE_LIMIT);
  assert.equal(load('a').stats.decodedCacheHit,true);
  assert.equal(load('b').stats.decodedCacheHit,false);
  for(let i=0;i<20;i++) { load(`parent-${i}`); assert.ok(processor.stats.decodedParents<=4); assert.ok(processor.stats.decodedBytes<=VISUAL_DECODED_CACHE_BYTES); }
  const bytes=decodedVisualTileBytes(decodeVisualTile(fixture()),'parent-19');
  assert.equal(processor.stats.decodedBytes,bytes*4);
  processor.clear(); assert.equal(processor.stats.decodedParents,0); assert.equal(processor.stats.decodedBytes,0);
});

test('eight-MiB conservative command budget evicts below the four-parent count when needed', () => {
  const processor=createVisualTileProcessor({createCanvas:null,decode:()=>({commands:[{type:'line',paint:'road',paths:[new Float32Array(600000)]}],vertices:300000,features:1})});
  for(let i=0;i<4;i++)processor.prepare({sourceKey:`parent-${i}`});
  assert.equal(processor.stats.decodedParents,3);
  assert.ok(processor.stats.decodedBytes>3*2400000);
  assert.ok(processor.stats.decodedBytes<=8*1024*1024);
  assert.equal(processor.prepare({sourceKey:'parent-1'}).stats.decodedCacheHit,true);
  assert.equal(processor.prepare({sourceKey:'parent-0'}).stats.decodedCacheHit,false);
});

test('oversized decoded parents are returned uncached without evicting useful small parents', () => {
  const small=decodeVisualTile(fixture()), paths=[new Float32Array([0,0,1,1])];
  const large={commands:Array.from({length:20000},()=>({type:'line',paint:'road',paths})),vertices:40000,features:20000};
  assert.ok(decodedVisualTileBytes(large,'large')>VISUAL_DECODED_CACHE_BYTES);
  const processor=createVisualTileProcessor({createCanvas:null,decode:buffer=>buffer==='large'?large:small});
  processor.prepare({buffer:'small',sourceKey:'small'});
  const before=processor.stats.decodedBytes;
  for(let i=0;i<2;i++) {
    const result=processor.prepare({buffer:'large',sourceKey:'large'});
    assert.equal(result.commands.length,20000); assert.equal(result.stats.decodedCacheHit,false);
    assert.equal(processor.stats.decodedParents,1); assert.equal(processor.stats.decodedBytes,before);
  }
  assert.equal(processor.prepare({sourceKey:'small'}).stats.decodedCacheHit,true);
});

test('bad PBFs and invalid keys never enter the parent cache; absent keys keep old stateless behavior', () => {
  const processor=createVisualTileProcessor({createCanvas:null});
  assert.throws(()=>processor.prepare({buffer:new TextEncoder().encode('<html>bad</html>').buffer,sourceKey:'bad'}));
  assert.throws(()=>processor.prepare({buffer:fixture(),sourceKey:{}}),TypeError);
  assert.equal(processor.stats.decodedParents,0); assert.equal(processor.stats.decodedBytes,0);
  for(let i=0;i<2;i++)processor.prepare({buffer:fixture()});
  assert.equal(processor.stats.decodedParents,0); assert.equal(processor.stats.cacheHits,0);
  const stats=processor.stats; stats.decodedBytes=1e9; assert.equal(processor.stats.decodedBytes,0);
});

test('worker closes still-owned bitmaps on failed reply transfer and leaves successful transfers open', async () => {
  const prior={self:globalThis.self,OffscreenCanvas:globalThis.OffscreenCanvas};
  let listener, failTransfer=false; const bitmaps=[], sent=[];
  globalThis.OffscreenCanvas=class {
    constructor(width,height){this.width=width;this.height=height;}
    getContext(){return context();}
    transferToImageBitmap(){const bitmap={width:this.width,height:this.height,closes:0,close(){this.closes++;}};bitmaps.push(bitmap);return bitmap;}
  };
  globalThis.self={addEventListener(type,callback){listener=callback;},postMessage(message){if(message.type==='visual'&&failTransfer)throw Error('reply transfer failed');sent.push(message);}};
  try {
    await import(`../src/visual-tile.worker.js?transfer-cleanup=${Date.now()}`);
    listener({data:{type:'visual',requestId:1,key:'17/4/5',sourceKey:'14/0/0',buffer:fixture(),view:{scale:8,x:4,y:5}}});
    assert.equal(bitmaps[0].closes,0); assert.equal(sent[0].type,'visual');
    failTransfer=true;
    listener({data:{type:'visual',requestId:2,key:'17/5/5',sourceKey:'14/0/0',buffer:fixture(),view:{scale:8,x:5,y:5}}});
    assert.equal(bitmaps[1].closes,1); assert.equal(bitmaps[0].closes,0);
    assert.equal(sent[1].type,'error'); assert.equal(sent[1].requestId,2);
    failTransfer=false;
    listener({data:{type:'visual',requestId:3,key:'17/6/5',sourceKey:'14/0/0',buffer:fixture(),view:{scale:8,x:6,y:5}}});
    assert.equal(sent[2].stats.decodedCacheHit,true); assert.equal(bitmaps[2].closes,0);
  } finally {
    for(const [key,value] of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  }
});
