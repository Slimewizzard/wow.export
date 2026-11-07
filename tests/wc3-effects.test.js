const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const AdmZip = require('adm-zip');
const { Warcraft3Storage } = require('../src/js/warcraft3/storage');
const { sequenceGate, sampleEmitters, exportEffectPackage } = require('../src/js/warcraft3/effects');
const { parseModel } = require('../src/js/warcraft3/model');
const { decodeTexture } = require('../src/js/warcraft3/textures');

// The exporter writes unfiltered RGBA PNGs; inspect exact bytes without a GPU.
function exportedPNG(bytes) {
	const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), chunks = [];
	for (let p = 8; p < bytes.length; p += bytes.readUInt32BE(p) + 12)
		if (bytes.toString('ascii', p + 4, p + 8) === 'IDAT') chunks.push(bytes.subarray(p + 8, p + 8 + bytes.readUInt32BE(p)));
	const rows = zlib.inflateSync(Buffer.concat(chunks)), pixels = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		assert.equal(rows[y * (width * 4 + 1)], 0);
		rows.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
	}
	return { width, height, pixels };
}

test('effect references resolve compiled bakes in the correct art overlay', () => {
	const storage = new Warcraft3Storage('unused');
	storage.files = new Map(['war3.w3mod/_de.w3mod/sharedfx/glow.pkb', 'war3.w3mod/_hd.w3mod/sharedfx/glow.pkb', 'war3.w3mod/sharedfx/glow.pkb'].map(n => [n, {}]));
	assert.equal(storage.resolveEffect('SharedFX\\Glow.pkfx', 'war3.w3mod/_de.w3mod/units/hero.mdx'), 'war3.w3mod/_de.w3mod/sharedfx/glow.pkb');
	assert.equal(storage.resolveEffect('SharedFX/Glow.pkfx', 'war3.w3mod/_hd.w3mod/units/hero.mdx'), 'war3.w3mod/_hd.w3mod/sharedfx/glow.pkb');
	assert.equal(storage.resolveEffect('SharedFX/Glow.pkfx', 'war3.w3mod/units/hero.mdx'), 'war3.w3mod/sharedfx/glow.pkb');
	assert.equal(storage.resolveEffect('missing.pkfx', 'war3.w3mod/units/hero.mdx'), null);
});

test('Popcorn visibility guides respect sequence prefixes, specific overrides and spelling variants', () => {
	const guide = 'Always=off,Stand=on,Stand Channel=off,Spell 1=on';
	assert.equal(sequenceGate(guide, 'Stand 2'), true);
	assert.equal(sequenceGate(guide, 'Stand Channel 1'), false);
	assert.equal(sequenceGate(guide, 'Spell 1'), true);
	assert.equal(sequenceGate(guide, 'Death'), false);
	assert.equal(sequenceGate('Alwyas=on,Death=off', 'Stand'), true);
	assert.equal(sequenceGate('Alwyas=on,Death=off', 'Death 2'), false);
});

test('existing Blender packages skip before resolving the helper or reading the source', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-wc3-fx-test-'));
	try {
		await fs.writeFile(path.join(root, 'effect.pkb.wc3fx'), 'keep existing');
		await assert.rejects(exportEffectPackage({ readFile() { throw new Error('Source must not be read'); } }, 'effect.pkb', root, { helper: 'does-not-exist.exe' }), { code: 'EEXIST' });
		assert.equal(await fs.readFile(path.join(root, 'effect.pkb.wc3fx'), 'utf8'), 'keep existing');
	} finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }
});

test('ordinary MDX models export Blender packages without an effect baker', { skip: !process.env.WC3_INSTALL }, async () => {
	const storage = await new Warcraft3Storage(process.env.WC3_INSTALL).open();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-wc3-fx-test-'));
	try {
		for (const relative of ['herofemaledemonhunter/herodemonhunter', 'druidofthetalon/druidofthetalon', 'runner/runner']) {
			const name = 'war3.w3mod/_hd.w3mod/units/nightelf/' + relative + '.mdx';
			const result = await exportEffectPackage(storage, name, root, { animationMode: 'current', helper: path.join(root, 'must-not-run.exe'), effectSeconds: 1, effectFPS: 15 });
			const zip = new AdmZip(await fs.readFile(result.file)), meta = JSON.parse(zip.readAsText('manifest.json'));
			assert.equal(meta.model, 'model.glb'); assert.ok(meta.sequence);
			assert.deepEqual(meta.batches, []); assert.equal(meta.totalSprites, 0);
			assert.equal(meta.frameCount, 16); assert.deepEqual(meta.frameOffsets, Array(16).fill(8));
			assert.deepEqual(zip.readFile(meta.cache), Buffer.from([87, 51, 70, 88, 1, 0, 0, 0]));
			assert.deepEqual(zip.readFile('sources/model.mdx'), await storage.readFile(name));
			assert.ok(meta.warnings.some(w => /No PopcornFX emitters/.test(w)));
			assert.ok(meta.warnings.some(w => /Classic particles/.test(w)));
			const glb = zip.readFile(meta.model), doc = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
			assert.ok(doc.meshes.length && doc.images.length);
			assert.equal(doc.animations.length, 1); assert.equal(doc.animations[0].name, meta.sequence);
			await assert.rejects(exportEffectPackage(storage, name, root), { code: 'EEXIST' });
		}
	} finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }
});

