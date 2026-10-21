const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { decodeBLTE, parseTVFS, Warcraft3Storage } = require('../src/js/warcraft3/storage');
const { decodeDDS, png } = require('../src/js/warcraft3/textures');
const { safePath, writeOutput, createGLB } = require('../src/js/warcraft3/exporter');
const { inspectModelType, matchesKind, indexModelTypes, MESH, POPCORN, CLASSIC_EFFECT } = require('../src/js/warcraft3/asset-types');

const mdxChunks = (...tags) => Buffer.concat([Buffer.from('MDLX'), ...tags.map(tag => {
	const chunk = Buffer.alloc(12); chunk.write(tag); chunk.writeUInt32LE(4, 4); return chunk;
})]);

test('asset categories separate pure PopcornFX, preserve mixed models and reject truncated chunks', () => {
	const types = new Map([
		['mesh.mdx', inspectModelType(mdxChunks('GEOS'))],
		['effect.mdx', inspectModelType(mdxChunks('CORN'))],
		['mixed.mdx', inspectModelType(mdxChunks('GEOS', 'CORN'))],
		['classic.mdx', inspectModelType(mdxChunks('PRE2', 'RIBB'))]
	]);
	assert.equal(types.get('mesh.mdx'), MESH); assert.equal(types.get('classic.mdx'), CLASSIC_EFFECT);
	assert.equal(types.get('effect.mdx'), POPCORN);
	assert.equal(matchesKind('effect.mdx', 'models', types), false);
	assert.equal(matchesKind('effect.mdx', 'popcorn', types), true);
	assert.equal(matchesKind('mesh.mdx', 'popcorn', types), false);
	for (const name of ['mesh.mdx', 'mixed.mdx', 'classic.mdx', 'unavailable.mdx']) assert.equal(matchesKind(name, 'models', types), true);
	for (const name of ['mixed.mdx', 'effect.pkb', 'effect.PKFX']) assert.equal(matchesKind(name, 'popcorn', types), true);
	assert.equal(matchesKind('material.pkmm', 'popcorn', types), false);
	assert.throws(() => inspectModelType(mdxChunks('CORN').subarray(0, 10)), /Truncated/);
	assert.throws(() => inspectModelType(mdxChunks('CORN').subarray(0, 13)), /Truncated/);
	assert.throws(() => inspectModelType(Buffer.from('nope')), /signature/);
});

