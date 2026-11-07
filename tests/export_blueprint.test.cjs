const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
test('batch export retains quantities, bundles textures and reports unresolved IDs',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'room-export-test-'));
 const attempted=[];
 class Helper {
   constructor(){} start(){} finish(){} isCancelled(){return false;} mark(){}
   static getExportPath(file){return path.join(folder,file);}
 }
 const utils={detect_model_type:()=>1,get_model_extension:()=>'.m2',async export_model(options){
   attempted.push(options.file_data_id);
   const model=options.export_path.replace(/\.m2$/,'.gltf');
   const shared=path.join(folder,'shared.png');await fs.writeFile(shared,'test-image');
   await fs.writeFile(model,JSON.stringify({asset:{version:'2.0'},images:[{uri:shared}],buffers:[]}));
 }};
 const stubs={
 '../install-type':{CASC:1}, '../db/caches/DBDecor':{}, '../casc/export-helper':Helper,
 '../casc/listfile':{getByID:()=>null,formatUnknownFile:(id,ext)=>id+ext},
 '../ui/model-viewer-utils':utils, '../room-blueprint':require('../src/js/room-blueprint')
 };
 const module={exports:{}};
 vm.runInNewContext(syncFs.readFileSync(path.join(root,'src/js/modules/tab_room_blueprint.js'),'utf8'),{module,require:key=>key in stubs?stubs[key]:require(key)});
 const ctx={...module.exports.data(),$core:{view:{isBusy:0,config:{modelsExportTextures:true},casc:{getFile:async id=>({id})}}}};
 ctx.blueprints=[{label:'test',items:[]}];ctx.items=[{decorID:1,name:'Two couches',count:2,modelFileDataID:100},{decorID:2,name:'Unresolved',count:1,modelFileDataID:null}];
 await module.exports.methods.export_blueprint.call(ctx);
 const run=(await fs.readdir(path.join(folder,'room-blueprints')))[0];
 const runPath=path.join(folder,'room-blueprints',run);
 const result=JSON.parse(await fs.readFile(path.join(runPath,'room-manifest.json')));
 assert.deepEqual(attempted,[100]);
 assert.equal(result.items[0].count,2);
 assert.equal(result.items[0].status,'exported');
 assert.equal(result.items[1].status,'failed');
 assert.equal(result.items[1].file,undefined);
 const gltf=JSON.parse(await fs.readFile(path.join(runPath,result.items[0].file)));
 assert.equal(gltf.images[0].uri,'decor-1-texture-0.png');
 assert.equal(await fs.readFile(path.join(runPath,gltf.images[0].uri),'utf8'),'test-image');
 assert.equal(ctx.exporting,false);
});

