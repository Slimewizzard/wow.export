const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { parseModel, defaultSequence, war3 } = require('./model');
const { mat4, vec3 } = require('./vendor/gl-matrix');
const { createGLB, checkOutput, writeOutput } = require('./exporter');
const { decodeTexture, png } = require('./textures');

function sequenceGate(guide, sequence) {
	const words = s => s.toLowerCase().split(/[\s_-]+/).filter(w => w && !/^\d+$/.test(w));
	const selected = words(sequence); let fallback = true, match = true, specificity = 0;
	for (const item of (guide || '').split(',')) {
		const [label, state] = item.split('='); if (!state) continue;
		const key = words(label), on = /^(on|true|1)/i.test(state.trim());
		if (key.length === 1 && /^(always|alwyas|allways)$/.test(key[0])) fallback = on;
		else if (key.length > specificity && key.every((w, i) => selected[i] === w)) { match = on; specificity = key.length; }
	}
	return specificity ? match : fallback;
}

function sampleEmitters(model, sequence, seconds, fps) {
	// Some static effect models have CORN emitters but no SEQS chunk. The
	// renderer requires an interval; supply a rest pose without changing the MDX.
	const renderModel = model.Sequences.length ? model : { ...model, Sequences: [{ Name: '', Interval: [0, 0], NonLooping: false }] };
	const renderer = new war3.ModelRenderer(renderModel), seq = model.Sequences[sequence];
	if (seq) renderer.setSequence(sequence);
	const result = (model.ParticleEmitterPopcorns || []).map(() => []);
	const scalar = (v, fallback) => typeof v === 'number' ? v : v ? renderer.interp.num(v) ?? fallback : fallback;
	const color = v => v?.Keys ? renderer.interp.vec3(vec3.create(), v) || [1, 1, 1] : v || [1, 1, 1];
	const frameCount = Math.ceil(seconds * fps) + 1;
	const duration = seq ? seq.Interval[1] - seq.Interval[0] : 0;
	let previousPhase = 0;
	for (let step = 0; step <= (frameCount - 1) * 2; step++) {
		const time = step * 1000 / (fps * 2);
		const phase = duration > 0 && !seq.NonLooping ? time % duration : Math.min(time, duration);
		const restart = step > 0 && phase < previousPhase; previousPhase = phase;
		renderer.rendererData.frame = seq ? seq.Interval[0] + phase : 0;
		model.GlobalSequences.forEach((length, i) => renderer.rendererData.globalSequencesFrames[i] = length ? time % length : 0);
		renderer.updateNode(renderer.rendererData.rootNode);
		for (const [i, emitter] of (model.ParticleEmitterPopcorns || []).entries()) {
			const matrix = mat4.clone(renderer.rendererData.nodes[emitter.ObjectId]?.matrix || mat4.create());
			const position = vec3.transformMat4(vec3.create(), emitter.PivotPoint || [0, 0, 0], matrix);
			for (let c = 0; c < 3; c++) matrix[12 + c] = position[c] / 50;
			result[i].push({ matrix: Array.from(matrix), color: [...color(emitter.Color), scalar(emitter.Alpha, 1)], rate: scalar(emitter.EmissionRate, 1), restart, on: !(seq?.NonLooping && time > duration) && scalar(emitter.Visibility, sequenceGate(emitter.AnimVisibilityGuide, seq?.Name || '') ? 1 : 0) >= 0.5 });
		}
	}
	return result;
}

async function helperPath(override) {
	const roots = [typeof nw !== 'undefined' ? nw.__dirname : '', path.resolve(__dirname, '../../..'), process.cwd()].filter(Boolean);
	const candidates = override ? [override] : roots.flatMap(root => [path.join(root, 'tools/wc3-effects/wc3-effects.exe'), path.join(root, 'bin/wc3-effects/wc3-effects.exe')]);
	for (const file of candidates) try { await fs.access(file); return file; } catch {}
	throw new Error('WC3 effect baker is missing. Build it with tools/build-wc3-effects.ps1 or use the packaged WC3 build.');
}

async function runBaker(executable, request, folder) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, [request, folder], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let diagnostics = '', timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180000);
		for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => diagnostics = (diagnostics + bytes.toString()).slice(-16384));
		child.on('error', error => { clearTimeout(timer); reject(error); });
		child.on('close', code => { clearTimeout(timer); if (code === 0 && !timedOut) resolve(); else reject(new Error(timedOut ? 'Effect simulation exceeded three minutes; reduce duration or FPS.' : diagnostics.trim() || 'Effect baker failed.')); });
	});
}

