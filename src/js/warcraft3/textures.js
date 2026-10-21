const zlib = require('zlib');
const { war3 } = require('./model');

function dimensions(width, height) {
	if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024)
		throw new Error('Unsupported texture dimensions');
}

function decodeDDS(b) {
	if (b.length < 128 || b.toString('ascii', 0, 4) !== 'DDS ' || b.readUInt32LE(4) !== 124)
		throw new Error('Invalid DDS header');
	const height = b.readUInt32LE(12), width = b.readUInt32LE(16);
	dimensions(width, height);
	let format = b.toString('ascii', 84, 88), start = 128;
	if (format === 'DX10') {
		if (b.length < 148) throw new Error('Truncated DDS DX10 header');
		format = ({ 71: 'DXT1', 72: 'DXT1', 74: 'DXT3', 75: 'DXT3', 77: 'DXT5', 78: 'DXT5', 80: 'ATI1', 83: 'ATI2' })[b.readUInt32LE(128)] || 'DXGI ' + b.readUInt32LE(128);
		start = 148;
	}
	const pixels = new Uint8ClampedArray(width * height * 4);
	if (!(b.readUInt32LE(80) & 4)) {
		const bits = b.readUInt32LE(88), masks = [92, 96, 100, 104].map(p => b.readUInt32LE(p));
		if (![24, 32].includes(bits)) throw new Error('Unsupported uncompressed DDS bit depth: ' + bits);
		const bytes = bits / 8;
		const pitch = Math.max(width * bytes, (b.readUInt32LE(8) & 8) ? b.readUInt32LE(20) : 0);
		if (b.length < start + pitch * height) throw new Error('Truncated DDS pixels');
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			const value = b.readUIntLE(start + y * pitch + x * bytes, bytes);
			for (let c = 0; c < 4; c++) {
				let mask = masks[c] >>> 0, shift = 0;
				if (!mask) { pixels[(y * width + x) * 4 + c] = c === 3 ? 255 : 0; continue; }
				while (!(mask & 1)) { mask >>>= 1; shift++; }
				pixels[(y * width + x) * 4 + c] = ((value >>> shift) & mask) * 255 / mask;
			}
		}
		return { width, height, data: pixels, format: 'RGBA' };
	}
	if (!['DXT1', 'DXT3', 'DXT5', 'ATI1', 'ATI2', 'BC4U', 'BC5U'].includes(format))
		throw new Error('Unsupported DDS compression: ' + format);
	const bc4 = format === 'ATI1' || format === 'BC4U', bc5 = format === 'ATI2' || format === 'BC5U';
	const blockSize = format === 'DXT1' || bc4 ? 8 : 16;
	if (b.length < start + Math.ceil(width / 4) * Math.ceil(height / 4) * blockSize) throw new Error('Truncated DDS blocks');
	const alpha = p => {
		const a = [b[p], b[p + 1]];
		if (a[0] > a[1]) for (let j = 1; j <= 6; j++) a.push(((7 - j) * a[0] + j * a[1]) / 7);
		else { for (let j = 1; j <= 4; j++) a.push(((5 - j) * a[0] + j * a[1]) / 5); a.push(0, 255); }
		const packed = b.readUIntLE(p + 2, 6);
		return Array.from({ length: 16 }, (_, i) => a[Math.floor(packed / 2 ** (3 * i)) % 8]);
	};
	let p = start;
	for (let by = 0; by < height; by += 4) for (let bx = 0; bx < width; bx += 4) {
		let colors, selectors, a, r, g;
		if (bc4 || bc5) { r = alpha(p); g = bc5 ? alpha(p + 8) : r; }
		else {
			if (format === 'DXT5') a = alpha(p);
			if (format === 'DXT3') a = Array.from({ length: 16 }, (_, i) => ((b[p + (i >> 1)] >> ((i % 2) * 4)) & 15) * 17);
			const c = p + (format === 'DXT1' ? 0 : 8), c0 = b.readUInt16LE(c), c1 = b.readUInt16LE(c + 2);
			const rgb = n => [((n >> 11) & 31) * 255 / 31, ((n >> 5) & 63) * 255 / 63, (n & 31) * 255 / 31, 255];
			colors = [rgb(c0), rgb(c1)];
			if (c0 > c1 || format !== 'DXT1') {
				colors.push(colors[0].map((v, i) => (2 * v + colors[1][i]) / 3));
				colors.push(colors[0].map((v, i) => (v + 2 * colors[1][i]) / 3));
			} else { colors.push(colors[0].map((v, i) => (v + colors[1][i]) / 2)); colors.push([0, 0, 0, 0]); }
			selectors = b.readUInt32LE(c + 4);
		}
		for (let i = 0; i < 16; i++) {
			const x = bx + i % 4, y = by + (i >> 2);
			if (x >= width || y >= height) continue;
			const out = (y * width + x) * 4;
			if (r) {
				pixels[out] = r[i]; pixels[out + 1] = g[i];
				pixels[out + 2] = bc5 ? (Math.sqrt(Math.max(0, 1 - (r[i] / 127.5 - 1) ** 2 - (g[i] / 127.5 - 1) ** 2)) + 1) * 127.5 : r[i];
				pixels[out + 3] = 255;
			} else { pixels.set(colors[(selectors >>> (i * 2)) & 3], out); if (a) pixels[out + 3] = a[i]; }
		}
		p += blockSize;
	}
	return { width, height, data: pixels, format };
}

function decodeTexture(buffer) {
	if (buffer.toString('ascii', 0, 4) === 'DDS ') return decodeDDS(buffer);
	if (buffer.toString('ascii', 0, 4) === 'BLP1') {
		const blp = war3.decodeBLP(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
		dimensions(blp.width, blp.height);
		return { ...war3.getBLPImageData(blp, 0), format: 'BLP1' };
	}
	throw new Error('Texture preview/conversion supports BLP1 and DDS. Use raw export for this format.');
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
	return n >>> 0;
});
function png(image) {
	dimensions(image.width, image.height);
	const chunk = (name, data) => {
		const out = Buffer.alloc(data.length + 12);
		out.writeUInt32BE(data.length); out.write(name, 4); data.copy(out, 8);
		let crc = 0xffffffff;
		for (let i = 4; i < out.length - 4; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8);
		out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
	};
	const header = Buffer.alloc(13); header.writeUInt32BE(image.width); header.writeUInt32BE(image.height, 4); header[8] = 8; header[9] = 6;
	const stride = image.width * 4, rows = Buffer.alloc((stride + 1) * image.height);
	const pixels = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
	for (let y = 0; y < image.height; y++) pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodeTexture, decodeDDS, png };