test('all-animation packages retain every skeletal clip and bake independent effect caches', { skip: !process.env.WC3_INSTALL }, async () => {
	const storage = await new Warcraft3Storage(process.env.WC3_INSTALL).open();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-wc3-fx-test-'));
	try {
		for (const [relative, expectedClips] of [['_hd.w3mod/units/nightelf/archer/archer', 17], ['_de.w3mod/doodads/northrend/props/firepit/firepit', 3]]) {
			const name = 'war3.w3mod/' + relative + '.mdx';
			const model = parseModel(await storage.readFile(name));
			const color = [0.2, 0.4, 0.8];
			const result = await exportEffectPackage(storage, name, root, { animationMode: 'all', sequence: 1, effectSeconds: 0.5, effectFPS: 15, teamColor: color });
			const zip = new AdmZip(await fs.readFile(result.file)), meta = JSON.parse(zip.readAsText('manifest.json'));
			assert.equal(meta.schema, 'wow.export.wc3fx.v2'); assert.equal(meta.defaultClip, 1);
			assert.equal(meta.clips.length, expectedClips);
			assert.deepEqual(meta.clips.map(c => c.sequence), model.Sequences.map(s => s.Name));
			assert.equal(new Set(meta.clips.map(c => c.cache)).size, expectedClips);
			for (const [i, clip] of meta.clips.entries()) {
				assert.equal(clip.sequenceIndex, i);
				assert.equal(clip.modelDuration, (model.Sequences[i].Interval[1] - model.Sequences[i].Interval[0]) / 1000);
				assert.equal(zip.readFile(clip.cache).toString('ascii', 0, 4), 'W3FX');
			}
			const glb = zip.readFile(meta.model), doc = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
			assert.deepEqual(doc.animations.map(a => a.name), meta.clips.map(c => c.sequence));
			if (expectedClips === 17) {
				assert.deepEqual(meta.teamColor.color, color);
				assert.ok(meta.teamColor.materials.length > 1);
				const checked = new Set();
				for (const entry of meta.teamColor.materials) {
					const material = doc.materials[entry.material];
					assert.equal(material.extras.wc3_team_material, entry.material);
					if (checked.has(entry.base)) continue;
					checked.add(entry.base);
					const base = exportedPNG(zip.readFile(entry.base)), mask = exportedPNG(zip.readFile(entry.mask));
					const image = doc.images[doc.textures[material.pbrMetallicRoughness.baseColorTexture.index].source];
					const view = doc.bufferViews[image.bufferView], start = 28 + glb.readUInt32LE(12) + view.byteOffset;
					const baked = exportedPNG(glb.subarray(start, start + view.byteLength));
					const original = decodeTexture(await storage.readFile(storage.resolveTexture(image.name, name)));
					assert.deepEqual(base.pixels, Buffer.from(original.data), 'Untinted pixels must preserve original channels');
					assert.equal(mask.width, base.width); assert.equal(mask.height, base.height);
					let tinted = 0, untinted = 0;
					for (let p = 0; p < base.pixels.length; p += 4) {
						const amount = mask.pixels[p] / 255;
						if (amount) tinted++; else untinted++;
						assert.equal(base.pixels[p + 3], baked.pixels[p + 3], 'Team mask must not alter texture opacity');
						for (let c = 0; c < 3; c++) assert.ok(Math.abs(baked.pixels[p + c] - base.pixels[p + c] * (1 - amount + amount * color[c])) <= 0.51);
					}
					assert.ok(tinted && untinted, 'Archer mask should distinguish colored areas from skin/other surfaces');
				}
				assert.ok(meta.clips.every(c => c.batches.length === 0 && c.frameCount === 1));
				assert.equal(meta.clips.find(c => c.sequence === 'Decay Flesh').modelDuration, 60);
				const tracks = label => {
					const animation = doc.animations.find(a => a.name === label);
					return animation.samplers.map(s => {
						const a = doc.accessors[s.output], view = doc.bufferViews[a.bufferView];
						const start = 28 + glb.readUInt32LE(12) + view.byteOffset;
						return glb.subarray(start, start + view.byteLength);
					});
				};
				assert.deepEqual(tracks('Stand 4'), tracks('Stand Hit 1'), 'shared MDX intervals must produce identical poses');
			} else {
				assert.ok(meta.clips.some(c => c.totalSprites > 0));
				assert.ok(meta.clips.every(c => c.frameCount === 9));
				assert.ok(meta.clips.flatMap(c => c.batches).some(b => b.image && zip.getEntry(b.image)));
				assert.notDeepEqual(zip.readFile(meta.clips[0].cache), zip.readFile(meta.clips[1].cache), 'different animations have separate simulations');
			}
		}
	} finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }
});

