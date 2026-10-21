import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dir, '..');
const installed = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'wow.export');
const output = path.join(root, 'bin', 'room-importer');
const installedVersion = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8')).version;
const sourceVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
if (installedVersion !== sourceVersion) throw new Error(`Installed runtime ${installedVersion} does not match source ${sourceVersion}`);
await fs.mkdir(output, {recursive:true});
// Reuse NW.js and native addon from the user's installed 0.2.19, excluding user data.
for (const entry of await fs.readdir(installed,{withFileTypes:true})) {
    if (entry.name === 'User Data' || entry.name === 'src' || entry.name === 'updater.exe') continue;
    await fs.cp(path.join(installed,entry.name),path.join(output,entry.name),{recursive:true});
}
const src = path.join(root,'src');
await fs.cp(src,path.join(output,'src'),{recursive:true,filter:p=>!p.endsWith('.js')});
await fs.mkdir(path.join(output,'src/js/workers'),{recursive:true});
await fs.copyFile(path.join(src,'js/workers/cache-collector.js'),path.join(output,'src/js/workers/cache-collector.js'));
await fs.copyFile(path.join(root,'node_modules/webp-wasm/webp_node_enc.wasm'),path.join(output,'src/webp_node_enc.wasm'));
const result = await Bun.build({entrypoints:[path.join(src,'app.js')],outdir:path.join(output,'src'),target:'node',format:'cjs',define:{'process.env.BUILD_RELEASE':'"true"'}});
if (!result.success) {console.error(result.logs);process.exit(1);}
const manifest = JSON.parse(await fs.readFile(path.join(installed,'package.json'),'utf8'));
manifest.name='wow.export.room-blueprint';
manifest.product_string='wow.export — Room Blueprint';
manifest.window.id='room-blueprint-export';
manifest.window.title='wow.export — Room Blueprint';
manifest.flavour='room-blueprint-local';
manifest.guid='room-blueprint-v1';
await fs.writeFile(path.join(output,'package.json'),JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(output,'Launch Room Blueprint.cmd'),'@echo off\r\nstart "" "%~dp0wow.export.exe" --disable-auto-update --user-data-dir="%~dp0User Data"\r\n');
console.log('Built portable exporter:', output);

