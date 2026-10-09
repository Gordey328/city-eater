import {ARENA_HALF_METRES, ARENA_SIZE_METRES} from './game-config.js';

/**
 * Source-independent, fixed-world consumption grid for the whole-building and partial modes.
 *
 * Game resolution is 2 m: a cell contributes 4 m² iff its centre lies in a real
 * building footprint. This is a raster approximation, not survey-grade area.
 * Grid origin is (-2500,-2500); y grows north. Byte bits are low-bit-first and
 * each chunk is 256×256 cells. Cells outside the fixed arena are always zero.
 * Coverage MUST describe a complete chunk after ALL intersecting source tiles
 * are available. Missing chunks are unknown, never assumed to contain buildings.
 * Consumed bits survive coverage eviction, source revisions and feature-ID changes.
 */
export const MASK_VERSION = 2;
export const MASK_CELL_METRES = 2;
export const MASK_CELL_AREA_M2 = 4;
export const MASK_ARENA_HALF = ARENA_HALF_METRES;
export const MASK_GRID_SIZE = ARENA_SIZE_METRES / MASK_CELL_METRES;
export const MASK_CHUNK_SIZE = 256;
export const MASK_CHUNK_BYTES = 8192;
export const MASK_CHUNKS_PER_AXIS = Math.ceil(MASK_GRID_SIZE / MASK_CHUNK_SIZE);
export const MASK_TOTAL_CELLS = MASK_GRID_SIZE ** 2;
export const MASK_CHUNK_COUNT = MASK_CHUNKS_PER_AXIS ** 2;
const CHUNK_METRES = MASK_CHUNK_SIZE * MASK_CELL_METRES;
const WORDS_PER_ROW = MASK_CHUNK_SIZE / 32;
const WORDS_PER_CHUNK = MASK_CHUNK_BYTES / 4;
const KEYS = Array.from({length: MASK_CHUNK_COUNT}, (_, n) => `${n % MASK_CHUNKS_PER_AXIS},${Math.floor(n / MASK_CHUNKS_PER_AXIS)}`);
const now = () => globalThis.performance?.now() ?? Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pointX = p => Array.isArray(p) ? p[0] : p?.x;
const pointY = p => Array.isArray(p) ? p[1] : p?.y;

