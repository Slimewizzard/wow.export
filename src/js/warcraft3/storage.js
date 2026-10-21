/* wow.export — read-only Warcraft III CASC/TVFS storage. MIT license.
 * TVFS layout reference: Ladislav Zezula's CascLib (see THIRD_PARTY.md).
 * This backend intentionally has no WoW listfile, DB2 or CDN dependency.
 */
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const normalize = name => name.replace(/[:\\]+/g, '/').replace(/\/+/g, '/').toLowerCase();
const MAX_FILE_SIZE = 512 * 1024 * 1024;
const hash = bytes => crypto.createHash('md5').update(bytes).digest('hex');

function range(data, offset, size) {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > data.length)
		throw new Error('Truncated or invalid CASC/TVFS data');
	return data.subarray(offset, offset + size);
}

function decodeBLTE(data, key = '') {
	if (range(data, 0, 8).toString('ascii', 0, 4) !== 'BLTE')
		throw new Error('Invalid BLTE signature');
	const header = data.readUInt32BE(4);
	if (key && !hash(header ? range(data, 0, header) : data).startsWith(key))
		throw new Error('CASC file checksum mismatch');
	const decode = bytes => {
		if (!bytes.length) throw new Error('Empty BLTE block');
		if (bytes[0] === 0x4e) return bytes.subarray(1);
		if (bytes[0] === 0x5a) return zlib.inflateSync(bytes.subarray(1), { maxOutputLength: MAX_FILE_SIZE });
		if (bytes[0] === 0x45) throw new Error('Encrypted WC3 file: no decryption key is available');
		throw new Error('Unsupported BLTE compression: ' + bytes[0]);
	};
	if (!header) return decode(data.subarray(8));
	range(data, 0, header);
	const count = data.readUIntBE(9, 3);
	if (data[8] !== 15 || !count || header !== 12 + count * 24)
		throw new Error('Invalid BLTE chunk table');
	let offset = header, total = 0;
	const chunks = [];
	for (let i = 0; i < count; i++) {
		const p = 12 + i * 24;
		const size = data.readUInt32BE(p), expected = data.readUInt32BE(p + 4);
		total += expected;
		if (total > MAX_FILE_SIZE) throw new Error('File exceeds the 512 MiB in-memory export limit');
		const packed = range(data, offset, size);
		if (hash(packed) !== data.toString('hex', p + 8, p + 24)) throw new Error('BLTE chunk checksum mismatch');
		const chunk = decode(packed);
		if (chunk.length !== expected) throw new Error('BLTE chunk size mismatch');
		chunks.push(chunk);
		offset += size;
	}
	return Buffer.concat(chunks);
}

function parseTVFS(data) {
	if (range(data, 0, 38).toString('ascii', 0, 4) !== 'TVFS' || data[4] !== 1 || ![9, 16].includes(data[6]))
		throw new Error('Unsupported Warcraft III TVFS manifest');
	const keySize = data[6];
	const pStart = data.readUInt32BE(12), pSize = data.readUInt32BE(16);
	const vStart = data.readUInt32BE(20), vSize = data.readUInt32BE(24);
	const cStart = data.readUInt32BE(28), cSize = data.readUInt32BE(32);
	const paths = range(data, pStart, pSize), vfs = range(data, vStart, vSize), cft = range(data, cStart, cSize);
	const width = cSize > 0xffffff ? 4 : cSize > 0xffff ? 3 : cSize > 0xff ? 2 : 1;
	const entries = [];
	function walk(start, end, prefix, depth) {
		if (depth > 256) throw new Error('TVFS directory nesting limit exceeded');
		let name = prefix;
		for (let p = start; p < end;) {
			if (paths[p] === 0) { name += '/'; p++; }
			if (paths[p] !== 255) {
				const n = paths[p++];
				if (p + n > end) throw new Error('Invalid TVFS path fragment');
				name += range(paths, p, n).toString('utf8'); p += n;
			}
			if (paths[p] === 0) { name += '/'; p++; }
			if (p >= end) throw new Error('TVFS path is missing a node');
			if (paths[p] !== 255) { name += '/'; continue; }
			range(paths, p, 5);
			const value = paths.readUInt32BE(p + 1); p += 5;
			if (value & 0x80000000) {
				const next = p + (value & 0x7fffffff) - 4;
				if (next < p || next > end) throw new Error('Invalid TVFS directory length');
				walk(p, next, name, depth + 1); p = next;
			} else {
				let v = value;
				const count = range(vfs, v++, 1)[0];
				if (count > 0 && count <= 224) {
					const spans = [];
					for (let i = 0; i < count; i++) {
						range(vfs, v, 8 + width);
						const offset = vfs.readUInt32BE(v), size = vfs.readUInt32BE(v + 4);
						const c = vfs.readUIntBE(v + 8, width);
						spans.push({ key: range(cft, c, keySize).toString('hex'), offset, size });
						v += 8 + width;
					}
					entries.push({ name: normalize(name), spans, size: spans.reduce((n, s) => n + s.size, 0) });
				}
			}
			name = prefix;
		}
	}
	walk(0, paths.length, '', 0);
	return entries;
}