async function exportEffectPackage(storage, name, directory, options = {}) {
	if (!/\.(mdx|pkb|pkfx)$/i.test(name)) throw new Error('Choose an MDX model or PopcornFX effect.');
	const outputName = name + '.wc3fx';
	await checkOutput(directory, outputName, options.overwrite);
	const fps = options.effectFPS ?? 30;
	const seconds = options.effectSeconds ?? 3;
	if (!Number.isInteger(fps) || fps < 1 || fps > 60 || !Number.isFinite(seconds) || seconds < 0.1 || seconds > 30) throw new Error('Use 1–60 FPS and a duration between 0.1 and 30 seconds.');
	const mode = options.animationMode ?? (options.sequence >= 0 ? 'current' : 'all');
	if (!['all', 'current'].includes(mode)) throw new Error('Choose all animations or the selected animation for Blender export.');
	const warnings = [], zip = new AdmZip(), emitters = [], originals = new Map();
	const data = await storage.readFile(name); let model, sequence = -1, modelFile = null, all = false, teamColor;
	if (/\.mdx$/i.test(name)) {
		model = parseModel(data);
		sequence = Number.isInteger(options.sequence) && options.sequence >= 0 ? options.sequence : defaultSequence(model);
		const seq = model.Sequences[sequence];
		if (model.Sequences.length && !seq) throw new Error('Invalid animation selection.');
		all = mode === 'all' && model.Sequences.length > 1;
		if (all && model.Sequences.length > 256) throw new Error('Too many animation clips; export the selected animation instead.');
		for (const [i, emitter] of (model.ParticleEmitterPopcorns || []).entries()) {
			const source = storage.resolveEffect(emitter.Path, name);
			if (!source) { warnings.push('Missing effect: ' + emitter.Path); continue; }
			if (!originals.has(source)) originals.set(source, await storage.readFile(source));
			emitters.push({ name: emitter.Name || 'Emitter ' + i, source, data: originals.get(source).toString('base64'), index: i });
			if (emitter.Speed !== 1 || emitter.LifeSpan !== 1) warnings.push('Emitter ' + emitter.Name + ': speed/lifetime multipliers are not yet applied by the simulator.');
		}
		if (model.Geosets.some(g => g.Vertices.length && g.Faces.length)) {
			options.progress?.('Exporting model and ' + (all ? 'all animations' : 'selected animation') + '…');
			const glb = await createGLB(storage, name, { ...options, animations: true, sequence: all ? -1 : sequence, editableTeamColor: true });
			modelFile = 'model.glb'; zip.addFile(modelFile, glb.data);
			teamColor = glb.teamColor;
			for (const [file, bytes] of glb.teamFiles) zip.addFile(file, bytes);
			warnings.push(...glb.warnings.filter(w => !w.startsWith('Particle and ribbon effects')));
			if (model.ParticleEmitters.length || model.ParticleEmitters2.length || model.RibbonEmitters.length) warnings.push('Classic particles and ribbons are not included in the PopcornFX bake.');
		}
		zip.addFile('sources/model.mdx', data);
	} else { originals.set(name, data); emitters.push({ name: path.basename(name), source: name, data: data.toString('base64'), states: [] }); }
	const modelOnly = model && !model.ParticleEmitterPopcorns?.length;
	if (modelOnly && !modelFile) throw new Error('This model has no mesh or PopcornFX emitters to export. Original file export remains available.');
	if (!emitters.length && !modelOnly) throw new Error('No installed PopcornFX dependencies were found. ' + warnings.join(' '));
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wow-wc3-fx-'));
	try {
		const indices = all ? model.Sequences.map((_, i) => i) : [sequence];
		const clips = [], bakeDependencies = [], copied = new Map();
		const executable = modelOnly ? null : await helperPath(options.helper);
		let cacheBytes = 0, particleSlots = 0;
		for (const [clipIndex, selected] of indices.entries()) {
			const seq = model?.Sequences[selected];
			let clip, frameData;
			if (modelOnly) {
				// Model-only clips keep their full skeletal duration without a particle cache.
				const frameCount = all ? 1 : Math.ceil(seconds * fps) + 1;
				clip = { schema: 'wow.export.wc3fx.v1', fps, frameCount, seconds: (frameCount - 1) / fps, frameOffsets: Array(frameCount).fill(8), stride: 17, unitsPerMetre: 50, totalSprites: 0, batches: [], dependencies: [], warnings: [] };
				frameData = Buffer.from([87, 51, 70, 88, 1, 0, 0, 0]);
			} else {
				options.progress?.('Baking ' + (seq?.Name || 'effect') + ' (' + (clipIndex + 1) + '/' + indices.length + ')…');
				const states = model ? sampleEmitters(model, selected, seconds, fps) : [];
				const request = path.join(temporary, 'request.json');
				await fs.writeFile(request, JSON.stringify({ fps, seconds, teamColor: options.teamColor || [1, 0, 0], emitters: emitters.map(e => ({ ...e, states: model ? states[e.index] : [] })) }));
				await runBaker(executable, request, temporary);
				clip = JSON.parse(await fs.readFile(path.join(temporary, 'bake.json'), 'utf8'));
				frameData = await fs.readFile(path.join(temporary, 'frames.bin'));
			}
			warnings.push(...clip.warnings);
			bakeDependencies.push(...clip.dependencies); delete clip.dependencies;
			clip.sequence = seq?.Name || null; clip.sequenceIndex = selected;
			clip.modelLoop = !!seq && !seq.NonLooping;
			clip.modelDuration = seq ? (seq.Interval[1] - seq.Interval[0]) / 1000 : 0;
			clip.cache = all ? 'clips/' + clipIndex + '.bin' : 'frames.bin';
			cacheBytes += frameData.length; particleSlots += clip.batches.reduce((sum, b) => sum + b.maxParticles, 0);
			if (cacheBytes > 128 * 1024 * 1024 || particleSlots > 20000) throw new Error('Combined animation bakes exceed the Blender cache budget. Reduce duration/FPS or export the selected animation.');
			zip.addFile(clip.cache, frameData); clips.push(clip);
		}
		if (!modelFile && !clips.some(c => c.totalSprites)) throw new Error('No supported sprite particles were produced. Try another animation or a longer bake. ' + warnings.join(' '));
		if (modelOnly) warnings.push('No PopcornFX emitters: exported the model and ' + (all ? 'all animations' : 'selected animation') + ' without baked particles.');
		const manifest = all ? { schema: 'wow.export.wc3fx.v2', clips, defaultClip: Math.max(0, indices.indexOf(sequence)) } : clips[0];
		manifest.source = name; manifest.model = modelFile; manifest.dependencies = [];
		if (teamColor?.materials.length) manifest.teamColor = teamColor;
		let originalIndex = 0;
		for (const [source, bytes] of originals) { const file = 'sources/effect-' + originalIndex++ + '.pkb'; zip.addFile(file, bytes); manifest.dependencies.push({ reference: source, source, file }); }
		const collect = async (reference, owner) => {
			if (/PopcornFXCore[\\/]Materials[\\/][^\\/]+\.pkma$/i.test(reference)) {
				manifest.dependencies.push({ reference, builtin: true, note: 'Material reconstructed from the baked renderer properties.' });
				return null;
			}
			const texture = /\.(tif|tga|dds|blp|png)$/i.test(reference);
			const resolved = texture ? storage.resolveTexture(reference, owner) : storage.resolveAsset(reference, owner);
			if (!resolved) { warnings.push('Missing dependency: ' + reference); return null; }
			if (copied.has(resolved)) return copied.get(resolved);
			const dependency = { reference, source: resolved, file: 'dependencies/' + copied.size + path.extname(resolved) };
			copied.set(resolved, dependency); manifest.dependencies.push(dependency);
			try {
				const bytes = await storage.readFile(resolved); zip.addFile(dependency.file, bytes);
				if (texture) { const image = /\.png$/i.test(resolved) ? bytes : png(decodeTexture(bytes)); dependency.image = 'textures/' + copied.size + '.png'; zip.addFile(dependency.image, image); }
			} catch (e) { warnings.push(reference + ': ' + e.message); }
			return dependency;
		};
		options.progress?.('Collecting effect textures and dependencies…');
		for (const item of bakeDependencies) for (const reference of item.references) await collect(reference, item.source);
		for (const batch of clips.flatMap(c => c.batches)) {
			const dependency = batch.texture ? await collect(batch.texture, batch.source) : null;
			batch.image = dependency?.image || null;
			if (batch.maxParticles && !batch.image) warnings.push(batch.emitter + ': missing/unsupported particle texture; Blender will use a placeholder.');
			if (batch.flipUVs) warnings.push(batch.emitter + ': the FlipUVs renderer flag is not yet reproduced.');
		}
		if (!modelOnly) warnings.push('Particle material blending is approximate. Camera-dependent simulation uses a fixed bake camera; Blender billboards face the active render camera.');
		manifest.warnings = [...new Set(warnings)];
		zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
		options.progress?.('Writing Blender effect package…');
		const bytes = await new Promise((resolve, reject) => zip.toBuffer(resolve, reject));
		const file = await writeOutput(directory, outputName, bytes, options.overwrite);
		return { file, manifest, warnings: manifest.warnings };
	} finally {
		if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('wow-wc3-fx-')) await fs.rm(temporary, { recursive: true, force: true });
	}
}

module.exports = { sequenceGate, sampleEmitters, exportEffectPackage };
