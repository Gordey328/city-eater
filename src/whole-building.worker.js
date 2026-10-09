import {reconstructWholeBuildings,rasterizeWholeBuildings} from './whole-building.js';
export class WholeBuildingProcessor {
  constructor(){this.generation=null;this.catalog=new Map();}
  process(message){
    if(message.type==='catalog'){
      const result=reconstructWholeBuildings(message.tiles,message.manifest,{generation:message.generation});
      this.generation=message.generation;this.catalog=new Map(result.buildings.map(building=>[building.id,building]));
      return{type:'catalog',generation:this.generation,...result};
    }
    if(message.type==='whole-raster'){
      if(message.generation!==this.generation||!Array.isArray(message.ids))throw new Error('Каталог домов уже изменился.');
      const buildings=[...new Set(message.ids)].map(id=>{const building=this.catalog.get(id);if(!building)throw new Error('Дом не относится к текущему каталогу.');return building;});
      return{type:'whole-raster',generation:this.generation,chunks:rasterizeWholeBuildings(buildings)};
    }
    throw new Error('Неизвестная операция целых зданий.');
  }
}
if(typeof self!=='undefined'&&typeof self.postMessage==='function'&&typeof document==='undefined'){
  const processor=new WholeBuildingProcessor();
  self.addEventListener('message',event=>{
    const message=event.data;if(!['catalog','whole-raster'].includes(message?.type))return;
    try{const result=processor.process(message);self.postMessage({requestId:message.requestId,...result},result.chunks?result.chunks.map(([,bits])=>bits.buffer):[]);}
    catch(error){self.postMessage({type:'error',requestId:message.requestId,message:error.message||'Не удалось восстановить дом.'});}
  });
}