function point(p) {
  const x = pointX(p), y = pointY(p);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('Expected a finite world-space point');
  return {x, y};
}
export function maskChunkKey(cx, cy) {
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= MASK_CHUNKS_PER_AXIS || cy >= MASK_CHUNKS_PER_AXIS)
    throw new RangeError(`Chunk coordinates must be integers in 0..${MASK_CHUNKS_PER_AXIS - 1}`);
  return KEYS[cy * MASK_CHUNKS_PER_AXIS + cx];
}
export function parseMaskChunkKey(key) {
  if (typeof key !== 'string' || key.length!==3 || !/^[0-9],[0-9]$/.test(key))
    throw new RangeError('Expected canonical arena chunk key "cx,cy"');
  const [cx, cy] = key.split(',').map(Number);
  return {cx, cy, index: cy * MASK_CHUNKS_PER_AXIS + cx};
}
export function maskCellAt(position) {
  const {x, y} = point(position);
  if (x < -MASK_ARENA_HALF || y < -MASK_ARENA_HALF || x >= MASK_ARENA_HALF || y >= MASK_ARENA_HALF) return null;
  // Addition can round the last representable in-arena coordinate to the edge.
  const gx = Math.min(MASK_GRID_SIZE-1,Math.floor((x + MASK_ARENA_HALF) / MASK_CELL_METRES));
  const gy = Math.min(MASK_GRID_SIZE-1,Math.floor((y + MASK_ARENA_HALF) / MASK_CELL_METRES));
  const cx = gx >>> 8, cy = gy >>> 8, localX = gx & 255, localY = gy & 255;
  return {gx, gy, cx, cy, localX, localY, key: KEYS[cy * MASK_CHUNKS_PER_AXIS + cx], bit: localY * 256 + localX};
}
export function maskChunkBounds(key) {
  const {cx, cy} = parseMaskChunkKey(key);
  return {minX: -MASK_ARENA_HALF + cx * CHUNK_METRES, minY: -MASK_ARENA_HALF + cy * CHUNK_METRES,
    maxX: Math.min(MASK_ARENA_HALF, -MASK_ARENA_HALF + (cx + 1) * CHUNK_METRES), maxY: Math.min(MASK_ARENA_HALF, -MASK_ARENA_HALF + (cy + 1) * CHUNK_METRES)};
}
/** Chunks touching a finite world-space bbox, clamped to the arena. */
export function maskChunksForBounds(bounds) {
  const b = Array.isArray(bounds) ? {minX:bounds[0], minY:bounds[1], maxX:bounds[2], maxY:bounds[3]} : bounds;
  if (!b || ![b.minX,b.minY,b.maxX,b.maxY].every(Number.isFinite) || b.minX > b.maxX || b.minY > b.maxY)
    throw new TypeError('Expected finite ordered bounds');
  if (b.maxX < -MASK_ARENA_HALF || b.maxY < -MASK_ARENA_HALF || b.minX >= MASK_ARENA_HALF || b.minY >= MASK_ARENA_HALF) return [];
  const x0 = clamp(Math.floor((b.minX+MASK_ARENA_HALF)/CHUNK_METRES),0,MASK_CHUNKS_PER_AXIS-1), y0 = clamp(Math.floor((b.minY+MASK_ARENA_HALF)/CHUNK_METRES),0,MASK_CHUNKS_PER_AXIS-1);
  const x1 = clamp(Math.floor((b.maxX+MASK_ARENA_HALF)/CHUNK_METRES),0,MASK_CHUNKS_PER_AXIS-1), y1 = clamp(Math.floor((b.maxY+MASK_ARENA_HALF)/CHUNK_METRES),0,MASK_CHUNKS_PER_AXIS-1);
  const keys = [];
  for (let cy=y0;cy<=y1;cy++) for (let cx=x0;cx<=x1;cx++) keys.push(KEYS[cy*MASK_CHUNKS_PER_AXIS+cx]);
  return keys;
}
export function countMaskBits(bits) {
  if (!(bits instanceof Uint8Array) || bits.byteLength !== MASK_CHUNK_BYTES) throw new TypeError('Expected an 8192-byte mask chunk');
  let count = 0;
  for (let i=0;i<bits.length;i++) count += popcount(bits[i]);
  return count;
}
function popcount(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
function rangeMask(lo, hi) { return ((0xffffffff << lo) & (0xffffffff >>> (31-hi))) >>> 0; }
function copyChunk(key, input) {
  if (!(input instanceof Uint8Array) || input.byteLength !== MASK_CHUNK_BYTES)
    throw new TypeError('Coverage must be an 8192-byte Uint8Array');
  const {cx,cy,index} = parseMaskChunkKey(key);
  const bits = new Uint8Array(input), words = new Uint32Array(bits.buffer);
  // Never reward padded cells in the last row/column of chunks.
  const width = Math.min(256, MASK_GRID_SIZE-cx*MASK_CHUNK_SIZE), height = Math.min(256,MASK_GRID_SIZE-cy*MASK_CHUNK_SIZE);
  if (height < 256) words.fill(0, height*WORDS_PER_ROW);
  if (width < 256) for (let row=0;row<height;row++) {
    const offset = row*WORDS_PER_ROW, completeWords=width>>>5, tail=width&31;
    if (tail) words[offset+completeWords] &= rangeMask(0,tail-1);
    words.fill(0,offset+completeWords+(tail?1:0),offset+WORDS_PER_ROW);
  }
  return {key,cx,cy,index,bits,words};
}
function emptyChunk(key, index) {
  const bits = new Uint8Array(MASK_CHUNK_BYTES);
  return {key,index,bits,words:new Uint32Array(bits.buffer)};
}
function shapeFor(from, to, radius) {
  const a=point(from), b=point(to);
  if (!Number.isFinite(radius) || radius<0) throw new RangeError('Radius must be finite and nonnegative');
  const dx=b.x-a.x, dy=b.y-a.y, length=Math.hypot(dx,dy);
  const shape={a,b,radius,r2:radius*radius,length,signature:`${a.x}/${a.y}/${b.x}/${b.y}/${radius}`,
    minY:Math.min(a.y,b.y)-radius,maxY:Math.max(a.y,b.y)+radius};
  if (length) {
    const nx=-dy/length*radius, ny=dx/length*radius;
    shape.rectangle=[a.x+nx,a.y+ny,b.x+nx,b.y+ny,b.x-nx,b.y-ny,a.x-nx,a.y-ny];
  }
  return shape;
}
/** Exact horizontal interval through a circle or swept-circle capsule. */
function shapeInterval(shape,y,out) {
  let min=Infinity,max=-Infinity;
  const {a,b,r2}=shape;
  const da=y-a.y;
  if (Math.abs(da)<=shape.radius) { const half=Math.sqrt(Math.max(0,r2-da*da)); min=a.x-half; max=a.x+half; }
  if (shape.length) {
    const db=y-b.y;
    if (Math.abs(db)<=shape.radius) { const half=Math.sqrt(Math.max(0,r2-db*db)); min=Math.min(min,b.x-half);max=Math.max(max,b.x+half); }
    const r=shape.rectangle;
    for (let i=0;i<8;i+=2) {
      const j=(i+2)&7, x1=r[i],y1=r[i+1],x2=r[j],y2=r[j+1];
      if (y1===y2) { if (y===y1) { min=Math.min(min,x1,x2);max=Math.max(max,x1,x2); } }
      else if (y>=Math.min(y1,y2) && y<=Math.max(y1,y2)) {
        const x=x1+(y-y1)*(x2-x1)/(y2-y1); min=Math.min(min,x);max=Math.max(max,x);
      }
    }
  }
  out.min=min;out.max=max;
}

export class ConsumptionMask {
  constructor(snapshot=null) {
    this.coverage=new Map();this.consumed=new Map();
    this.coverageSlots=new Array(MASK_CHUNK_COUNT);this.consumedSlots=new Array(MASK_CHUNK_COUNT);
    this.consumedCells=0;this.coverageRevision=0;this.consumedRevision=0;this.dirtyConsumed=new Set();
    if (snapshot) this.restore(snapshot);
  }
  get consumedAreaM2() { return this.consumedCells*MASK_CELL_AREA_M2; }
  get coverageBytes() { return this.coverage.size*MASK_CHUNK_BYTES; }
  get consumedBytes() { return this.consumed.size*MASK_CHUNK_BYTES; }
  /** Copies input. Only call once all source tiles intersecting this chunk are known. */
  ingestCoverage(key,bits) {
    const chunk=copyChunk(key,bits);
    this.coverage.set(key,chunk);this.coverageSlots[chunk.index]=chunk;this.coverageRevision++;
    return this;
  }
  evictCoverage(key) {
    const {index}=parseMaskChunkKey(key), existed=this.coverage.delete(key);
    if (existed) { this.coverageSlots[index]=undefined;this.coverageRevision++; }
    return existed;
  }
  clearCoverage() { this.coverage.clear();this.coverageSlots.fill(undefined);this.coverageRevision++; }
  /** Read-only views for the renderer; callers must not mutate returned arrays. */
  getCoverageChunk(key) { return this.coverage.get(key)?.bits ?? null; }
  getConsumedChunk(key) { return this.consumed.get(key)?.bits ?? null; }
  isConsumedAt(position) {
    const cell=maskCellAt(position);if (!cell) return false;
    const bits=this.getConsumedChunk(cell.key);
    return !!(bits && (bits[cell.bit>>>3] & (1<<(cell.bit&7))));
  }
  isCoveredAt(position) {
    const cell=maskCellAt(position);if (!cell) return false;
    const bits=this.getCoverageChunk(cell.key);
    // null distinguishes unknown coverage from known empty ground.
    return bits ? !!(bits[cell.bit>>>3] & (1<<(cell.bit&7))) : null;
  }
  consumeCircle(position,radius,options={}) { return this._consume(shapeFor(position,position,radius),options); }
  consumeSweep(from,to,radius,options={}) { return this._consume(shapeFor(from,to,radius),options); }
  /**
   * Consume exactly one caller-certified complete real building footprint.
   * The input contains its raster masks, never masks for its bounding box or
   * neighbouring buildings. Source completeness/identity is the caller's job.
   * Validate and copy every entry before doing any work. An unknown required
   * chunk returns an incomplete, zero-reward result without changing the mask.
   * Only footprint ∩ known coverage ∩ not-yet-consumed cells can earn area.
   */
  consumeBuildingChunks(records) {
    if (!records || typeof records[Symbol.iterator]!=='function')
      throw new TypeError('Expected iterable [key, Uint8Array] building chunks');
    const chunks=new Map();let entries=0;
    for (const entry of records) {
      if (++entries>MASK_CHUNK_COUNT || !Array.isArray(entry) || entry.length!==2 || chunks.has(entry[0]))
        throw new TypeError('Invalid or duplicate building chunk');
      const chunk=copyChunk(entry[0],entry[1]);chunks.set(chunk.key,chunk);
    }
    const unknownChunks=[...chunks.keys()].filter(key=>!this.coverage.has(key));
    if (unknownChunks.length) return {newCells:0,areaM2:0,changedChunks:[],unknownChunks,dirtyBounds:null,
      complete:false,cursor:null,rows:0,wordsVisited:0,consumedCells:this.consumedCells,consumedAreaM2:this.consumedAreaM2};

    const staged=new Map();let newCells=0,wordsVisited=0,minGX=Infinity,minGY=Infinity,maxGX=-Infinity,maxGY=-Infinity;
    for (const chunk of chunks.values()) {
      const coverage=this.coverageSlots[chunk.index],previous=this.consumedSlots[chunk.index];
      let consumed=null;
      for (let wi=0;wi<WORDS_PER_CHUNK;wi++) {
        const footprint=chunk.words[wi];if (!footprint) continue;
        wordsVisited++;
        const fresh=(footprint & coverage.words[wi] & ~(previous?.words[wi]??0))>>>0;
        if (!fresh) continue;
        if (!consumed) {
          consumed=previous?copyChunk(chunk.key,previous.bits):emptyChunk(chunk.key,chunk.index);
          staged.set(chunk.key,consumed);
        }
        consumed.words[wi]|=fresh;newCells+=popcount(fresh);
        const base=chunk.cx*MASK_CHUNK_SIZE+(wi%WORDS_PER_ROW)*32;
        const gy=chunk.cy*MASK_CHUNK_SIZE+Math.floor(wi/WORDS_PER_ROW);
        minGX=Math.min(minGX,base+31-Math.clz32((fresh&-fresh)>>>0));
        maxGX=Math.max(maxGX,base+31-Math.clz32(fresh));minGY=Math.min(minGY,gy);maxGY=Math.max(maxGY,gy);
      }
    }
    // Commit only after validation and delta construction succeeded everywhere.
    if (newCells) {
      this.consumedRevision++;this.consumedCells+=newCells;
      for (const [key,chunk] of staged) {
        chunk.revision=this.consumedRevision;this.consumed.set(key,chunk);this.consumedSlots[chunk.index]=chunk;
        this.dirtyConsumed.add(key);
      }
    }
    return {newCells,areaM2:newCells*MASK_CELL_AREA_M2,changedChunks:[...staged.keys()],unknownChunks:[],
      dirtyBounds:newCells?{minX:-MASK_ARENA_HALF+minGX*MASK_CELL_METRES,minY:-MASK_ARENA_HALF+minGY*MASK_CELL_METRES,
        maxX:-MASK_ARENA_HALF+(maxGX+1)*MASK_CELL_METRES,maxY:-MASK_ARENA_HALF+(maxGY+1)*MASK_CELL_METRES}:null,
      complete:true,cursor:null,rows:0,wordsVisited,consumedCells:this.consumedCells,consumedAreaM2:this.consumedAreaM2};
  }
  /**
   * Results are deltas for this batch. Resume with identical geometry and cursor.
   * maxRows bounds deterministic work; maxMilliseconds is a soft time budget
   * checked per row (one row always progresses). Unknown data may arrive later:
   * after coverageRevision changes, run the shape again to pick up those cells.
   */
  _consume(shape,{maxRows=Infinity,maxMilliseconds=Infinity,cursor=null}={}) {
    if (!(maxRows>0) || !(maxMilliseconds>=0) || (!Number.isInteger(maxRows) && maxRows!==Infinity))
      throw new RangeError('Expected positive integer maxRows and nonnegative maxMilliseconds');
    const first=Math.max(0,Math.ceil((shape.minY+MASK_ARENA_HALF)/MASK_CELL_METRES-0.5));
    const last=Math.min(MASK_GRID_SIZE-1,Math.floor((shape.maxY+MASK_ARENA_HALF)/MASK_CELL_METRES-0.5));
    let gy=first;
    if (cursor) {
      if (cursor.signature!==shape.signature || !Number.isInteger(cursor.nextRow) || cursor.nextRow<first || cursor.nextRow>last+1)
        throw new RangeError('Cursor does not match this circle or sweep');
      gy=cursor.nextRow;
    }
    let newCells=0,rows=0,wordsVisited=0,minGX=Infinity,minGY=Infinity,maxGX=-Infinity,maxGY=-Infinity;
    const changed=new Set(),unknown=new Set(),interval={min:0,max:0},started=now();
    for (;gy<=last;gy++) {
      if (rows && (rows>=maxRows || (maxMilliseconds!==Infinity && now()-started>=maxMilliseconds))) break;
      rows++;
      shapeInterval(shape,-MASK_ARENA_HALF+(gy+0.5)*MASK_CELL_METRES,interval);
      const gx0=Math.max(0,Math.ceil((interval.min+MASK_ARENA_HALF)/MASK_CELL_METRES-0.5));
      const gx1=Math.min(MASK_GRID_SIZE-1,Math.floor((interval.max+MASK_ARENA_HALF)/MASK_CELL_METRES-0.5));
      if (gx0>gx1) continue;
      const cy=gy>>>8,offset=(gy&255)*WORDS_PER_ROW;
      for (let cx=gx0>>>8;cx<=gx1>>>8;cx++) {
        const index=cy*MASK_CHUNKS_PER_AXIS+cx,coverage=this.coverageSlots[index];
        if (!coverage) {unknown.add(KEYS[index]);continue;}
        let consumed=this.consumedSlots[index];
        const lo=Math.max(0,gx0-cx*256),hi=Math.min(255,gx1-cx*256);
        for (let w=lo>>>5;w<=hi>>>5;w++) {
          wordsVisited++;
          const wi=offset+w,mask=rangeMask(w===(lo>>>5)?lo&31:0,w===(hi>>>5)?hi&31:31);
          const fresh=(coverage.words[wi] & ~(consumed?.words[wi] ?? 0) & mask)>>>0;
          if (!fresh) continue;
          if (!consumed) {
            consumed=emptyChunk(KEYS[index],index);this.consumed.set(consumed.key,consumed);this.consumedSlots[index]=consumed;
          }
          consumed.words[wi]|=fresh;
          newCells+=popcount(fresh);changed.add(KEYS[index]);
          const base=cx*256+w*32;
          minGX=Math.min(minGX,base+31-Math.clz32((fresh&-fresh)>>>0));
          maxGX=Math.max(maxGX,base+31-Math.clz32(fresh));minGY=Math.min(minGY,gy);maxGY=Math.max(maxGY,gy);
        }
      }
    }
    this.consumedCells+=newCells;
    if (newCells) {
      this.consumedRevision++;
      for (const key of changed) {this.consumed.get(key).revision=this.consumedRevision;this.dirtyConsumed.add(key);}
    }
    return {newCells,areaM2:newCells*MASK_CELL_AREA_M2,changedChunks:[...changed],unknownChunks:[...unknown],
      dirtyBounds:newCells?{minX:-MASK_ARENA_HALF+minGX*MASK_CELL_METRES,minY:-MASK_ARENA_HALF+minGY*MASK_CELL_METRES,maxX:-MASK_ARENA_HALF+(maxGX+1)*MASK_CELL_METRES,maxY:-MASK_ARENA_HALF+(maxGY+1)*MASK_CELL_METRES}:null,
      complete:gy>last,cursor:gy>last?null:{signature:shape.signature,nextRow:gy},rows,wordsVisited,
      consumedCells:this.consumedCells,consumedAreaM2:this.consumedAreaM2};
  }
  /**
   * Snapshot only dirty consumed chunks for incremental IndexedDB writes. Copies
   * are detached from live mutations. Save these with run state atomically; on
   * failure call markChunksDirty(records.keys()) so the latest bits are retried.
   */
  takeDirtyChunks() {
    const records=new Map();
    for (const key of this.dirtyConsumed) records.set(key,new Uint8Array(this.consumed.get(key).bits));
    this.dirtyConsumed.clear();return records;
  }
  markChunksDirty(keys) { for (const key of keys) if (this.consumed.has(key)) this.dirtyConsumed.add(key); }
  /** Atomically replaces all consumed chunks from binary IndexedDB records. */
  restoreConsumed(records) {
    if (!records || typeof records[Symbol.iterator]!=='function') throw new TypeError('Expected iterable [key, Uint8Array] records');
    const consumed=new Map(),slots=new Array(MASK_CHUNK_COUNT);let cells=0,entries=0;
    for (const entry of records) {
      if (++entries>MASK_CHUNK_COUNT || !Array.isArray(entry) || entry.length!==2 || consumed.has(entry[0])) throw new TypeError('Invalid or duplicate consumed chunk');
      const chunk=copyChunk(entry[0],entry[1]);
      consumed.set(chunk.key,chunk);slots[chunk.index]=chunk;cells+=countMaskBits(chunk.bits);
    }
    for (const [key,chunk] of consumed) if (!chunk.words.some(Boolean)) {consumed.delete(key);slots[chunk.index]=undefined;}
    this.consumed=consumed;this.consumedSlots=slots;this.consumedCells=cells;
    this.consumedRevision++;this.dirtyConsumed.clear();return this;
  }
  /** JSON-safe, stable snapshot containing consumed bits only; no source feature IDs. */
  serialize() {
    return {version:MASK_VERSION,cellMetres:MASK_CELL_METRES,arenaHalf:MASK_ARENA_HALF,chunkSize:MASK_CHUNK_SIZE,
      chunks:[...this.consumed.values()].sort((a,b)=>a.index-b.index).map(c=>[c.key,encodeBase64(c.bits)])};
  }
  /** Validates the entire snapshot before replacing current consumed bits. */
  restore(snapshot) {
    if (!snapshot || snapshot.version!==MASK_VERSION || snapshot.cellMetres!==MASK_CELL_METRES || snapshot.arenaHalf!==MASK_ARENA_HALF || snapshot.chunkSize!==MASK_CHUNK_SIZE ||
        !Array.isArray(snapshot.chunks) || snapshot.chunks.length>MASK_CHUNK_COUNT) throw new TypeError('Incompatible consumption mask snapshot');
    const records=snapshot.chunks.map(entry=>{
      if (!Array.isArray(entry) || entry.length!==2) throw new TypeError('Invalid consumed chunk');
      return [entry[0],decodeBase64(entry[1])];
    });
    return this.restoreConsumed(records);
  }
}
export const createConsumptionMask = snapshot => new ConsumptionMask(snapshot);

const BASE64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function encodeBase64(bytes) {
  let output='';
  for(let i=0;i<bytes.length;i+=3) {
    const value=(bytes[i]<<16)|((bytes[i+1]??0)<<8)|(bytes[i+2]??0);
    output+=BASE64[(value>>>18)&63]+BASE64[(value>>>12)&63]+(i+1<bytes.length?BASE64[(value>>>6)&63]:'=')+(i+2<bytes.length?BASE64[value&63]:'=');
  }
  return output;
}
function decodeBase64(value) {
  if (typeof value!=='string' || value.length!==Math.ceil(MASK_CHUNK_BYTES/3)*4 || !/^[A-Za-z0-9+/]+=$/.test(value))
    throw new TypeError('Invalid consumed chunk encoding');
  const bytes=new Uint8Array(MASK_CHUNK_BYTES);let write=0;
  for(let i=0;i<value.length;i+=4) {
    const a=BASE64.indexOf(value[i]),b=BASE64.indexOf(value[i+1]),c=BASE64.indexOf(value[i+2]),d=value[i+3]==='='?0:BASE64.indexOf(value[i+3]);
    const word=(a<<18)|(b<<12)|(c<<6)|d;
    if (write<bytes.length) bytes[write++]=(word>>>16)&255;
    if (write<bytes.length) bytes[write++]=(word>>>8)&255;
    if (write<bytes.length) bytes[write++]=word&255;
  }
  return bytes;
}

/**
 * Scanline rasterizer for worker use. Input is canonical MultiPolygon:
 * [ [outerRing, ...holeRings], ... ]; vertices may be [x,y] or {x,y}.
 * Union is explicit across polygons, including duplicate/overlapping buildings.
 * Outer edges use a deterministic half-open centre-sampling convention. Each
 * polygon's holes are removed before union, so a hole cannot erase another house.
 */
export function rasterizeCoverageChunk(key,polygons=[]) {
  const {cx,cy}=parseMaskChunkKey(key),bits=new Uint8Array(MASK_CHUNK_BYTES),union=new Uint32Array(bits.buffer);
  const scratch=new Uint32Array(WORDS_PER_CHUNK),intersections=[];
  const width=Math.min(256,MASK_GRID_SIZE-cx*MASK_CHUNK_SIZE),height=Math.min(256,MASK_GRID_SIZE-cy*MASK_CHUNK_SIZE);
  const originX=-MASK_ARENA_HALF+cx*CHUNK_METRES,originY=-MASK_ARENA_HALF+cy*CHUNK_METRES;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon[0]?.length) continue;
    let outerMinX=Infinity,outerMinY=Infinity,outerMaxX=-Infinity,outerMaxY=-Infinity;
    for (const p of polygon[0]) {
      const x=pointX(p),y=pointY(p);
      if (!Number.isFinite(x)||!Number.isFinite(y)) throw new TypeError('Non-finite raster polygon vertex');
      outerMinX=Math.min(outerMinX,x);outerMaxX=Math.max(outerMaxX,x);
      outerMinY=Math.min(outerMinY,y);outerMaxY=Math.max(outerMaxY,y);
    }
    if (outerMaxX<originX || outerMinX>=originX+width*2 || outerMaxY<originY || outerMinY>=originY+height*2) continue;
    scratch.fill(0);
    for (let r=0;r<polygon.length;r++) {
      const ring=polygon[r];if (!Array.isArray(ring) || ring.length<3) continue;
      let minY=Infinity,maxY=-Infinity;
      for (const p of ring) {
        const x=pointX(p),y=pointY(p);
        if (!Number.isFinite(x)||!Number.isFinite(y)) throw new TypeError('Non-finite raster polygon vertex');
        minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      }
      const y0=Math.max(0,Math.ceil((minY-originY)/2-0.5)),y1=Math.min(height-1,Math.ceil((maxY-originY)/2-0.5)-1);
      for(let ly=y0;ly<=y1;ly++) {
        const y=originY+ly*2+1;intersections.length=0;
        for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
          const a=ring[j],b=ring[i],ay=pointY(a),by=pointY(b);
          if ((ay>y)!==(by>y)) intersections.push(pointX(a)+(y-ay)*(pointX(b)-pointX(a))/(by-ay));
        }
        intersections.sort((a,b)=>a-b);
        for(let i=0;i+1<intersections.length;i+=2) {
          const lo=Math.max(0,Math.ceil((intersections[i]-originX)/2-0.5));
          const hi=Math.min(width-1,Math.ceil((intersections[i+1]-originX)/2-0.5)-1);
          if(lo>hi) continue;
          for(let w=lo>>>5;w<=hi>>>5;w++) {
            const mask=rangeMask(w===(lo>>>5)?lo&31:0,w===(hi>>>5)?hi&31:31),index=ly*WORDS_PER_ROW+w;
            if(r===0) scratch[index]|=mask;else scratch[index]&=~mask;
          }
        }
      }
    }
    for(let i=0;i<WORDS_PER_CHUNK;i++) union[i]|=scratch[i];
  }
  return bits;
}
