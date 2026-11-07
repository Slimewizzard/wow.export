const { mat4, vec3, quat } = require('./vendor/gl-matrix');
const { war3, defaultSequence } = require('./model');
const { decodeTexture } = require('./textures');

class Warcraft3Preview {
	static validateSkinning(model) {
		// Only mesh influences need a GPU matrix slot. Attachments, emitters and
		// other helper nodes still animate on the CPU and may have higher IDs.
		const check = id => {
			if (id >= 254) throw new Error('This model uses mesh bones beyond the preview renderer’s 254-bone limit. Native and GLB exports remain available.');
		};
		for (const geoset of model.Geosets) {
			const skin = geoset.SkinWeights16 || geoset.SkinWeights;
			if (skin) {
				for (let i = 0; i < skin.length; i += 8) for (let k = 0; k < 4; k++)
					if (skin[i + 4 + k]) check(skin[i + k]);
			} else for (const group of geoset.Groups) for (const id of group) check(id);
		}
	}
	constructor(canvas, onFrame, onError) {
		this.canvas = canvas; this.onFrame = onFrame; this.onError = onError;
		this.gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
		if (!this.gl) throw new Error('WebGL 2 is required for model previews');
		this.playing = true; this.speed = 1; this.lod = 0; this.wireframe = false; this.disposed = false;
		this.yaw = -0.65; this.pitch = 0.22; this.distance = 200; this.target = [0, 0, 50];
		this.abort = new AbortController();
		const events = { signal: this.abort.signal };
		let drag = null;
		canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, button: e.button }; canvas.setPointerCapture(e.pointerId); }, events);
		canvas.addEventListener('pointerup', () => drag = null, events);
		canvas.addEventListener('pointercancel', () => drag = null, events);
		canvas.addEventListener('contextmenu', e => e.preventDefault(), events);
		canvas.addEventListener('pointermove', e => {
			if (!drag) return;
			const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
			if (drag.button === 2 || e.shiftKey) {
				this.target[0] += Math.sin(this.yaw) * dx * this.distance / 500;
				this.target[1] -= Math.cos(this.yaw) * dx * this.distance / 500;
				this.target[2] += dy * this.distance / 500;
			} else { this.yaw -= dx * 0.01; this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + dy * 0.01)); }
			drag.x = e.clientX; drag.y = e.clientY;
		}, events);
		canvas.addEventListener('wheel', e => { e.preventDefault(); this.distance = Math.max(0.1, Math.min(100000, this.distance * Math.exp(e.deltaY * 0.001))); }, { ...events, passive: false });
	}
	async load(storage, name, model) {
		Warcraft3Preview.validateSkinning(model);
		const renderModel = model.Sequences.length ? model : { ...model, Sequences: [{ Name: 'Static', Interval: [0, 1], NonLooping: true }] };
		this.renderer = new war3.ModelRenderer(renderModel);
		this.renderer.setSequence(defaultSequence(renderModel));
		this.renderer.initGL(this.gl);
		this.renderer.setLightColor([4, 4, 4]);
		// Environment conversion is expensive and not needed for the asset inspector.
		this.renderer.rendererData.requiredEnvMaps = {};
		const warnings = [], loaded = new Set();
		for (const texture of model.Textures) if (texture.Image) {
			if (this.disposed) return warnings;
			if (loaded.has(texture.Image)) continue;
			loaded.add(texture.Image);
			try {
				const resolved = storage.resolveTexture(texture.Image, name);
				if (!resolved) throw new Error('not found');
				const image = decodeTexture(await storage.readFile(resolved));
				if (this.disposed) return warnings;
				this.renderer.setTextureImageData(texture.Image, [new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)]);
			} catch (e) {
				warnings.push(texture.Image + ': ' + e.message);
				if (!this.disposed) this.renderer.setTextureImageData(texture.Image, [new ImageData(new Uint8ClampedArray([255, 0, 255, 255]), 1, 1)]);
			}
		}
		if (this.disposed) return warnings;
		this.model = model;
		this.renderer.update(0);
		this.fit(true); this.start();
		return warnings;
	}
	fit(initial = false) {
		if (!this.model) return;
		const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
		const atLOD = this.model.Geosets.filter(g => g.LevelOfDetail === undefined || g.LevelOfDetail === this.lod);
		const visible = atLOD.filter(g => !(this.renderer.rendererData.geosetAlpha[this.model.Geosets.indexOf(g)] < 0.001));
		// Birth/death frames may hide every geoset. Still frame the model, so
		// switching animations or resuming playback does not leave it off-camera.
		for (const g of visible.length ? visible : atLOD) {
			for (let i = 0; i < g.Vertices.length; i++) { const c = i % 3; minimum[c] = Math.min(minimum[c], g.Vertices[i]); maximum[c] = Math.max(maximum[c], g.Vertices[i]); }
		}
		if (Number.isFinite(minimum[0])) {
			this.target = minimum.map((n, i) => (n + maximum[i]) / 2);
			this.distance = Math.max(1, Math.hypot(...maximum.map((n, i) => n - minimum[i])) * 1.25);
			if (initial && maximum[2] - minimum[2] < Math.max(maximum[0] - minimum[0], maximum[1] - minimum[1]) * 0.05) this.pitch = 0.85;
		}
	}
	start() {
		if (this.disposed || this.frameId) return;
		let last;
		const tick = now => {
			this.frameId = 0;
			if (this.disposed || !this.renderer) return;
			try {
				const gl = this.gl, canvas = this.canvas, ratio = Math.min(window.devicePixelRatio || 1, 2);
				const width = Math.max(1, Math.round(canvas.clientWidth * ratio)), height = Math.max(1, Math.round(canvas.clientHeight * ratio));
				if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
				gl.viewport(0, 0, width, height); gl.clearColor(0.055, 0.065, 0.085, 1);
				// Blended WC3 layers disable depth writes; restore them before clearing.
				gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
				gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
				const eye = [this.target[0] + this.distance * Math.cos(this.yaw) * Math.cos(this.pitch), this.target[1] + this.distance * Math.sin(this.yaw) * Math.cos(this.pitch), this.target[2] + this.distance * Math.sin(this.pitch)];
				const view = mat4.lookAt(mat4.create(), eye, this.target, [0, 0, 1]), projection = mat4.perspective(mat4.create(), Math.PI / 4, width / height, Math.max(0.01, this.distance / 1000), this.distance * 100);
				const camera = mat4.invert(mat4.create(), view), rotation = mat4.getRotation(quat.create(), camera);
				this.renderer.setCamera(vec3.fromValues(...eye), rotation);
				this.renderer.setLightPosition(vec3.fromValues(...eye));
				this.renderer.update(this.playing && last !== undefined ? Math.min(100, now - last) * this.speed : 0);
				this.renderer.render(view, projection, { wireframe: this.wireframe, levelOfDetail: this.lod, useEnvironmentMap: false });
				this.onFrame?.(this.renderer.getFrame()); last = now;
				this.frameId = requestAnimationFrame(tick);
			} catch (error) { this.onError?.(error); }
		};
		this.frameId = requestAnimationFrame(tick);
	}
	stop() { cancelAnimationFrame(this.frameId); this.frameId = 0; }
	destroy() {
		if (this.disposed) return;
		this.disposed = true; this.stop(); this.abort.abort();
		const renderer = this.renderer;
		if (renderer) {
			renderer.destroy();
			// Upstream releases programs/controllers, but leaves model buffers and textures.
			for (const field of ['vertexBuffer', 'normalBuffer', 'texCoordBuffer', 'indexBuffer', 'wireframeIndexBuffer', 'groupBuffer', 'skinWeightBuffer', 'tangentBuffer'])
				for (const buffer of renderer[field] || []) if (buffer) this.gl.deleteBuffer(buffer);
			for (const field of ['textures', 'envTextures', 'irradianceMap', 'prefilteredEnvMap'])
				for (const texture of Object.values(renderer.rendererData[field] || {})) this.gl.deleteTexture(texture);
			if (renderer.brdfLUT) this.gl.deleteTexture(renderer.brdfLUT);
		}
		this.renderer = null;
	}
}

module.exports = Warcraft3Preview;