test('real effects: package dependencies, finite cached particles, unsupported renderers and animated emitter transforms', { skip: !process.env.WC3_INSTALL }, async () => {
	const storage = await new Warcraft3Storage(process.env.WC3_INSTALL).open();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-wc3-fx-test-'));
	try {
		const name = 'war3.w3mod/_de.w3mod/doodads/northrend/props/firepit/firepit.pkb';
		const result = await exportEffectPackage(storage, name, root, { effectSeconds: 1, effectFPS: 30 });
		const zip = new AdmZip(await fs.readFile(result.file)), manifest = JSON.parse(zip.readAsText('manifest.json')), data = zip.readFile('frames.bin');
		assert.deepEqual(zip.readFile('sources/effect-0.pkb'), await storage.readFile(name));
		assert.ok(manifest.batches.filter(b => b.image).length > 3);
		assert.equal(manifest.frameCount, 31); assert.equal(data.toString('ascii', 0, 4), 'W3FX');
		let end = 8, particles = 0;
		for (const offset of manifest.frameOffsets) {
			assert.equal(offset, end);
			for (const batch of manifest.batches) {
				const count = data.readUInt32LE(end); end += 4; particles += count;
				assert.ok(count <= batch.maxParticles);
				for (let f = 0; f < count * 17; f++, end += 4) assert.ok(Number.isFinite(data.readFloatLE(end)));
			}
		}
		assert.ok(particles > 10); assert.equal(particles, manifest.totalSprites); assert.equal(end, data.length);
		const distortion = 'war3.w3mod/_de.w3mod/doodads/cinematic/distortion/distortion3.pkb';
		await assert.rejects(exportEffectPackage(storage, distortion, root, { effectSeconds: 0.2 }), /No supported sprite particles/);
		await assert.rejects(fs.access(path.join(root, distortion + '.wc3fx')), { code: 'ENOENT' });
		const model = parseModel(await storage.readFile('war3.w3mod/_de.w3mod/units/human/heropaladin/heropaladin.mdx'));
		const staticModel = parseModel(await storage.readFile('war3.w3mod/_hd.w3mod/abilities/weapons/glaivemissile/glaivemissiletarget.mdx'));
		assert.equal(staticModel.Sequences.length, 0);
		const staticSamples = sampleEmitters(staticModel, 0, 1, 30);
		assert.equal(staticSamples.length, 1); assert.equal(staticSamples[0].length, 61);
		assert.ok(staticSamples[0].every(s => s.matrix.every(Number.isFinite)));
		assert.equal(staticModel.Sequences.length, 0, 'The fallback interval must not change the source model');
		const attack = model.Sequences.findIndex(s => s.Name === 'Attack 1');
		const samples = sampleEmitters(model, attack, 2, 30);
		const weapon = model.ParticleEmitterPopcorns.findIndex(e => e.Name === 'Hero_WeaponGlow');
		assert.equal(samples[weapon][0].on, true);
		assert.equal(samples[weapon].at(-1).on, false, 'non-looping attack stops emitting after its clip');
		assert.ok(samples[weapon].some(s => Math.abs(s.matrix[12] - samples[weapon][0].matrix[12]) > 0.05));
		const spell = model.ParticleEmitterPopcorns.findIndex(e => e.Name === 'War3PopcornEmitter');
		assert.ok(samples[spell].every(s => !s.on));
		model.Sequences[attack].NonLooping = false;
		const looping = sampleEmitters(model, attack, 2, 30)[weapon];
		assert.ok(looping.every(s => s.on)); assert.ok(looping.some(s => s.restart));
	} finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }
});