test('classification cache deduplicates content, invalidates changed spans and retains unreadable files', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-wc3-test-'));
	const entry = key => ({ available: true, spans: [{ key, offset: 0, size: 16 }] });
	let reads = 0;
	const storage = { files: new Map([['a.mdx', entry('a')], ['alias.mdx', entry('a')], ['missing.mdx', { ...entry('missing'), available: false }]]), readFile: async () => { reads++; return mdxChunks('CORN'); } };
	const cache = path.join(root, 'types.json');
	try {
		let result = await indexModelTypes(storage, cache);
		assert.equal(reads, 1); assert.equal(result.types.size, 2); assert.equal(result.unknown, 1);
		assert.equal(result.types.get('alias.mdx'), POPCORN);
		await indexModelTypes(storage, cache); assert.equal(reads, 1);
		storage.files.set('a.mdx', entry('changed')); storage.readFile = async () => { reads++; return mdxChunks('GEOS'); };
		result = await indexModelTypes(storage, cache);
		assert.equal(reads, 2); assert.equal(result.types.get('a.mdx'), MESH); assert.equal(result.types.get('alias.mdx'), POPCORN);
		await fs.writeFile(cache, 'broken cache');
		result = await indexModelTypes(storage, cache);
		assert.equal(reads, 4); assert.equal(result.cacheError, '');
		const before = await fs.readFile(cache, 'utf8');
		await indexModelTypes(storage, cache, () => {}, () => true);
		assert.equal(await fs.readFile(cache, 'utf8'), before);
	} finally {
		assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
		assert.ok(path.basename(root).startsWith('wow-wc3-test-'));
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('BLTE reads raw and zlib blocks and rejects corrupt/truncated data', () => {
	const header = Buffer.from('424c544500000000', 'hex');
	assert.equal(decodeBLTE(Buffer.concat([header, Buffer.from('Nhello')])).toString(), 'hello');
	assert.equal(decodeBLTE(Buffer.concat([header, Buffer.from('Z'), zlib.deflateSync(Buffer.from('hello'))])).toString(), 'hello');
	assert.throws(() => decodeBLTE(Buffer.from('BLTE')), /Truncated/);
	assert.throws(() => decodeBLTE(Buffer.concat([header, Buffer.from('Nhello')]), '000000000000000000'), /checksum/);
	assert.throws(() => decodeBLTE(Buffer.concat([header, Buffer.from('Esecret')])), /Encrypted/);
});

test('TVFS resolves radix directories and multi-span files with big-endian offsets', () => {
	const leaf = Buffer.concat([Buffer.from([5]), Buffer.from('a.mdx'), Buffer.from([255, 0, 0, 0, 0])]);
	const paths = Buffer.concat([Buffer.from([255, 128, 0, 0, 4 + leaf.length]), leaf]);
	const vfs = Buffer.alloc(19); vfs[0] = 2; vfs.writeUInt32BE(3, 1); vfs.writeUInt32BE(7, 5); vfs[9] = 0; vfs.writeUInt32BE(1, 10); vfs.writeUInt32BE(2, 14); vfs[18] = 9;
	const header = Buffer.alloc(38); header.write('TVFS'); header[4] = 1; header[5] = 38; header[6] = header[7] = 9;
	header.writeUInt32BE(38, 12); header.writeUInt32BE(paths.length, 16); header.writeUInt32BE(38 + paths.length, 20); header.writeUInt32BE(vfs.length, 24); header.writeUInt32BE(38 + paths.length + vfs.length, 28); header.writeUInt32BE(18, 32);
	const data = Buffer.concat([header, paths, vfs, Buffer.alloc(9, 1), Buffer.alloc(9, 2)]);
	const [file] = parseTVFS(data);
	assert.equal(file.name, 'a.mdx'); assert.equal(file.size, 9); assert.equal(file.spans[0].offset, 3); assert.equal(file.spans[1].key, '02'.repeat(9));
	assert.throws(() => parseTVFS(data.subarray(0, data.length - 1)), /Truncated/);
});

test('texture lookup keeps HD overrides and falls back to classic shared textures', () => {
	const storage = new Warcraft3Storage('unused');
	storage.files = new Map(['war3.w3mod/_hd.w3mod/units/test.dds', 'war3.w3mod/textures/shared.blp'].map(n => [n, {}]));
	assert.equal(storage.resolveTexture('Units\\Test.tif', 'war3.w3mod/_hd.w3mod/units/foo.mdx'), 'war3.w3mod/_hd.w3mod/units/test.dds');
	assert.equal(storage.resolveTexture('Textures/Shared.blp', 'war3.w3mod/_hd.w3mod/units/foo.mdx'), 'war3.w3mod/textures/shared.blp');
});

function dds(format, payload) {
	const header = Buffer.alloc(128); header.write('DDS '); header.writeUInt32LE(124, 4); header.writeUInt32LE(4, 12); header.writeUInt32LE(4, 16); header.writeUInt32LE(32, 76); header.writeUInt32LE(4, 80); header.write(format, 84);
	return Buffer.concat([header, payload]);
}
test('DDS decodes BC1 transparency and reconstructs BC5 normal Z', () => {
	const red = Buffer.alloc(8); red.writeUInt16LE(0xf800);
	assert.deepEqual([...decodeDDS(dds('DXT1', red)).data.slice(0, 4)], [255, 0, 0, 255]);
	const transparent = Buffer.alloc(8, 255); transparent.writeUInt16LE(0); transparent.writeUInt16LE(0xffff, 2);
	assert.equal(decodeDDS(dds('DXT1', transparent)).data[3], 0);
	const normal = Buffer.alloc(16); normal[0] = normal[8] = 128;
	assert.deepEqual([...decodeDDS(dds('ATI2', normal)).data.slice(0, 4)], [128, 128, 255, 255]);
	assert.throws(() => decodeDDS(dds('BC7 ', normal)), /Unsupported/);
	assert.throws(() => decodeDDS(dds('DXT5', Buffer.alloc(1))), /Truncated/);
});
test('PNG encoder writes scanlines losslessly', () => {
	const bytes = png({ width: 1, height: 1, data: Uint8ClampedArray.from([12, 34, 56, 78]) });
	assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a');
	let p = 8;
	while (bytes.toString('ascii', p + 4, p + 8) !== 'IDAT') p += 12 + bytes.readUInt32BE(p);
	assert.deepEqual([...zlib.inflateSync(bytes.subarray(p + 8, p + 8 + bytes.readUInt32BE(p)))], [0, 12, 34, 56, 78]);
});
test('exports reject traversal, device names, and accidental overwrites', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-wc3-test-'));
	try {
		for (const name of ['../outside', '/absolute', 'C:/elsewhere', 'CON.txt', 'x/../a', 'x:a', 'x./file']) assert.throws(() => safePath(root, name));
		await writeOutput(root, 'units/test.mdx', Buffer.from('original'));
		await assert.rejects(writeOutput(root, 'units/test.mdx', Buffer.from('replacement')), { code: 'EEXIST' });
		assert.equal(await fs.readFile(path.join(root, 'units/test.mdx'), 'utf8'), 'original');
	} finally {
		assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
		assert.ok(path.basename(root).startsWith('wow-wc3-test-'));
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('preview prefers ordinary Stand and frames invisible birth geometry', () => {
	const { defaultSequence } = require('../src/js/warcraft3/model');
	const Preview = require('../src/js/warcraft3/preview');
	assert.equal(defaultSequence({ Sequences: [{ Name: 'Birth', NonLooping: true }, { Name: 'Stand Alternate' }, { Name: 'Stand 1' }] }), 2);
	assert.equal(defaultSequence({ Sequences: [{ Name: 'Death', NonLooping: true }, { Name: 'Idle' }] }), 1);
	assert.equal(defaultSequence({ Sequences: [] }), 0);
	const state = { model: { Geosets: [{ LevelOfDetail: 0, Vertices: [-30, -30, 60, 30, 30, 60] }] }, renderer: { rendererData: { geosetAlpha: [0] } }, lod: 0, pitch: 0.22 };
	Preview.prototype.fit.call(state, true);
	assert.deepEqual(state.target, [0, 0, 60]);
	assert.ok(state.distance > 60 && state.distance < 120);
	assert.ok(state.pitch > 0.7, 'flat ground models should not start nearly edge-on');
});

test('UI exports report exact nested paths and reveal existing files and batch results', async () => {
	const component = require('../src/js/modules/tab_warcraft3');
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-wc3-test-'));
	let toast, revealed, released = 0, reads = 0;
	const block = Buffer.alloc(8); block.writeUInt16LE(0xf800);
	const context = Object.assign(component.data(), component.methods, {
		teamColor: [1, 0, 0],
		storage: { readFile: async () => { reads++; return dds('DXT1', block); } },
		revealExport: file => revealed = file,
		$core: { view: { isBusy: false, config: { exportDirectory: root, overwriteFiles: false } }, create_busy_lock: () => ({ [Symbol.dispose]: () => released++ }), setToast: (...args) => toast = args }
	});
	try {
		context.selection = ['war3.w3mod/_de.w3mod/textures/rune.dds']; context.format = 'png';
		await context.exportSelection();
		const expected = path.join(root, 'war3.w3mod/_de.w3mod/textures/rune.dds.png');
		assert.deepEqual(context.exportResults, [{ path: expected, existing: false }]);
		Object.values(toast[2])[0](); assert.equal(revealed, expected);
		assert.equal((await fs.readFile(expected)).toString('hex', 0, 8), '89504e470d0a1a0a');
		await context.exportSelection();
		assert.deepEqual(context.exportResults, [{ path: expected, existing: true }]);
		assert.match(context.batchStatus, /0 exported.*1 skipped/);
		assert.equal(reads, 1, 'skip must happen before reading or converting the texture');
		context.$core.view.config.overwriteFiles = true; block.writeUInt16LE(0x07e0);
		const original = await fs.readFile(expected);
		await context.exportSelection();
		assert.equal(reads, 2); assert.notDeepEqual(await fs.readFile(expected), original);
		assert.deepEqual(context.exportResults, [{ path: expected, existing: false }]);
		context.$core.view.config.overwriteFiles = false;
		context.format = 'raw'; context.selection = ['war3.w3mod/one/a.txt', 'war3.w3mod/two/b.txt'];
		await context.exportSelection();
		assert.deepEqual(context.exportResults.map(r => r.path), context.selection.map(n => path.join(root, n)));
		assert.equal(released, 4);
		const existingModel = 'war3.w3mod/existing.glb';
		await writeOutput(root, existingModel, Buffer.from('keep existing model'));
		context.format = 'glb'; context.selection = ['war3.w3mod/existing.mdx'];
		context.storage.readFile = async () => { throw Error('This source must not be read for a skipped model'); };
		await context.exportSelection();
		assert.match(context.batchStatus, /0 exported.*0 failed.*1 skipped/);
		assert.equal((await fs.readFile(path.join(root, existingModel))).toString(), 'keep existing model');
		context.format = 'raw';
		context.selection = ['war3.w3mod/missing.txt']; context.storage.readFile = async () => { throw Error('Missing'); };
		await context.exportSelection();
		assert.equal(context.exportResults.length, 0); assert.equal(toast[2], null);
	} finally {
		assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
		assert.ok(path.basename(root).startsWith('wow-wc3-test-'));
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('real installation: MDX 1800 records, skin weights and animated GLB deformation', { skip: !process.env.WC3_INSTALL }, async () => {
	const storage = await new Warcraft3Storage(process.env.WC3_INSTALL).open();
	assert.ok(storage.files.size > 1000);
	const name = 'war3.w3mod/_hd.w3mod/units/human/footman/footman.mdx';
	const { parseModel, war3 } = require('../src/js/warcraft3/model');
	const { defaultSequence } = require('../src/js/warcraft3/model');
	const rune = parseModel(await storage.readFile('war3.w3mod/_de.w3mod/doodads/cinematic/glowingrunes/glowingrunes3.mdx'));
	const runeRenderer = new war3.ModelRenderer(rune); runeRenderer.update(0);
	assert.ok(runeRenderer.rendererData.geosetAlpha.every(a => a === 0), 'regression asset starts invisible');
	runeRenderer.setSequence(defaultSequence(rune)); runeRenderer.update(0);
	assert.equal(rune.Sequences[defaultSequence(rune)].Name, 'Stand 1');
	assert.ok(runeRenderer.rendererData.geosetAlpha.some(a => a > 0));
	const model = parseModel(await storage.readFile(name));
	for (const g of model.Geosets) if (g.SkinWeights) for (let i = 0; i < g.SkinWeights.length; i += 8)
		assert.ok([0, 255].includes([...g.SkinWeights.slice(i + 4, i + 8)].reduce((a, b) => a + b, 0)));
	const { document, data } = await createGLB(storage, name, { sequence: 0 });
	assert.equal(document.animations.length, 1); assert.ok(document.images.length); assert.equal(data.readUInt32LE(8), data.length);
	assert.equal(document.animations[0].name, model.Sequences[0].Name);
	// Regression assets for the new light records and IDUF camera tracks.
	for (const asset of ['war3.w3mod/_hd.w3mod/doodads/cinematic/bergrisst/bergrisst.mdx', 'war3.w3mod/_hd.w3mod/units/nightelf/dryad/dryad_portrait.mdx'])
		if (storage.files.has(asset)) assert.ok(parseModel(await storage.readFile(asset)).Nodes);
	const { mat4 } = require('../src/js/warcraft3/vendor/gl-matrix');
	const bin = data.subarray(28 + data.readUInt32LE(12));
	const read = id => {
		const a = document.accessors[id], view = document.bufferViews[a.bufferView];
		const bytes = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
		return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
	};
	const animation = document.animations[0], times = read(animation.samplers[0].input);
	const renderer = new war3.ModelRenderer(model), nodes = model.Nodes.filter(Boolean);
	const inverseBinds = read(document.skins[0].inverseBindMatrices);
	renderer.setSequence(0);
	for (const frame of [0, Math.floor(times.length / 2), times.length - 2]) {
		renderer.rendererData.frame = model.Sequences[0].Interval[0] + times[frame] * 1000;
		model.GlobalSequences.forEach((length, i) => renderer.rendererData.globalSequencesFrames[i] = length ? times[frame] * 1000 % length : 0);
		renderer.updateNode(renderer.rendererData.rootNode);
		const tracks = new Map();
		for (const channel of animation.channels) {
			const node = channel.target.node, type = channel.target.path, width = type === 'rotation' ? 4 : 3;
			if (!tracks.has(node)) tracks.set(node, {});
			tracks.get(node)[type] = read(animation.samplers[channel.sampler].output).subarray(frame * width, (frame + 1) * width);
		}
		const worlds = new Map(), byId = new Map(nodes.map((n, i) => [n.ObjectId, i]));
		const world = i => {
			if (worlds.has(i)) return worlds.get(i);
			const track = tracks.get(document.skins[0].joints[i]);
			const matrix = mat4.fromRotationTranslationScale(mat4.create(), track.rotation, track.translation, track.scale);
			if (nodes[i].Parent != null) mat4.multiply(matrix, world(byId.get(nodes[i].Parent)), matrix);
			worlds.set(i, matrix); return matrix;
		};
		let compared = 0;
		for (let i = 0; i < nodes.length; i++) {
			let special = false;
			for (let n = nodes[i]; n; n = model.Nodes[n.Parent]) if (n.Flags & 0xff) special = true;
			if (special) continue;
			const actual = mat4.multiply(mat4.create(), world(i), inverseBinds.subarray(i * 16, i * 16 + 16));
			const expected = renderer.rendererData.nodes[nodes[i].ObjectId].matrix;
			assert.ok(actual.every((v, c) => Math.abs(v - expected[c]) < 0.002), 'Joint deformation differs: ' + nodes[i].Name);
			compared++;
		}
		assert.ok(compared > 20);
	}
});
