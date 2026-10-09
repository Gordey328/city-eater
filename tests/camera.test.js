import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraMetrics,streamingExtent,HOLE_SCREEN_DIAMETER} from '../src/camera.js';
import {advanceHole} from '../src/motion.js';
test('camera zoom decreases immediately and smoothly with early and late growth',()=>{for(const viewport of [[390,844],[1280,800],[844,390]]){let previous=Infinity;for(const radius of [13,18,21,36,100,250,500]){const m=cameraMetrics(radius,...viewport,59.7229);assert.ok(m.zoom<previous);previous=m.zoom;assert.ok(Math.abs(2*m.radiusPixels/Math.min(...viewport)-HOLE_SCREEN_DIAMETER)<1e-9);assert.ok(m.zoom>=10.5&&m.zoom<=19);}}});
test('doubling radius zooms out exactly one level with MapLibre 512px world scaling',()=>{const a=cameraMetrics(18,390,844,60),b=cameraMetrics(36,390,844,60);assert.ok(Math.abs(a.zoom-b.zoom-1)<1e-10);assert.ok(a.zoom>16&&a.zoom<17);});
test('rectangular streamed area covers visible camera and preserves a local short axis',()=>{for(const size of [[390,844],[1280,800],[800,800]])for(const radius of [18,100,500]){const c=cameraMetrics(radius,...size,60),s=streamingExtent(radius,...size,60);assert.ok(s.x>=c.halfWidth+249);assert.ok(s.y>=c.halfHeight+249);assert.ok(Math.min(s.x,s.y)<3000);}});
test('current gameplay motion passes freely through building positions and stops only at arena',()=>{assert.deepEqual(advanceHole([0,0],[100,200],18),[100,200]);assert.deepEqual(advanceHole([4900,-4900],[400,-400],18),[4982,-4982]);assert.deepEqual(advanceHole([0,0],[8000,20],500),[4500,20]);assert.deepEqual(advanceHole([0,0],[0,0],18),[0,0]);});
