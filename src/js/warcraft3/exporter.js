const fs = require('fs').promises;
const path = require('path');
const { mat4, vec3, quat } = require('./vendor/gl-matrix');
const { parseModel, war3 } = require('./model');
const { decodeTexture, png } = require('./textures');

function safePath(directory, name) {
	const parts = name.replace(/\\/g, '/').split('/');
	if (parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
		throw new Error('Unsafe export path: ' + name);
	const root = path.resolve(directory), out = path.resolve(root, ...parts);
	if (!out.startsWith(root + path.sep)) throw new Error('Export path is outside the output directory');
	return out;
}

async function writeOutput(directory, name, bytes, overwrite = false) {
	const out = safePath(directory, name);
	// Refuse existing symlink/junction ancestors, including the destination itself.
	let current = path.parse(out).root;
	for (const part of out.slice(current.length).split(path.sep)) {
		current = path.join(current, part);
		try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Export path contains a symbolic link: ' + current); }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
	await fs.mkdir(path.dirname(out), { recursive: true });
	await fs.writeFile(out, bytes, { flag: overwrite ? 'w' : 'wx' });
	return out;
}

async function checkOutput(directory, name, overwrite = false) {
	const out = safePath(directory, name);
	if (!overwrite) {
		try { await fs.lstat(out); }
		catch (e) { if (e.code === 'ENOENT') return out; throw e; }
		const error = new Error('Already exists: ' + name);
		error.code = 'EEXIST';
		throw error;
	}
	return out;
}

async function exportRaw(storage, name, directory, options = {}) {
	await checkOutput(directory, name, options.overwrite);
	const data = await storage.readFile(name), written = [], warnings = [];
	// Native MDX is copied byte-for-byte and retains all animation/effect data.
	written.push(await writeOutput(directory, name, data, options.overwrite));
	if (/\.mdx$/i.test(name) && options.textures !== false) {
		try {
			const model = parseModel(data), seen = new Set();
			for (const texture of model.Textures) if (texture.Image) {
				const resolved = storage.resolveTexture(texture.Image, name);
				if (!resolved) { warnings.push('Missing texture: ' + texture.Image); continue; }
				if (seen.has(resolved)) continue;
				seen.add(resolved);
				try {
					await checkOutput(directory, resolved, options.overwrite);
					written.push(await writeOutput(directory, resolved, await storage.readFile(resolved), options.overwrite));
				}
				catch (e) { if (e.code !== 'EEXIST') warnings.push(resolved + ': ' + e.message); }
			}
		} catch (e) { warnings.push('MDX was exported; dependency discovery failed: ' + e.message); }
	}
	return { written, warnings };
}

const value = (track, fallback = 0) => typeof track === 'number' ? track : track?.Keys?.[0]?.Vector?.[0] ?? fallback;

async function createGLB(storage, name, options = {}) {
	const model = parseModel(await storage.readFile(name));
	const warnings = [];
	const lod = options.lod ?? 0, fps = options.fps ?? 30, teamColor = options.teamColor ?? [1, 0, 0];
	if (teamColor.length !== 3 || !Array.from(teamColor).every(c => Number.isFinite(c) && c >= 0 && c <= 1)) throw new Error('Team color must contain three values between 0 and 1');
	if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('Animation sampling rate must be between 1 and 120 fps');
	const doc = {
		asset: { version: '2.0', generator: 'wow.export Warcraft III', extras: { source: name, mdxVersion: model.Version } },
		scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: model.Info.Name || path.basename(name), rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: [] }],
		meshes: [], materials: [], textures: [], images: [], samplers: [], skins: [], animations: [], accessors: [], bufferViews: [], buffers: []
	};
	const chunks = []; let byteLength = 0;
	function bufferView(bytes, target) {
		const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const id = doc.bufferViews.length;
		doc.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, ...(target ? { target } : {}) });
		chunks.push(data); byteLength += data.length;
		const padding = (4 - byteLength % 4) % 4;
		if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
		return id;
	}
	function accessor(array, type, target, bounds = false) {
		const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }, width = widths[type];
		if (array.length % width || Array.from(array).some(n => !Number.isFinite(n))) throw new Error('Invalid numeric model data');
		const entry = { bufferView: bufferView(array, target), componentType: array instanceof Float32Array ? 5126 : array instanceof Uint16Array ? 5123 : 5125, count: array.length / width, type };
		if (bounds && array.length) {
			entry.min = Array(width).fill(Infinity); entry.max = Array(width).fill(-Infinity);
			for (let i = 0; i < array.length; i++) { const c = i % width; entry.min[c] = Math.min(entry.min[c], array[i]); entry.max[c] = Math.max(entry.max[c], array[i]); }
		}
		return doc.accessors.push(entry) - 1;
	}
	const textureCache = new Map(), teamTextures = new Map(), teamMaterials = [], teamFiles = new Map();
	async function texture(id, role, ormId) {
		const t = model.Textures[id]; if (!t) return undefined;
		const key = id + ':' + role + ':' + ormId;
		if (textureCache.has(key)) return textureCache.get(key);
		try {
			let image, untinted, mask;
			if (t.ReplaceableId === 1) image = { width: 1, height: 1, data: Uint8ClampedArray.from([...teamColor.map(c => c * 255), 255]) };
			else {
				const resolved = storage.resolveTexture(t.Image, name);
				if (!resolved) { if (t.Image) warnings.push('Missing texture: ' + t.Image); return undefined; }
				image = decodeTexture(await storage.readFile(resolved));
			}
			if (options.editableTeamColor && role === 'base' && t.ReplaceableId === 1) {
				untinted = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
				mask = untinted;
			}
			if (role === 'base' && ormId !== undefined && model.Textures[ormId]?.Image) {
				const resolved = storage.resolveTexture(model.Textures[ormId].Image, name);
				if (resolved) {
					const orm = decodeTexture(await storage.readFile(resolved));
					if (options.editableTeamColor) {
						untinted = { ...image, data: image.data.slice() };
						mask = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data.length) };
					}
					for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
						const i = (y * image.width + x) * 4;
						const j = (Math.floor(y * orm.height / image.height) * orm.width + Math.floor(x * orm.width / image.width)) * 4;
						const amount = orm.data[j + 3] / 255;
						if (mask) { mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = orm.data[j + 3]; mask.data[i + 3] = 255; }
						for (let c = 0; c < 3; c++) image.data[i + c] *= (1 - amount) + amount * teamColor[c];
					}
				}
			}
			const imageId = doc.images.push({ name: t.Image || 'Team color', mimeType: 'image/png', bufferView: bufferView(png(image)) }) - 1;
			const sampler = doc.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: t.Flags & 1 ? 10497 : 33071, wrapT: t.Flags & 2 ? 10497 : 33071 }) - 1;
			const result = { index: doc.textures.push({ source: imageId, sampler }) - 1 };
			if (untinted && mask && mask.data.some((v, i) => i % 4 === 0 && v > 0)) {
				const base = 'team-color/' + result.index + '-base.png', maskFile = 'team-color/' + result.index + '-mask.png';
				teamFiles.set(base, png(untinted)); teamFiles.set(maskFile, png(mask));
				teamTextures.set(result.index, { base, mask: maskFile });
			}
			textureCache.set(key, result); return result;
		} catch (e) { warnings.push('Texture ' + (t.Image || id) + ': ' + e.message); return undefined; }
	}
	for (const material of model.Materials) {
		const layer = material.Layers.find(l => model.Textures[value(l.TextureID)]?.Image) || material.Layers[0] || {};
		const hd = layer.ShaderTypeId === 1 || /HD/.test(material.Shader || '');
		const ormId = layer.ORMTextureID === undefined ? undefined : value(layer.ORMTextureID);
		const baseColorTexture = await texture(value(layer.TextureID), 'base', hd ? ormId : undefined);
		const pbr = { baseColorFactor: [1, 1, 1, 1], metallicFactor: hd ? 1 : 0, roughnessFactor: 1, ...(baseColorTexture ? { baseColorTexture } : {}) };
		const orm = ormId === undefined ? undefined : await texture(ormId, 'orm');
		if (orm) pbr.metallicRoughnessTexture = orm;
		const normal = layer.NormalTextureID === undefined ? undefined : await texture(value(layer.NormalTextureID), 'normal');
		const emissive = layer.EmissiveTextureID === undefined ? undefined : await texture(value(layer.EmissiveTextureID), 'emissive');
		doc.materials.push({ pbrMetallicRoughness: pbr, doubleSided: !!(layer.Shading & 16), alphaMode: layer.FilterMode === 1 ? 'MASK' : layer.FilterMode >= 2 ? 'BLEND' : 'OPAQUE', ...(layer.FilterMode === 1 ? { alphaCutoff: 0.125 } : {}), ...(normal ? { normalTexture: normal } : {}), ...(orm ? { occlusionTexture: orm } : {}), ...(emissive ? { emissiveTexture: emissive, emissiveFactor: [1, 1, 1] } : {}) });
		const editable = teamTextures.get(baseColorTexture?.index);
		if (editable) {
			const materialId = doc.materials.length - 1;
			doc.materials[materialId].extras = { wc3_team_material: materialId };
			teamMaterials.push({ material: materialId, ...editable });
		}
		if (material.Layers.length > 1 && !hd) warnings.push('Classic material layers are approximated with one glTF material.');
	}
	const nodes = model.Nodes.filter(Boolean), nodeMap = new Map(), jointMap = new Map();
	nodes.forEach((node, i) => {
		const parentPivot = model.Nodes[node.Parent]?.PivotPoint || [0, 0, 0];
		nodeMap.set(node.ObjectId, doc.nodes.length); jointMap.set(node.ObjectId, i);
		doc.nodes.push({ name: node.Name, children: [], translation: [...node.PivotPoint].map((v, c) => v - parentPivot[c]), rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
	});
	for (const node of nodes) doc.nodes[node.Parent == null ? 0 : nodeMap.get(node.Parent)].children.push(nodeMap.get(node.ObjectId));
	if (nodes.length) {
		const matrices = new Float32Array(nodes.length * 16);
		for (let i = 0; i < nodes.length; i++) matrices.set(mat4.fromTranslation(mat4.create(), nodes[i].PivotPoint.map(v => -v)), i * 16);
		doc.skins.push({ joints: nodes.map(n => nodeMap.get(n.ObjectId)), inverseBindMatrices: accessor(matrices, 'MAT4') });
	}
	for (const [index, geoset] of model.Geosets.entries()) {
		if (geoset.LevelOfDetail !== undefined && geoset.LevelOfDetail !== lod) continue;
		if (!geoset.Vertices.length || !geoset.Faces.length) continue;
		const count = geoset.Vertices.length / 3;
		if (Array.from(geoset.Faces).some(i => i >= count)) throw new Error('Geoset has an invalid vertex index');
		const attributes = { POSITION: accessor(geoset.Vertices, 'VEC3', 34962, true), NORMAL: accessor(geoset.Normals, 'VEC3', 34962) };
		// MDX and glTF both address texture rows from the top in this pipeline.
		if (geoset.TVertices[0]) attributes.TEXCOORD_0 = accessor(geoset.TVertices[0], 'VEC2', 34962);
		if (geoset.Tangents) attributes.TANGENT = accessor(geoset.Tangents, 'VEC4', 34962);
		if (nodes.length) {
			const joints = new Uint16Array(count * 4), weights = new Float32Array(count * 4), skin = geoset.SkinWeights16 || geoset.SkinWeights;
			for (let v = 0; v < count; v++) {
				const group = geoset.Groups[geoset.VertexGroup[v]] || [];
				if (!skin && group.length > 4) warnings.push('Classic vertex groups with more than four bones are reduced to four influences.');
				let sum = 0;
				for (let k = 0; k < 4; k++) {
					const w = skin ? skin[v * 8 + 4 + k] : k < group.length ? 1 : 0;
					const id = skin ? skin[v * 8 + k] : group[k];
					if (w && !jointMap.has(id)) throw new Error('Skin references a missing bone');
					joints[v * 4 + k] = w ? jointMap.get(id) ?? 0 : 0;
					weights[v * 4 + k] = w; sum += w;
				}
				if (sum) for (let k = 0; k < 4; k++) weights[v * 4 + k] /= sum;
				else weights[v * 4] = 1;
			}
			attributes.JOINTS_0 = accessor(joints, 'VEC4', 34962); attributes.WEIGHTS_0 = accessor(weights, 'VEC4', 34962);
		}
		const mesh = doc.meshes.push({ name: geoset.Name || 'Geoset ' + index, primitives: [{ attributes, indices: accessor(geoset.Faces, 'SCALAR', 34963), material: geoset.MaterialID, mode: 4 }] }) - 1;
		const meshNode = doc.nodes.push({ name: geoset.Name || 'Geoset ' + index, mesh, ...(nodes.length ? { skin: 0 } : {}) }) - 1;
		if (nodes.length) doc.scenes[0].nodes.push(meshNode);
		else doc.nodes[0].children.push(meshNode);
	}
	if (!doc.meshes.length) warnings.push('This model has no mesh at the selected LOD (it may be an effect-only model).');
	if (options.animations !== false && model.Sequences.length && nodes.length) {
		const renderer = new war3.ModelRenderer(model);
		const sequences = options.sequence === undefined || options.sequence < 0 ? model.Sequences.map((_, i) => i) : [options.sequence];
		for (const sequence of sequences) {
			const seq = model.Sequences[sequence]; if (!seq) throw new Error('Invalid animation selection');
			const duration = (seq.Interval[1] - seq.Interval[0]) / 1000;
			if (!Number.isFinite(duration) || duration < 0 || duration > 3600) throw new Error('Invalid animation duration');
			const frames = Math.max(2, Math.ceil(duration * fps) + 1), times = Float32Array.from({ length: frames }, (_, i) => duration * i / (frames - 1));
			if (!duration) continue;
			const animation = { name: seq.Name, samplers: [], channels: [], extras: { nonLooping: seq.NonLooping } };
			const input = accessor(times, 'SCALAR', undefined, true);
			renderer.setSequence(sequence);
			const tracks = nodes.map(() => ({ translation: new Float32Array(frames * 3), rotation: new Float32Array(frames * 4), scale: new Float32Array(frames * 3) }));
			for (let f = 0; f < frames; f++) {
				// Avoid setFrame's cross-sequence lookup at shared interval boundaries.
				renderer.rendererData.frame = seq.Interval[0] + times[f] * 1000;
				model.GlobalSequences.forEach((length, i) => renderer.rendererData.globalSequencesFrames[i] = length ? times[f] * 1000 % length : 0);
				for (let i = 0; i < nodes.length; i++) {
					const node = nodes[i], parentPivot = model.Nodes[node.Parent]?.PivotPoint || [0, 0, 0];
					// WC3 transforms around absolute pivots. Rest joints sit at those
					// pivots, with inverse binds translating vertices back into joint space.
					// This also preserves negative/zero scale without matrix inversion.
					// Held/exact keys may return the source keyframe vector. Copy before
					// adding pivots or normalizing signs so later samples/clips stay intact.
					const t = vec3.create();
					vec3.copy(t, renderer.interp.vec3(t, node.Translation) || t);
					const s = renderer.interp.vec3(vec3.create(), node.Scaling) || vec3.fromValues(1, 1, 1);
					const q = quat.create();
					quat.copy(q, renderer.interp.quat(q, node.Rotation) || q);
					for (let c = 0; c < 3; c++) t[c] += node.PivotPoint[c] - parentPivot[c];
					quat.normalize(q, q);
					if (f && quat.dot(q, tracks[i].rotation.subarray((f - 1) * 4, f * 4)) < 0) for (let k = 0; k < 4; k++) q[k] *= -1;
					tracks[i].translation.set(t, f * 3); tracks[i].rotation.set(q, f * 4); tracks[i].scale.set(s, f * 3);
				}
			}
			for (let i = 0; i < nodes.length; i++) for (const [channel, array] of Object.entries(tracks[i])) {
				const sampler = animation.samplers.push({ input, output: accessor(array, channel === 'rotation' ? 'VEC4' : 'VEC3'), interpolation: 'LINEAR' }) - 1;
				animation.channels.push({ sampler, target: { node: nodeMap.get(nodes[i].ObjectId), path: channel } });
			}
			doc.animations.push(animation);
			options.progress?.('Exported animation: ' + seq.Name);
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}
	if (model.ParticleEmitters.length || model.ParticleEmitters2.length || model.ParticleEmitterPopcorns?.length || model.RibbonEmitters.length)
		warnings.push('Particle and ribbon effects are retained in native MDX, but are not converted to glTF.');
	if (model.GeosetAnims.length || model.TextureAnims.length) warnings.push('Animated mesh visibility and material/UV tracks are retained in native MDX; glTF exports skeletal animation.');
	if (nodes.some(n => n.Flags & 0xf8)) warnings.push('Camera-facing bones export as ordinary bones without billboard behavior.');
	if (nodes.some(n => n.Flags & 7)) warnings.push('Selective transform inheritance is approximated with ordinary joint inheritance.');
	doc.buffers.push({ byteLength });
	doc.asset.extras.warnings = [...new Set(warnings)];
	for (const key of ['animations', 'skins', 'textures', 'images', 'samplers', 'materials', 'meshes']) if (!doc[key].length) delete doc[key];
	for (const node of doc.nodes) if (!node.children?.length) delete node.children;
	const json = Buffer.from(JSON.stringify(doc));
	const jsonPadded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(jsonPadded);
	const bin = Buffer.concat(chunks), glb = Buffer.alloc(12 + 8 + jsonPadded.length + 8 + bin.length);
	glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
	glb.writeUInt32LE(jsonPadded.length, 12); glb.write('JSON', 16); jsonPadded.copy(glb, 20);
	const p = 20 + jsonPadded.length; glb.writeUInt32LE(bin.length, p); glb.writeUInt32LE(0x004e4942, p + 4); bin.copy(glb, p + 8);
	return { data: glb, warnings: doc.asset.extras.warnings, document: doc, teamColor: { color: Array.from(teamColor), materials: teamMaterials }, teamFiles };
}

module.exports = { safePath, checkOutput, writeOutput, exportRaw, createGLB };
