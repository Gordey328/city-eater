import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewProject,overviewUnproject} from '../src/world-overview.js';
test('real overview Mercator coordinate selection round trips globally without a backend',()=>{for(const p of [[30.4158,59.7229],[-74,40.7],[139.7,35.7],[-179.5,-60],[179.5,60],[0,0]]){const q=overviewUnproject(overviewProject(p));assert.ok(Math.abs(q[0]-p[0])<1e-8);assert.ok(Math.abs(q[1]-p[1])<1e-8);}});
