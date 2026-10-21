const war3 = require('./vendor/war3-model');

function parseModel(buffer) {
	if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'MDLX') throw new Error('Not a Warcraft III MDX model');
	const bytes = Buffer.from(buffer);
	let version = 800;
	for (let p = 4; p < bytes.length;) {
		if (p + 8 > bytes.length) throw new Error('Truncated MDX chunk header');
		const tag = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4), end = p + 8 + size;
		if (end > bytes.length) throw new Error('Truncated MDX ' + tag + ' chunk');
		if (tag === 'VERS') {
			if (size !== 4) throw new Error('Invalid MDX version chunk');
			version = bytes.readUInt32LE(p + 8);
		}
		// Retail 3.0.1 (MDX 1800) stores camera flags in the high byte of
		// the inclusive record size. Strip those flags before parsing.
		if (tag === 'CAMS' && version >= 1800) {
			for (let c = p + 8; c < end;) {
				const length = bytes.readUInt32LE(c) & 0xffffff;
				if (length < 120 || c + length > end) throw new Error('Invalid MDX camera record');
				bytes.writeUInt32LE(length, c); c += length;
			}
		}
		p = end;
	}
	const model = war3.parseMDX(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
	for (const geoset of model.Geosets) {
		if (geoset.SkinWeights instanceof Uint16Array) {
			geoset.SkinWeights16 = geoset.SkinWeights;
			geoset.SkinWeights = Uint8Array.from(geoset.SkinWeights);
		}
	}
	for (const node of model.Nodes) if (node) {
		if (!node.PivotPoint) node.PivotPoint = new Float32Array(3);
		if (node.Parent != null && !model.Nodes[node.Parent]) throw new Error('MDX node references a missing parent');
	}
	return model;
}

function defaultSequence(model) {
	const sequences = model.Sequences || [];
	const preferred = sequences.findIndex(s => /^stand(?:\s+\d+)?$/i.test(s.Name));
	if (preferred >= 0) return preferred;
	const idle = sequences.findIndex(s => /^(stand|idle)\b/i.test(s.Name));
	if (idle >= 0) return idle;
	const looping = sequences.findIndex(s => !s.NonLooping);
	return looping >= 0 ? looping : 0;
}

module.exports = { parseModel, defaultSequence, war3 };
