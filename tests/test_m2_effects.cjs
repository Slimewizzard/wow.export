const assert=require('node:assert/strict');
const fs=require('node:fs');
const {decodeEffects}=require('../src/js/3D/loaders/M2Effects');
const base=process.argv[2];
if(!base)throw Error('Supply directory containing the two raw fireplace M2 files');
for(const [name,lights,particles] of [["OldSalt'sFireplace",1,3],['SturdyFireplace',2,4]]){
 const raw=fs.readFileSync(require('node:path').join(base,name+'.m2'));
 const result=decodeEffects(raw);
 assert.equal(result.lights.length,lights);assert.equal(result.particles.length,particles);assert.equal(result.ribbons.length,0);
 assert.throws(()=>decodeEffects(raw.subarray(0,100)));
 const corrupt=Buffer.from(raw);corrupt.writeUInt32LE(999,12);assert.throws(()=>decodeEffects(corrupt),/version/);
 const badOffset=Buffer.from(raw);badOffset.writeUInt32LE(0xffffffff,8+0x12c);assert.throws(()=>decodeEffects(badOffset),/offset/);
}
console.log('Effects decoder checks passed');
