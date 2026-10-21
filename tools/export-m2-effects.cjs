// Usage: node tools/export-m2-effects.cjs model.m2 model.json [model.effects.json]
const fs = require('node:fs');
const path = require('node:path');
const { decodeEffects } = require('../src/js/3D/loaders/M2Effects');
const [raw, metadata, destination] = process.argv.slice(2);
if (!raw || !metadata) throw new Error('Provide raw M2 and corresponding OBJ metadata JSON');
const effects = decodeEffects(fs.readFileSync(raw));
effects.textures = JSON.parse(fs.readFileSync(metadata, 'utf8').replace(/^\uFEFF/, '')).textures;
const output = destination || path.join(path.dirname(metadata), path.basename(metadata, '.json') + '.effects.json');
fs.writeFileSync(output, JSON.stringify(effects, null, 2), {flag:'wx'});
console.log(`${output}: ${effects.lights.length} lights, ${effects.particles.length} particles, ${effects.ribbons.length} ribbons`);
