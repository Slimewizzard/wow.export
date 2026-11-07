const Vue = require('vue');
const path = require('path');
const InstallType = require('../install-type');
const { parseModel, defaultSequence } = require('../warcraft3/model');
const { decodeTexture, png } = require('../warcraft3/textures');
const { exportRaw, createGLB, writeOutput, safePath, checkOutput } = require('../warcraft3/exporter');
const { matchesKind, indexModelTypes } = require('../warcraft3/asset-types');
const { exportEffectPackage } = require('../warcraft3/effects');
const Warcraft3Preview = require('../warcraft3/preview');

const previews = new WeakMap();

module.exports = {
	register() { this.registerNavButton('Warcraft III', 'cube.svg', InstallType.WARCRAFT3); },
	data() {
		return { browserWidth: 0.34, search: '', kind: 'models', art: 'hd', selection: [], files: [], modelTypes: Vue.markRaw(new Map()), classificationStatus: '', current: '', status: '', error: '', warnings: [], model: null, imageURL: '', textureInfo: '', textPreview: '', previewMessage: '', exportResults: [], loading: false, exporting: false, sequence: 0, frame: 0, playing: true, speed: 1, lod: 0, wireframe: false, team: '#ff0000', format: 'glb', animationMode: 'all', effectSeconds: 3, effectFPS: 30, batchStatus: '', cancelExport: false, generation: 0 };
	},
	computed: {
		storage() { return this.$core.view.warcraft3; },
		items() {
			return this.files.filter(name => {
				if (this.art === 'hd' && !name.includes('/_hd.w3mod/')) return false;
				if (this.art === 'sd' && (name.includes('/_hd.w3mod/') || name.includes('/_de.w3mod/'))) return false;
				if (this.art === 'de' && !name.includes('/_de.w3mod/')) return false;
				return matchesKind(name, this.kind, this.modelTypes);
			});
		},
		sequences() { return this.model?.Sequences || []; },
		interval() { return this.sequences[this.sequence]?.Interval || [0, 1]; },
		lods() { return [...new Set((this.model?.Geosets || []).map(g => g.LevelOfDetail ?? 0))].sort((a, b) => a - b); },
		teamColor() { return [1, 3, 5].map(i => parseInt(this.team.slice(i, i + 2), 16) / 255); },
		info() { return this.current ? this.storage?.files.get(this.current) : null; }
	},
	template: `
		<div class="tab wc3-tab" :class="{ 'wc3-toastgap': $core.view.toast !== null }" :style="{ '--wc3-browser-width': (browserWidth * 100) + '%' }">
			<div class="wc3-browser" ref="browser">
				<div class="wc3-heading">Warcraft III <small>{{ storage?.build.Version }}</small></div>
				<div class="wc3-filters">
					<select v-model="art" aria-label="Art set"><option value="hd">Reforged HD</option><option value="sd">Classic SD</option><option value="de">Definitive</option><option value="all">All art sets</option></select>
					<select v-model="kind" aria-label="File type"><option value="models">Models</option><option value="popcorn">PopcornFX effects</option><option value="textures">Textures</option><option value="audio">Audio</option><option value="all">All files</option></select>
				</div>
				<input v-model="search" type="search" placeholder="Search names and paths…" aria-label="Search Warcraft III files" />
				<div v-if="classificationStatus" class="wc3-hint" role="status">{{ classificationStatus }}</div>
				<div v-if="kind === 'popcorn'" class="wc3-hint">Compiled effects and MDX files with PopcornFX. Models with attached effects appear in both categories.</div>
				<div class="wc3-file-list"><component :is="$components.Listbox" v-model:selection="selection" :items="items" :filter="search" :keyinput="true" :includefilecount="true" unittype="file" persistscrollkey="warcraft3-files" /></div>
				<div class="wc3-hint">Ctrl/Shift-click to select multiple files.</div>
			</div>
			<div class="wc3-divider" role="separator" aria-orientation="vertical" aria-label="File list width" :aria-valuenow="Math.round(browserWidth * 100)" aria-valuemin="15" aria-valuemax="85" tabindex="0" title="Drag to resize. Double-click to reset."
				@pointerdown="startSidebarResize" @pointermove="moveSidebarResize" @pointerup="endSidebarResize" @pointercancel="endSidebarResize" @lostpointercapture="endSidebarResize" @dblclick="resetSidebarWidth" @keydown="resizeSidebarKey"></div>
			<div class="wc3-inspector">
				<div class="wc3-file-title" :title="current">{{ current || 'Choose an asset to preview' }}</div>
				<div class="wc3-meta" v-if="info">{{ (info.size / 1024).toFixed(1) }} KiB · {{ info.available ? 'Installed locally' : 'Not installed locally' }}<span v-if="model"> · MDX {{ model.Version }} · {{ model.Geosets.length }} mesh sections · {{ model.Nodes.filter(Boolean).length }} nodes</span><span v-if="textureInfo"> · {{ textureInfo }}</span></div>
				<div class="wc3-stage">
					<canvas ref="canvas" v-show="model" aria-label="Warcraft III model preview"></canvas>
					<img v-if="imageURL" :src="imageURL" class="wc3-texture" alt="Selected Warcraft III texture" />
					<pre v-if="textPreview">{{ textPreview }}</pre>
					<div v-if="!model && !imageURL && !textPreview && !loading && !previewMessage" class="wc3-empty">{{ current ? 'Raw file export is available below.' : 'Browse models, textures, animations and other game files.' }}</div>
					<div v-if="loading" class="wc3-overlay">{{ status }}</div>
					<div v-else-if="previewMessage" class="wc3-empty">{{ previewMessage }}</div>
				</div>
				<div class="wc3-error" v-if="error" role="alert">{{ error }}</div>
				<details v-if="warnings.length" class="wc3-warnings"><summary>{{ warnings.length }} preview/export note{{ warnings.length === 1 ? '' : 's' }}</summary><ul><li v-for="note in warnings" :key="note">{{ note }}</li></ul></details>
				<div class="wc3-controls" v-if="model">
					<button @click="playing = !playing" :disabled="!sequences.length">{{ playing ? 'Pause' : 'Play' }}</button>
					<select v-model.number="sequence" aria-label="Animation" :disabled="!sequences.length"><option v-if="!sequences.length" :value="0">Static model</option><option v-for="(seq, i) in sequences" :value="i">{{ seq.Name }}</option></select>
					<select v-model.number="speed" aria-label="Playback speed"><option :value="0.25">0.25×</option><option :value="0.5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option></select>
					<select v-if="lods.length" v-model.number="lod" aria-label="Level of detail"><option v-for="level in lods" :value="level">LOD {{ level }}</option></select>
					<input type="color" v-model="team" aria-label="Team color" title="Team color" />
					<label><input type="checkbox" v-model="wireframe" /> Wireframe</label><button @click="fit">Fit</button>
					<input class="wc3-timeline" type="range" :min="interval[0]" :max="interval[1]" :value="frame" @input="scrub" aria-label="Animation timeline" />
					<span class="wc3-hint">Drag to orbit · Scroll to zoom · Right-drag to pan</span>
				</div>
				<div class="wc3-export">
					<div class="wc3-export-options">
						<select v-model="format" aria-label="Export format"><option value="glb">GLB model + textures</option><option value="blender-fx">Blender + PopcornFX (experimental)</option><option value="png">PNG textures</option><option value="raw">Original files + model textures</option></select>
						<select v-if="format === 'glb' || format === 'blender-fx'" v-model="animationMode" aria-label="Animations to export"><option value="all">All animations</option><option value="current">Selected animation</option><option v-if="format === 'glb'" value="none">No animations</option></select>
						<label><input type="checkbox" v-model="$core.view.config.overwriteFiles" :disabled="exporting" /> Overwrite if already exists</label>
						<button @click="exportSelection" :disabled="!selection.length || exporting || loading || $core.view.isBusy">Export {{ selection.length || '' }} selected</button>
						<button v-if="exporting" @click="cancelExport = true">Cancel after current file</button>
					</div>
					<div v-if="format === 'blender-fx'" class="wc3-export-options wc3-hint">
						<label>Bake seconds <input type="number" v-model.number="effectSeconds" min="0.1" max="30" step="0.1" style="width: 65px" /></label>
						<label>FPS <select v-model.number="effectFPS"><option :value="15">15</option><option :value="30">30</option><option :value="60">60</option></select></label>
						<span>Bake seconds applies to each exported animation's particles. Full skeletal clips are retained. Sprites only.</span>
						<button @click="revealBlenderImporter">Show Blender importer</button>
					</div>
					<div v-if="format === 'blender-fx' && model && !model.ParticleEmitterPopcorns?.length" class="wc3-hint">No PopcornFX: exports the model and chosen animations. Classic particles are not baked.</div>
					<div class="wc3-output"><span :title="$core.view.config.exportDirectory">Output: {{ $core.view.config.exportDirectory || 'Choose an output folder' }}</span><button @click="chooseOutput" :disabled="exporting">Choose folder…</button></div>
					<div v-if="batchStatus" role="status">{{ batchStatus }}</div>
					<details v-if="exportResults.length" class="wc3-export-results" open>
						<summary>Export locations ({{ exportResults.length }})</summary>
						<div v-for="result in exportResults" :key="result.path" class="wc3-export-result">
							<span :title="result.path">{{ result.existing ? 'Already exists: ' : 'Saved: ' }}{{ result.path }}</span>
							<button @click="revealExport(result.path)">Show in folder</button>
						</div>
					</details>
				</div>
			</div>
		</div>
	`,
	watch: {
		format(value) { if (value === 'blender-fx' && this.animationMode === 'none') this.animationMode = 'all'; },
		selection(values) { if (values.length) this.preview(values[0]); },
		kind() { this.selection = []; this.format = this.kind === 'models' ? 'glb' : this.kind === 'textures' ? 'png' : 'raw'; },
		art() { this.selection = []; },
		storage() { this.loadFiles(); },
		playing(value) { const p = previews.get(this); if (p) p.playing = value; },
		speed(value) { const p = previews.get(this); if (p) p.speed = value; },
		wireframe(value) { const p = previews.get(this); if (p) p.wireframe = value; },
		lod(value) { const p = previews.get(this); if (p) { p.lod = value; p.fit(); } },
		team() { previews.get(this)?.renderer?.setTeamColor(this.teamColor); },
		sequence(value) { previews.get(this)?.renderer?.setSequence(value); }
	},
	methods: {
		startSidebarResize(event) {
			if (event.button !== 0) return;
			event.preventDefault();
			const bounds = this.$refs.browser.getBoundingClientRect();
			const style = getComputedStyle(this.$el);
			this._wc3Resize = { x: event.clientX, width: bounds.width, total: this.$el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		moveSidebarResize(event) {
			if (!this._wc3Resize) return;
			const { x, width, total } = this._wc3Resize;
			this.browserWidth = Math.max(0.15, Math.min(0.85, (width + event.clientX - x) / total));
		},
		endSidebarResize() {
			if (!this._wc3Resize) return;
			this._wc3Resize = null;
			this.$core.view.config.warcraft3BrowserWidth = this.browserWidth;
		},
		resetSidebarWidth() { this.browserWidth = 0.34; this.$core.view.config.warcraft3BrowserWidth = this.browserWidth; },
		resizeSidebarKey(event) {
			const next = { ArrowLeft: this.browserWidth - 0.02, ArrowRight: this.browserWidth + 0.02, Home: 0.15, End: 0.85 }[event.key];
			if (next === undefined) return;
			event.preventDefault(); this.browserWidth = Math.max(0.15, Math.min(0.85, next));
			this.$core.view.config.warcraft3BrowserWidth = this.browserWidth;
		},
		loadFiles() {
			this._wc3IndexTask = (this._wc3IndexTask || 0) + 1;
			const task = this._wc3IndexTask, storage = this.storage;
			this.disposePreview(); this.current = ''; this.model = null; this.imageURL = ''; this.selection = []; this.previewMessage = '';
			this.files = Vue.markRaw([...this.storage?.files.keys() || []].sort());
			this.modelTypes = Vue.markRaw(new Map()); this.classificationStatus = '';
			if (!storage) return;
			const cancelled = () => task !== this._wc3IndexTask;
			const cacheFile = path.join(nw.App.dataPath, 'cache', 'warcraft3-asset-types.json');
			indexModelTypes(storage, cacheFile, ({ done, total }) => {
				if (!cancelled()) this.classificationStatus = 'Classifying models and effects: ' + done.toLocaleString() + ' / ' + total.toLocaleString() + '…';
			}, cancelled).then(result => {
				if (cancelled()) return;
				this.modelTypes = Vue.markRaw(result.types);
				this.classificationStatus = result.unknown ? result.unknown.toLocaleString() + ' unreadable MDX files remain under Models and All files.' : '';
				if (result.cacheError) this.classificationStatus += ' Classification cache could not be saved; files will be checked again next time.';
			}).catch(() => { if (!cancelled()) this.classificationStatus = 'Model classification failed. MDX files remain under Models; compiled effects are available under PopcornFX effects.'; });
		},
		disposePreview() { this.generation++; previews.get(this)?.destroy(); previews.delete(this); },
		async preview(name) {
			if (this.exporting) return;
			this.disposePreview(); const generation = this.generation;
			this.current = name; this.model = null; this.imageURL = ''; this.textureInfo = ''; this.textPreview = ''; this.previewMessage = ''; this.error = ''; this.warnings = []; this.loading = true; this.status = 'Loading asset…';
			try {
				const data = await this.storage.readFile(name);
				if (generation !== this.generation) return;
				if (/\.mdx$/i.test(name)) {
					this.model = Vue.markRaw(parseModel(data)); this.sequence = defaultSequence(this.model); this.lod = this.lods[0] ?? 0;
					if (!this.model.Geosets.some(g => g.Vertices.length && g.Faces.length) && !this.model.ParticleEmitters2.length && !this.model.RibbonEmitters.length)
						this.previewMessage = this.model.ParticleEmitterPopcorns?.length ? 'This asset contains only PopcornFX effects. This preview renderer cannot display them. Original file export is available below.' : 'This asset has no renderable mesh or supported particle effects. Original file export is available below.';
					await this.$nextTick();
					if (generation !== this.generation) return;
					const p = new Warcraft3Preview(this.$refs.canvas, frame => this.frame = frame, e => this.error = e.message);
					previews.set(this, p); p.lod = this.lod; p.playing = this.playing; p.speed = this.speed; p.wireframe = this.wireframe;
					this.status = 'Loading model textures…';
					const warnings = await p.load(this.storage, name, this.model);
					if (generation !== this.generation) return;
					p.renderer?.setTeamColor(this.teamColor); this.warnings = warnings;
					if (this._wc3Inactive) p.stop();
					if (this.model.ParticleEmitterPopcorns?.length) this.warnings.push('PopcornFX effects are not rendered. Native export retains the MDX effect references.');
				} else if (/\.(dds|blp)$/i.test(name)) {
					const image = decodeTexture(data);
					this.imageURL = 'data:image/png;base64,' + png(image).toString('base64');
					this.textureInfo = image.width + ' × ' + image.height + ' · ' + image.format;
				} else if (/\.(pkb|pkfx)$/i.test(name)) {
					this.textureInfo = 'PopcornFX effect';
					this.previewMessage = 'PopcornFX effect playback is not supported yet. Original file export is available below.';
				} else if (/\.(txt|slk|ini|json|xml|lua|j|fdf|toc|md|html)$/i.test(name)) this.textPreview = data.subarray(0, 65536).toString('utf8');
			} catch (e) { if (generation === this.generation) this.error = e.message; }
			finally { if (generation === this.generation) this.loading = false; }
		},
		fit() { previews.get(this)?.fit(); },
		scrub(event) { this.playing = false; this.frame = Number(event.target.value); const p = previews.get(this); if (p?.renderer) p.renderer.rendererData.frame = this.frame; },
		revealExport(file) { nw.Shell.showItemInFolder(file); },
		revealBlenderImporter() { this.revealExport(path.join(nw.__dirname, 'addons/blender/io_scene_wc3fx.py')); },
		chooseOutput() {
			const input = document.createElement('input'); input.type = 'file'; input.setAttribute('nwdirectory', '');
			input.setAttribute('nwdirectorydesc', 'Choose Warcraft III export folder');
			input.onchange = () => { if (input.value) this.$core.view.config.exportDirectory = input.value; }; input.click();
		},
		async exportSelection() {
			if (this.exporting || this.$core.view.isBusy) return;
			if (!this.$core.view.config.exportDirectory) { this.chooseOutput(); return; }
			const names = [...this.selection], format = this.format, notes = [], out = this.$core.view.config.exportDirectory;
			const options = { overwrite: this.$core.view.config.overwriteFiles, animationMode: this.animationMode, animations: this.animationMode !== 'none', sequence: this.animationMode === 'current' ? this.sequence : -1, effectSeconds: this.effectSeconds, effectFPS: this.effectFPS, teamColor: this.teamColor, lod: this.lod, progress: text => this.batchStatus = text };
			this.exporting = true; this.cancelExport = false; this.error = ''; this.exportResults = []; let success = 0, failed = 0, skipped = 0;
			const lock = this.$core.create_busy_lock();
			try {
				for (const name of names) {
					if (this.cancelExport) break;
					this.batchStatus = 'Exporting ' + path.basename(name) + '…';
					let destination;
					try {
						if ((format === 'glb' && !/\.mdx$/i.test(name)) || (format === 'png' && !/\.(dds|blp)$/i.test(name)) || (format === 'blender-fx' && !/\.(mdx|pkb|pkfx)$/i.test(name))) { skipped++; continue; }
						const outputName = format === 'glb' ? name.replace(/\.mdx$/i, '.glb') : format === 'png' ? name + '.png' : format === 'blender-fx' ? name + '.wc3fx' : name;
						destination = safePath(out, outputName);
						await checkOutput(out, outputName, options.overwrite);
						if (format === 'glb') {
							const result = await createGLB(this.storage, name, options);
							await writeOutput(out, outputName, result.data, options.overwrite);
							notes.push(...result.warnings.map(w => path.basename(name) + ': ' + w));
						} else if (format === 'blender-fx') {
							const result = await exportEffectPackage(this.storage, name, out, { ...options, sequence: name === this.current ? this.sequence : -1 });
							notes.push(...result.warnings.map(w => path.basename(name) + ': ' + w));
						} else if (format === 'png') {
							await writeOutput(out, outputName, png(decodeTexture(await this.storage.readFile(name))), options.overwrite);
						} else {
							notes.push(...(await exportRaw(this.storage, name, out, options)).warnings);
						}
						this.exportResults.push({ path: destination, existing: false });
						success++;
					} catch (e) {
						if (e.code === 'EEXIST') { skipped++; notes.push('Already exists: ' + name); if (destination) this.exportResults.push({ path: destination, existing: true }); }
						else { failed++; notes.push(name + ': ' + e.message); if (!this.error) this.error = path.basename(name) + ': ' + e.message; }
					}
					await new Promise(resolve => setTimeout(resolve, 0));
				}
				this.warnings = [...new Set(notes)];
				this.batchStatus = (this.cancelExport ? 'Cancelled. ' : '') + success + ' exported · ' + failed + ' failed · ' + skipped + ' skipped';
				const first = this.exportResults[0]?.path;
				const actions = first ? { [this.exportResults.length > 1 ? 'Show first file in folder' : 'Show file in folder']: () => this.revealExport(first) } : null;
				this.$core.setToast(failed ? 'error' : 'success', failed ? this.batchStatus + ' — ' + this.error : this.batchStatus, actions);
			} finally { this.exporting = false; lock[Symbol.dispose](); }
		}
	},
	mounted() { const width = this.$core.view.config.warcraft3BrowserWidth; if (Number.isFinite(width)) this.browserWidth = Math.max(0.15, Math.min(0.85, width)); this.loadFiles(); },
	activated() { this._wc3Inactive = false; previews.get(this)?.start(); },
	deactivated() { this.endSidebarResize(); this._wc3Inactive = true; previews.get(this)?.stop(); },
	beforeUnmount() { this._wc3IndexTask = (this._wc3IndexTask || 0) + 1; this.endSidebarResize(); this.disposePreview(); }
};