class Warcraft3Storage {
	constructor(directory) {
		this.directory = directory;
		this.files = new Map();
		this.index = new Map();
		this.warnings = [];
	}
	async open(progress = () => {}) {
		this.files.clear(); this.index.clear(); this.warnings = [];
		const info = (await fs.readFile(path.join(this.directory, '.build.info'), 'utf8')).trim().split(/\r?\n/);
		const columns = info.shift().split('|').map(s => s.split('!')[0]);
		const builds = info.map(line => Object.fromEntries(line.split('|').map((v, i) => [columns[i], v])));
		this.build = builds.find(b => b.Product === 'w3' && b.Active === '1');
		if (!this.build) throw new Error('Select the Warcraft III folder containing .build.info (an active w3 build is required).');
		const key = this.build['Build Key'];
		if (!/^[a-f0-9]{32}$/i.test(key)) throw new Error('Invalid WC3 build key');
		const configText = await fs.readFile(path.join(this.directory, 'Data', 'config', key.slice(0, 2), key.slice(2, 4), key), 'utf8');
		const config = Object.fromEntries(configText.split(/\r?\n/).filter(s => s.includes(' = ')).map(s => s.split(' = ')));
		const rootKey = config['vfs-root']?.split(' ')[1];
		if (!rootKey) throw new Error('WC3 build has no TVFS root');
		const manifests = new Set(Object.entries(config).filter(([k]) => /^vfs-\d+$/.test(k)).map(([, v]) => v.split(' ')[1].slice(0, 18)));
		progress('Reading local archive indexes');
		const dataDir = path.join(this.directory, 'Data', 'data');
		const indexes = (await fs.readdir(dataDir)).filter(n => /^[a-f0-9]{10}\.idx$/i.test(n)).sort().reverse();
		// Only the latest journal for each bucket is authoritative.
		const buckets = new Set();
		for (const filename of indexes) {
			if (buckets.has(filename.slice(0, 2))) continue;
			buckets.add(filename.slice(0, 2));
			const b = await fs.readFile(path.join(dataDir, filename));
			const hSize = b.readUInt32LE(0);
			if (b.readUInt16LE(8) !== 7 || b[12] !== 4 || b[13] !== 5 || b[14] !== 9 || b[15] !== 30)
				throw new Error('Unsupported CASC index layout: ' + filename);
			const start = (8 + hSize + 15) & ~15;
			const length = range(b, start, 8).readUInt32LE(0);
			if (length % 18) throw new Error('Invalid CASC index size');
			range(b, start + 8, length);
			for (let p = start + 8; p < start + 8 + length; p += 18) {
				const location = b.readUIntBE(p + 9, 5);
				this.index.set(b.toString('hex', p, p + 9), { archive: Math.floor(location / 0x40000000), offset: location % 0x40000000, size: b.readUInt32LE(p + 14) });
			}
		}
		const visit = async (ekey, prefix, ancestors) => {
			if (ancestors.has(ekey.slice(0, 18)) || ancestors.size > 32) throw new Error('Cyclic TVFS manifest');
			const chain = new Set(ancestors).add(ekey.slice(0, 18));
			progress('Reading ' + (prefix || 'Warcraft III file catalogue'));
			const entries = parseTVFS(await this.readKey(ekey));
			for (const entry of entries) {
				entry.name = normalize(prefix + entry.name);
				if (entry.spans.length === 1 && manifests.has(entry.spans[0].key.slice(0, 18))) {
					if (!this.index.has(entry.spans[0].key.slice(0, 18))) {
						this.warnings.push('Not installed: ' + entry.name); continue;
					}
					await visit(entry.spans[0].key, entry.name + '/', chain);
				} else {
					entry.available = entry.spans.every(s => this.index.has(s.key.slice(0, 18)));
					this.files.set(entry.name, entry);
				}
			}
		};
		await visit(rootKey, '', new Set());
		return this;
	}
	async readKey(key) {
		const entry = this.index.get(key.slice(0, 18));
		if (!entry) throw new Error('File is not installed locally. Complete or repair the Warcraft III installation in Battle.net.');
		if (entry.size < 38 || entry.size > MAX_FILE_SIZE) throw new Error('Invalid or oversized CASC entry');
		const file = await fs.open(path.join(this.directory, 'Data', 'data', 'data.' + String(entry.archive).padStart(3, '0')), 'r');
		try {
			const buffer = Buffer.alloc(entry.size - 30);
			let read = 0;
			while (read < buffer.length) {
				const { bytesRead } = await file.read(buffer, read, buffer.length - read, entry.offset + 30 + read);
				if (!bytesRead) throw new Error('Truncated local CASC archive');
				read += bytesRead;
			}
			return decodeBLTE(buffer, key);
		} finally { await file.close(); }
	}
	async readFile(name) {
		const entry = this.files.get(normalize(name));
		if (!entry) throw new Error('WC3 file not found: ' + name);
		if (entry.size > MAX_FILE_SIZE) throw new Error('File exceeds the 512 MiB in-memory export limit');
		const parts = [];
		for (const span of entry.spans) parts.push(range(await this.readKey(span.key), span.offset, span.size));
		return Buffer.concat(parts);
	}
	resolveTexture(reference, modelPath) {
		const ref = normalize(reference).replace(/^\/+/, '');
		const base = ref.replace(/\.(tif|tga|blp|dds)$/i, '');
		const variants = [...new Set([ref, base + '.dds', base + '.blp', base + '.tga'])];
		const model = normalize(modelPath);
		const modEnd = model.lastIndexOf('.w3mod/');
		const prefixes = [];
		if (modEnd >= 0) prefixes.push(model.slice(0, modEnd + 7));
		if (model.includes('/_hd.w3mod/')) prefixes.push('war3.w3mod/_hd.w3mod/');
		if (model.includes('/_de.w3mod/')) prefixes.push('war3.w3mod/_de.w3mod/');
		prefixes.push('war3.w3mod/', '', model.slice(0, model.lastIndexOf('/') + 1));
		for (const prefix of [...new Set(prefixes)]) for (const name of variants) {
			const candidate = prefix + name;
			if (this.files.has(candidate)) return candidate;
		}
		return null;
	}
}

module.exports = { Warcraft3Storage, parseTVFS, decodeBLTE, normalize };
