const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const bridge = require('../src/js/room-blueprint');
test('SavedVariables is parsed as data, never executed', () => {
  const result = bridge.parseSavedVariables('RoomProbeDB = { ["blueprints"] = {}, ["text"] = "a\\n\\\"b", true, 1.2e-3, }');
  assert.equal(result.text, 'a\n"b');
  assert.equal(result[2], .0012);
  assert.throws(() => bridge.parseSavedVariables('RoomProbeDB = {}; os.execute("evil")'));
  assert.throws(() => bridge.parseSavedVariables('RoomProbeDB = { ["x"] = function() end }'));
  assert.throws(() => bridge.parseSavedVariables('RoomProbeDB = { ["x"] = {}() }'));
});
test('real living room: five models, six instances, missing inventory is included', () => {
  const room = JSON.parse(fs.readFileSync('tests/fixtures/livingroom.json'))[0];
  const raw = {shareCode:room.shareCode, contentGroups:[...room.otherGroups, {contentType:3, entries:room.items.flatMap(i=>i.variants)}]};
  const report = {blueprints:[{event:'HOUSING_BLUEPRINT_CONTENTS_RECEIVED',label:'livingroom',args:{1:raw}}]};
  const normalized = bridge.readBlueprints(JSON.stringify(report))[0];
  assert.equal(normalized.items.length,5);
  assert.equal(normalized.items.reduce((n,i)=>n+i.count,0),6);
  assert.equal(normalized.items.find(i=>i.decorID===1738).count,2);
  assert.equal(normalized.otherGroups[0].entries[1].recordID,9);
  const resolved=bridge.resolveInventory(normalized,id=>id===1738?{modelFileDataID:999,name:'Couch'}:undefined);
  assert.equal(resolved.find(i=>i.decorID===1738).modelFileDataID,999);
  assert.equal(resolved.find(i=>i.decorID===1704).status,'unresolved');
});
test('variants aggregate but room and decor IDs never mix',()=>{
 const room=bridge.normalizeContents({contentGroups:[{contentType:2,entries:[{recordID:1,total:1}]},
 {contentType:3,entries:[{recordID:1,total:2,name:'A'},{recordID:1,total:3,name:'A'}]}]},'test');
 assert.equal(room.items.length,1); assert.equal(room.items[0].count,5); assert.equal(room.items[0].variants.length,2);
 assert.throws(()=>bridge.normalizeContents({contentGroups:[{contentType:3,entries:[{recordID:1,total:-1}]}]}));
 assert.throws(()=>bridge.readBlueprints('{"blueprints":{}}'));
});

