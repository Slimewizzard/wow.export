const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

async function bundleOBJ(file) {
    const folder=path.dirname(file), stem=file.slice(0,-4), assets=new Set([path.basename(file)]);
    async function texture(ref) {
        const source=path.resolve(folder,ref.replaceAll('\\','/'));
        const bytes=await fs.readFile(source);
        const name='textures/'+crypto.createHash('sha256').update(bytes).digest('hex')+path.extname(source).toLowerCase();
        await fs.mkdir(path.join(folder,'textures'),{recursive:true});
        await fs.writeFile(path.join(folder,name),bytes);assets.add(name);return name;
    }
    const mtl=stem+'.mtl';
    const lines=(await fs.readFile(mtl,'utf8')).split(/\r?\n/);
    for(let i=0;i<lines.length;i++) {
        const match=lines[i].match(/^(map_\w+|bump)\s+(.+)$/);
        if(match) lines[i]=match[1]+' '+await texture(match[2]);
    }
    await fs.writeFile(mtl,lines.join('\n'));assets.add(path.basename(mtl));
    for(const suffix of ['.json','.effects.json']) {
        const metaFile=stem+suffix;
        let text;
        try {text=await fs.readFile(metaFile,'utf8');} catch(e) {if(e.code==='ENOENT')continue;throw e;}
        const meta=JSON.parse(text);
        for(const tex of meta.textures||[]) if(tex.fileNameExternal) tex.fileNameExternal=await texture(tex.fileNameExternal);
        await fs.writeFile(metaFile,JSON.stringify(meta,null,2));assets.add(path.basename(metaFile));
    }
    return [...assets];
}
module.exports={bundleOBJ};
