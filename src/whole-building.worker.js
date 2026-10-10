import {reconstructWholeBuildings,rasterizeWholeBuildings,rasterizeWholeBuildingsSeparately} from './whole-building.js';
export class WholeBuildingProcessor {
  constructor(){this.generation=null;this.catalog=new Map();}
  process(message){
    if(message.type==='catalog'){
      const result=reconstructWholeBuildings(message.tiles,message.manifest,{generation:message.generation});
      this.generation=message.generation;this.catalog=new Map(result.buildings.map(building=>[building.id,building]));
      return{type:'catalog',generation:this.generation,...result};
    }
    if(message.type==='whole-raster'||message.type==='whole-raster-separate'){
      if(message.generation!==this.generation||!Array.isArray(message.ids))throw new Error('Каталог домов уже изменился.');
      if(message.type==='whole-raster-separate'&&message.ids.length>16)throw new Error('Слишком много отдельных домов.');
      const buildings=[...new Set(message.ids)].map(id=>{const building=this.catalog.get(id);if(!building)throw new Error('Дом не относится к текущему каталогу.');return building;});
      return message.type==='whole-raster-separate'
        ?{type:'whole-raster-separate',generation:this.generation,items:rasterizeWholeBuildingsSeparately(buildings)}
        :{type:'whole-raster',generation:this.generation,chunks:rasterizeWholeBuildings(buildings)};
    }
    throw new Error('Неизвестная операция целых зданий.');
  }
}
if(typeof self!=='undefined'&&typeof self.postMessage==='function'&&typeof document==='undefined'){
  const processor=new WholeBuildingProcessor();
  self.addEventListener('message',event=>{
    const message=event.data;if(!['catalog','whole-raster','whole-raster-separate'].includes(message?.type))return;
    try{const result=processor.process(message);self.postMessage({requestId:message.requestId,...result},result.items?result.items.flatMap(item=>item.chunks.map(([,bits])=>bits.buffer)):result.chunks?result.chunks.map(([,bits])=>bits.buffer):[]);}
    catch(error){self.postMessage({type:'error',requestId:message.requestId,message:error.message||'Не удалось восстановить дом.'});}
  });
}
