import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewProject,overviewUnproject} from '../src/world-overview.js';
test('real overview Mercator coordinate selection round trips globally without a backend',()=>{for(const p of [[30.4158,59.7229],[-74,40.7],[139.7,35.7],[-179.5,-60],[179.5,60],[0,0]]){const q=overviewUnproject(overviewProject(p));assert.ok(Math.abs(q[0]-p[0])<1e-8);assert.ok(Math.abs(q[1]-p[1])<1e-8);}});

test('overview repeated world copies normalize to the same longitude',()=>{for(const center of [[30,35],[-179,10],[179,-20]]){const p=overviewProject(center);for(const worlds of [-5,-2,-1,0,1,3])assert.ok(Math.abs(overviewUnproject([p[0]+worlds,p[1]])[0]-center[0])<1e-9);}});
