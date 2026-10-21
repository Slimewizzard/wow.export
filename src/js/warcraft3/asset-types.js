const fs = require('fs').promises;
const path = require('path');

const MESH = 1, POPCORN = 2, CLASSIC_EFFECT = 4;

// Read chunk headers only: classifying a model must not build its mesh or animation data.
function inspectModelType(data) {
	if (data.toString('ascii', 0, 4) !== 'MDLX') throw new Error('Invalid MDX signature');
	let flags = 0;
	for (let offset = 4; offset < data.length;) {
		if (offset + 8 > data.length) throw new Error('Truncated MDX chunk header');
		const tag = data.toString('ascii', offset, offset + 4), size = data.readUInt32LE(offset + 4);
		offset += 8;
		if (offset + size > data.length) throw new Error('Truncated MDX chunk');
		if (size) {
			if (tag === 'GEOS') flags |= MESH;
			if (tag === 'CORN') flags |= POPCORN;
			if (['PREM', 'PRE2', 'RIBB'].includes(tag)) flags |= CLASSIC_EFFECT;
		}
		offset += size;
	}
	return flags;
}

function matchesKind(name, kind, types) {
	if (kind === 'all') return true;
	if (kind === 'textures') return /\.(blp|dds)$/i.test(name);
	if (kind === 'audio') return /\.(wav|mp3|ogg|flac)$/i.test(name);
	if (kind === 'popcorn') return /\.(pkb|pkfx)$/i.test(name) || (/\.mdx$/i.test(name) && !!(types.get(name) & POPCORN));
	// Keep unknown/unavailable files and classic effects discoverable under Models.
	return kind === 'models' && /\.mdx$/i.test(name) && types.get(name) !== POPCORN;
}

async function indexModelTypes(storage, cacheFile, progress = () => {}, cancelled = () => false) {
	const entries = [...storage.files].filter(([name]) => /\.mdx$/i.test(name));
	let cached = {};
	if (cacheFile) try {
		const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
		if (saved.version === 1 && saved.types && typeof saved.types === 'object') cached = saved.types;
	} catch { /* Missing or corrupt cache: inspect the installation again. */ }
	const types = new Map(), contentTypes = new Map();
	let done = 0, unknown = 0, lastProgress = 0;
	progress({ done, total: entries.length, unknown });
	for (const [name, entry] of entries) {
		if (cancelled()) break;
		// Encoded content keys and span ranges change when an asset changes, even within a build.
		const key = entry.spans.map(s => s.key + ':' + s.offset + ':' + s.size).join('|');
		let flags = contentTypes.get(key) ?? cached[key];
		if (!Number.isInteger(flags) || flags < 0 || flags > 7) {
			try { if (entry.available === false) throw new Error('Not installed'); flags = inspectModelType(await storage.readFile(name)); }
			catch { flags = undefined; }
		}
		if (flags !== undefined) { types.set(name, flags); contentTypes.set(key, flags); }
		else unknown++;
		done++;
		if (Date.now() - lastProgress >= 1000) {
			progress({ done, total: entries.length, unknown }); lastProgress = Date.now();
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}
	let cacheError = '';
	if (cacheFile && !cancelled()) {
		const temporary = cacheFile + '.' + process.pid + '.' + require('crypto').randomBytes(4).toString('hex') + '.tmp';
		try {
			await fs.mkdir(path.dirname(cacheFile), { recursive: true });
			await fs.writeFile(temporary, JSON.stringify({ version: 1, types: Object.fromEntries(contentTypes) }));
			await fs.rename(temporary, cacheFile);
		} catch (e) { cacheError = e.message; }
		finally { await fs.unlink(temporary).catch(() => {}); }
	}
	progress({ done, total: entries.length, unknown });
	return { types, unknown, cacheError };
}

module.exports = { inspectModelType, matchesKind, indexModelTypes, MESH, POPCORN, CLASSIC_EFFECT };
