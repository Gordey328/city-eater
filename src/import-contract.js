/** Lightweight cache contract shared by main thread and import worker. */
export const OSM_IMPORT_PIPELINE='browser-osm-v1';
export function compatibleSectorCache(record,sector){
  const m=record?.manifest;
  if(!m||!Array.isArray(m.center)||m.center.length!==2||!Array.isArray(sector?.center)||sector.center.length!==2)return false;
  const basis=m.projectionLatitude??m.center[1],expectedBasis=sector.projectionLatitude??sector.center[1];
  const halfLongitude=5000/(6378137*Math.PI/180*Math.cos(expectedBasis*Math.PI/180));
  const crossesDateLine=Math.abs(sector.center[0])+halfLongitude>180;
  return Boolean(
    (!crossesDateLine||m.geometryWrap==='sector-center')&&record.id===sector.id&&m.id===sector.id&&m.arenaSize===10000&&m.chunkSize===1000&&Array.isArray(m.chunks)&&
    Number.isFinite(basis)&&Math.abs(basis)<=84.9&&Number.isFinite(expectedBasis)&&Math.abs(basis-expectedBasis)<1e-9&&
    m.center.every((v,i)=>Number.isFinite(v)&&Number.isFinite(sector.center[i])&&Math.abs(v-sector.center[i])<1e-7)&&
    record.provenance?.pipeline===OSM_IMPORT_PIPELINE&&typeof m.version==='string'&&m.version.startsWith(`osm-${OSM_IMPORT_PIPELINE}-`)&&
    m.background?.type==='geojson'&&m.background.data?.type==='FeatureCollection'&&Array.isArray(m.background.data.features)
  );
}
