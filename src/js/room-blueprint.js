// Data-only bridge: never execute SavedVariables as Lua or JavaScript.
const values = value => value && typeof value === 'object' ? Object.values(value) : [];

function parseSavedVariables(text) {
    let i = 0, nodes = 0;
    const fail = () => { throw new Error(`Invalid SavedVariables data near character ${i}`); };
    const ws = () => { while (i < text.length) {
        if (/\s/.test(text[i])) { i++; continue; }
        if (text.startsWith('--', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
        break;
    }};
    const take = c => { ws(); if (text[i++] !== c) fail(); };
    function read(depth = 0) {
        ws();
        if (++nodes > 300000 || depth > 32) throw new Error('SavedVariables exceeds data limits');
        const c = text[i];
        if (c === '"' || c === "'") {
            i++; let out = '';
            while (i < text.length) {
                let ch = text[i++];
                if (ch === c) return out;
                if (ch === '\\') {
                    ch = text[i++];
                    if (/\d/.test(ch)) {
                        let digits = ch;
                        while (digits.length < 3 && /\d/.test(text[i] || 'x')) digits += text[i++];
                        const code = Number(digits); if (code > 255) fail();
                        out += String.fromCharCode(code);
                    } else {
                        const escapes = {n:'\n', r:'\r', t:'\t', a:'\x07', b:'\b', f:'\f', v:'\v', '\\':'\\', '"':'"', "'":"'", '\n':'\n'};
                        if (!(ch in escapes)) fail();
                        out += escapes[ch];
                    }
                } else out += ch;
            }
            fail();
        }
        if (c === '{') {
            i++; const result = Object.create(null); let index = 1;
            ws();
            while (text[i] !== '}') {
                let key;
                if (text[i] === '[') { i++; key = read(depth + 1); take(']'); take('='); }
                else key = index++;
                if (typeof key !== 'string' && typeof key !== 'number') fail();
                result[String(key)] = read(depth + 1);
                ws();
                if (text[i] === ',' || text[i] === ';') { i++; ws(); }
                else if (text[i] !== '}') fail();
            }
            i++; return result;
        }
        const token = text.slice(i).match(/^(true|false|nil|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
        if (!token) fail();
        i += token.length;
        if (token === 'true') return true;
        if (token === 'false') return false;
        if (token === 'nil') return null;
        const number = Number(token); if (!Number.isFinite(number)) fail();
        return number;
    }
    ws();
    if (!text.startsWith('RoomProbeDB', i)) fail();
    i += 'RoomProbeDB'.length; take('=');
    const data = read(); ws(); if (text[i] === ';') {i++; ws();}
    if (i !== text.length) fail();
    return data;
}

function normalizeContents(content, label, time) {
    if (!content || typeof content !== 'object' || !content.contentGroups) throw new Error('Blueprint response has no contentGroups');
    const items = new Map(), otherGroups = [];
    for (const group of values(content.contentGroups)) {
        if (Number(group.contentType) !== 3) { otherGroups.push(group); continue; }
        for (const entry of values(group.entries)) {
            const decorID = Number(entry.recordID), count = Number(entry.total);
            if (!Number.isSafeInteger(decorID) || decorID <= 0 || !Number.isSafeInteger(count) || count < 1 || count > 10000)
                throw new Error('Unrecognized decor ID/count in blueprint; inspect raw capture before exporting');
            let item = items.get(decorID);
            if (!item) { item = {decorID, name: String(entry.name || `Decor ${decorID}`), count: 0, variants: []}; items.set(decorID, item); }
            item.count += count;
            item.variants.push(entry); // Retain dyes and missing counts, but never subtract missing inventory.
        }
    }
    if (!items.size) throw new Error('Blueprint contains no decor entries');
    if ([...items.values()].reduce((sum, item) => sum + item.count, 0) > 10000) throw new Error('Blueprint exceeds 10,000 instances');
    return {schema: 'room-building.inventory.v1', label: label || 'Room blueprint', time,
        shareCode: content.shareCode, items: [...items.values()], otherGroups};
}

function readBlueprints(text) {
    if (text.length > 20 * 1024 * 1024) throw new Error('Input exceeds 20 MB');
    text = text.replace(/^\uFEFF/, '').trim();
    const data = text.startsWith('{') ? JSON.parse(text) : parseSavedVariables(text);
    if (data.rooms !== undefined) {
        const rooms = values(data.rooms).map(room => {
            const inventory = normalizeContents(room.content, room.name, room.updated);
            for (const item of inventory.items) item.dyeCaptures = values(room.dyeCaptures).filter(c => Number(c.decorID) === item.decorID);
            return {...inventory, id: String(room.id)};
        });
        if (!rooms.length) throw new Error('No saved rooms. Record a blueprint in /roomprobe, Stop & Save, then /reload.');
        return rooms;
    }
    const captures = values(data.blueprints).filter(c => c.event === 'HOUSING_BLUEPRINT_CONTENTS_RECEIVED');
    const results = captures.map(c => normalizeContents(c.args?.['1'], c.label, c.time));
    if (!results.length) throw new Error('No captured blueprint contents. Use /roomprobe blueprint, reopen the preview, then /reload.');
    return results;
}

function resolveInventory(inventory, lookup) {
    return inventory.items.map(item => {
        const decor = lookup(item.decorID);
        return {...item, modelFileDataID: decor?.modelFileDataID || null,
            modelName: decor?.name || item.name, status: decor?.modelFileDataID ? 'ready' : 'unresolved'};
    });
}
module.exports = {parseSavedVariables, readBlueprints, normalizeContents, resolveInventory};
