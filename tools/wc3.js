#!/usr/bin/env node
// Shares the app's WC3 backend; useful for headless extraction and diagnostics.
const { Warcraft3Storage } = require('../src/js/warcraft3/storage');
const { exportRaw, createGLB, writeOutput } = require('../src/js/warcraft3/exporter');
const { decodeTexture, png } = require('../src/js/warcraft3/textures');

async function main() {
	const [command, install, query, output] = process.argv.slice(2);
	if (!['list', 'raw', 'glb', 'png'].includes(command) || !install || (command !== 'list' && (!query || !output))) {
		console.log('Usage: node tools/wc3.js list <install> [search]\n       node tools/wc3.js <raw|glb|png> <install> <asset-path> <output-folder>');
		process.exitCode = 1; return;
	}
	const storage = await new Warcraft3Storage(install).open();
	if (command === 'list') {
		for (const name of storage.files.keys()) if (!query || name.includes(query.toLowerCase())) console.log(name);
		return;
	}
	if (command === 'raw') console.log(JSON.stringify(await exportRaw(storage, query, output), null, 2));
	if (command === 'glb') {
		const result = await createGLB(storage, query);
		console.log(await writeOutput(output, query.replace(/\.mdx$/i, '.glb'), result.data));
		for (const warning of result.warnings) console.warn(warning);
	}
	if (command === 'png') console.log(await writeOutput(output, query + '.png', png(decodeTexture(await storage.readFile(query)))));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
