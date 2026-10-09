#!/usr/bin/env node
/** Offline replay only; never queries any data provider. Usage:
 * node scripts/compare_sector_payload.mjs raw-overpass.json sector.json
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {normalizeOSMSector} from '../src/osm-import.js';

const [sourcePath, sectorPath] = process.argv.slice(2);
if (!sourcePath || !sectorPath) {
  console.error('Usage: node scripts/compare_sector_payload.mjs raw-overpass.json sector.json');
  process.exitCode = 1;
} else {
  const raw = await fs.readFile(sourcePath, 'utf8');
  const source = JSON.parse(raw), sector = JSON.parse(await fs.readFile(sectorPath, 'utf8'));
  assert.ok(Array.isArray(source.elements), 'Input must be a complete Overpass JSON response');
  assert.ok(!source.remark, 'Partial Overpass responses cannot establish completeness');
  const lean = {...source, elements: source.elements.filter(element =>
    ['way', 'relation'].includes(element.type) && typeof element.tags?.building === 'string' && element.tags.building !== 'no')};
  const fullResult = normalizeOSMSector(source, sector), leanResult = normalizeOSMSector(lean, sector);
  const buildings = result => Object.values(result.chunks).flatMap(chunk => chunk.buildings).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(buildings(leanResult), buildings(fullResult), 'Building geometry and metrics must remain identical');
  const fullCompactBytes = Buffer.byteLength(JSON.stringify(source));
  const leanCompactBytes = Buffer.byteLength(JSON.stringify(lean));
  console.log(JSON.stringify({
    mode: 'offline replay; no provider requests', sourceTimestamp: source.osm3s?.timestamp_osm_base || null,
    originalResponseBytes: Buffer.byteLength(raw), fullCompactBytes, leanCompactBytes,
    comparablePayloadReductionPercent: Math.round((1 - leanCompactBytes / fullCompactBytes) * 10000) / 100,
    fullSourceElements: source.elements.length, leanSourceElements: lean.elements.length,
    buildingsIdentical: true, buildingCount: leanResult.manifest.buildingCount,
    totalBuildingArea: leanResult.manifest.totalBuildingArea,
    removedBackgroundFeatures: fullResult.background.data.features.length - leanResult.background.data.features.length,
    limitation: 'Decoded compact JSON comparison only. Not measured wire bytes, server time, browser RAM or performance on another city.',
  }, null, 2));
}
