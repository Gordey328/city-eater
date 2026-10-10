import {reconstructWaterBoundary,rasterizeWaterRegion,validateWaterBoundary} from './water-boundary.js';
import {prepareLandGeometry} from './land-region.js';
export class WaterBoundaryProcessor{
  async process(message){
    if(message.type==='water-validate')return{type:'water-validate',boundary:await validateWaterBoundary(message.boundary,message.manifest)};
    if(message.type==='water-boundary')return{type:'water-boundary',boundary:await reconstructWaterBoundary(message.tiles,message.manifest)};
    if(message.type==='water-region'){
      const result=await rasterizeWaterRegion(message.boundary,message.regionId,message.manifest);
      const region=message.boundary.regions.find(region=>region.id===message.regionId);
      const preparedGeometry=prepareLandGeometry({polygons:region.polygons,waterPolygons:message.boundary.waterPolygons,domainBounds:message.boundary.domainBounds});
      return{type:'water-region',regionId:message.regionId,...result,preparedGeometry};
    }
    throw new Error('Неизвестная операция береговой линии.');
  }
}
if(typeof self!=='undefined'&&typeof self.postMessage==='function'&&typeof document==='undefined'){
  const processor=new WaterBoundaryProcessor();let queue=Promise.resolve();
  self.addEventListener('message',event=>{
    const message=event.data;if(!['water-boundary','water-region','water-validate'].includes(message?.type))return;
    queue=queue.then(async()=>{
      try{const result=await processor.process(message);self.postMessage({requestId:message.requestId,...result},result.chunks?result.chunks.map(([,bits])=>bits.buffer):[]);}
      catch(error){self.postMessage({type:'error',requestId:message.requestId,code:error.code,message:error.message||'Не удалось проверить береговую линию.'});}
    });
  });
}
