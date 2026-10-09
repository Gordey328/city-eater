import test from 'node:test';
import assert from 'node:assert/strict';
import {CityPicker} from '../src/city-picker.js';
import {deriveManualBounds} from '../src/city-campaign.js';

test('regenerating an edited campaign draft clears stale saved-sector actions',()=>{
 const center=[29.84756,58.73876],nodes={
 '#city-sector-list':{children:[{oldCampaign:true}],replaceChildren(){this.children=[];}},
 '#city-name':{value:'Edited city'},'#city-extent':{},'#city-create':{disabled:true},
 };
 const picker={selection:{name:'Old city',center,bounds:deriveManualBounds(center,20,20),source:'manual'},existing:true,$:key=>nodes[key],drawPlan(){},status(message){throw new Error(message);}};
 CityPicker.prototype.updatePlan.call(picker);
 assert.equal(nodes['#city-sector-list'].children.length,0);
 assert.equal(picker.existing,false);
 assert.equal(picker.plan.title,'Edited city');
 assert.equal(picker.plan.sectorCount,4);
 assert.equal(nodes['#city-create'].disabled,false);
});

test('sector page controls reach distant unavailable-sector alternatives without importing on navigation',()=>{
 const previousDocument=globalThis.document,chosen=[];let focused=null;
 const node=tag=>({tag,children:[],disabled:false,append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},setAttribute(name,value){this[name]=value;},focus(){focused=this;}});
 const list=node('list'),find=(root,id)=>root.id===id?root:root.children.map(child=>find(child,id)).find(Boolean);
 globalThis.document={createElement:node};
 try{
  const c={sectors:Array.from({length:19},(_,i)=>({id:`s${i}`})),progress:{s0:{loadError:true}}};
  const picker={$:selector=>selector==='#city-sector-list'?list:find(list,selector.slice(1)),choose:(campaign,index)=>chosen.push([campaign,index]),renderSectorPage:CityPicker.prototype.renderSectorPage};
  picker.renderSectorPage(c,0);assert.equal(picker.$('#city-sector-range').textContent,'1–9 из 19');assert.equal(picker.$('#city-sectors-prev').disabled,true);
  picker.$('#city-sectors-next').onclick();assert.equal(picker.$('#city-sector-range').textContent,'10–18 из 19');assert.equal(chosen.length,0);assert.equal(focused.id,'city-sectors-next');
  picker.$('#city-sectors-next').onclick();assert.equal(picker.$('#city-sector-range').textContent,'19–19 из 19');assert.equal(picker.$('#city-sectors-next').disabled,true);assert.equal(list.children[0].disabled,false);
  list.children[0].onclick();assert.equal(chosen[0][0],c);assert.equal(chosen[0][1],18);
  picker.$('#city-sectors-prev').onclick();assert.equal(picker.$('#city-sector-range').textContent,'10–18 из 19');
 }finally{globalThis.document=previousDocument;}
});
