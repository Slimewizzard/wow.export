/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */
const BLPFile = require('../casc/blp');
const listfile = require('../casc/listfile');
const log = require('../log');
const overlay = require('./char-texture-overlay');

class CharacterSourceTextures {
	constructor() {
		this.entries = new Map();
		this.generation = 0;
	}

	clear() {
		this.generation++;
		for (const canvas of this.entries.keys())
			overlay.remove(canvas);
		this.entries.clear();
	}

	get(canvas) {
		return this.entries.get(canvas);
	}

	async load(m2) {
		this.clear();
		const generation = this.generation;
		const seen = new Set();
		for (let i = 0; i < m2.textures.length; i++) {
			const texture = m2.textures[i];
			const fileDataID = texture.fileDataID;
			if (m2.textureTypes[i] !== 0 || !(fileDataID > 0) || seen.has(fileDataID))
				continue;
			seen.add(fileDataID);

			try {
				const data = await texture.getTextureFile();
				if (generation !== this.generation)
					return;

				// The renderer has already consumed this cached BufferWrapper.
				data.seek(0);
				const blp = new BLPFile(data);
				const canvas = blp.toCanvas();
				const fileName = listfile.getByID(fileDataID) || `unknown/${fileDataID}.blp`;
				const label = `${fileName} (FileDataID: ${fileDataID})`;
				canvas.title = label;
				this.entries.set(canvas, { fileDataID, fileName, blp });
				overlay.add(canvas, label);
			} catch (e) {
				if (generation !== this.generation)
					return;
				log.write('Failed to preview character source texture %d: %s', fileDataID, e.message);
			}
		}
	}
}

module.exports = CharacterSourceTextures;
