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
