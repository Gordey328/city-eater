import {MASK_ARENA_HALF,MASK_CHUNKS_PER_AXIS,maskChunkBounds} from './consumption-mask.js';
/** One cached bitmap per resident 512m region, never a growing GeoJSON history. */
export class MaskDisplay {
  constructor(mask){this.mask=mask;this.images=new Map();this.dirty=new Set();this.replacements=new Map();this.stats={rebuiltChunks:0,drawnChunks:0};}
  changed(key){this.dirty.add(key);}
  setReplacements(chunks){for(const key of this.replacements.keys())this.dirty.add(key);for(const key of chunks.keys())this.dirty.add(key);this.replacements=chunks;}
  dispose(){this.images.clear();this.dirty.clear();this.replacements.clear();}
  update(){
    for(const key of this.images.keys())if(!this.mask.getCoverageChunk(key))this.images.delete(key);
    for(const key of this.mask.coverage.keys())if(!this.images.has(key))this.dirty.add(key);
    for(const key of this.dirty){
      const coverage=this.mask.getCoverageChunk(key);if(!coverage){this.images.delete(key);continue;}
      let image=this.images.get(key);
      if(!image){const canvas=document.createElement('canvas');canvas.width=canvas.height=256;image={canvas,context:canvas.getContext('2d'),pixels:new ImageData(256,256)};this.images.set(key,image);}
      const eaten=this.mask.getConsumedChunk(key),replaced=this.replacements.get(key),pixels=image.pixels.data;
      // The world bit order increases north; bitmap rows increase down.
      for(let byte=0;byte<coverage.length;byte++){
        const visible=coverage[byte]&~(eaten?.[byte]||0)&~(replaced?.[byte]||0),base=byte*8;
        for(let bit=0;bit<8;bit++){const index=base+bit,x=index&255,y=index>>>8,p=((255-y)*256+x)*4;pixels[p]=144;pixels[p+1]=169;pixels[p+2]=102;pixels[p+3]=(visible&(1<<bit))?255:0;}
      }
      image.context.putImageData(image.pixels,0,0);this.stats.rebuiltChunks++;
    }
    this.dirty.clear();
  }
  draw(renderer){
    this.update();const c=renderer.ctx;this.stats.drawnChunks=0;c.save();c.imageSmoothingEnabled=false;
    // Unknown gameplay coverage is visibly tinted, even if lower-detail roads
    // are already available. It never looks like verified empty ground.
    c.fillStyle='#e9c77344';this.stats.unknownVisibleChunks=0;
    for(let y=0;y<MASK_CHUNKS_PER_AXIS;y++)for(let x=0;x<MASK_CHUNKS_PER_AXIS;x++){if(this.mask.getCoverageChunk(`${x},${y}`))continue;const west=-MASK_ARENA_HALF+x*512,south=-MASK_ARENA_HALF+y*512,a=renderer.project([west,Math.min(MASK_ARENA_HALF,south+512)]),b=renderer.project([Math.min(MASK_ARENA_HALF,west+512),south]);if(b[0]<0||a[0]>renderer.width||b[1]<0||a[1]>renderer.height)continue;c.fillRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);this.stats.unknownVisibleChunks++;}
    for(const [key,image] of this.images){const [x,y]=key.split(',').map(Number),west=-MASK_ARENA_HALF+x*512,south=-MASK_ARENA_HALF+y*512;
      const a=renderer.project([west,south+512]),b=renderer.project([west+512,south]);
      if(b[0]<0||a[0]>renderer.width||b[1]<0||a[1]>renderer.height)continue;
      c.drawImage(image.canvas,a[0],a[1],b[0]-a[0],b[1]-a[1]);this.stats.drawnChunks++;
    }
    c.restore();
  }
}
