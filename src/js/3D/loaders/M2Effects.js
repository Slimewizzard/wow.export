// Modern MD21 effect records. Layout reference:
// https://github.com/skarndev/wowlib/blob/main/src/wowlib/formats/m2/root/record/effects.hpp
function decodeEffects(raw) {
    let body, chunks = [], pos = 0;
    while (pos + 8 <= raw.length) {
        const tag = raw.toString('ascii', pos, pos + 4), size = raw.readUInt32LE(pos + 4);
        if (pos + 8 + size > raw.length) throw new Error('Truncated M2 chunk');
        if (tag === 'MD21') body = raw.subarray(pos + 8, pos + 8 + size);
        else chunks.push({tag, bytes:size, data:raw.subarray(pos + 8,pos + 8 + size).toString('base64')});
        pos += 8 + size;
    }
    if (!body || body.toString('ascii',0,4) !== 'MD20') throw new Error('Missing MD21 model');
    function bounds(p,n) {if (!Number.isSafeInteger(p) || p<0 || n<0 || p+n>body.length) throw new Error('Invalid effect offset');}
    function u32(p) {bounds(p,4);return body.readUInt32LE(p);}
    function f32(p) {bounds(p,4);const v=body.readFloatLE(p);if(!Number.isFinite(v))throw new Error('Nonfinite effect value');return v;}
    function u16(p) {bounds(p,2);return body.readUInt16LE(p);}
    function value(p,type) {
        if(type==='quat')return [0,2,4,6].map(o=>(u16(p+o)-32767)/32768);
        if(type==='vec3')return [f32(p),f32(p+4),f32(p+8)];
        if(type==='vec2')return [f32(p),f32(p+4)];
        if(type==='float')return f32(p);
        if(type==='byte'){bounds(p,1);return body[p];}
        return type==='short'?body.readInt16LE(p):u16(p);
    }
    const sizes={quat:8,vec3:12,vec2:8,float:4,byte:1,short:2,uint16:2,uint32:4};
    function array(p,type) {
        const count=u32(p),offset=u32(p+4),size=sizes[type];
        if(count>100000)throw new Error('Effect array exceeds limit');bounds(offset,count*size);
        return Array.from({length:count},(_,i)=>type==='uint32'?u32(offset+i*size):value(offset+i*size,type));
    }
    const version=u32(4);
    if(version!==274)throw new Error('Effects decoder currently supports M2 version 274 only');
    const warnings=[];
    const seqCount=u32(28),seqOffset=u32(32);
    bounds(seqOffset,seqCount*64);
    function track(p,type) {
        const interpolation=u16(p),globalSequence=u16(p+2);
        const tc=u32(p+4),to=u32(p+8),vc=u32(p+12),vo=u32(p+16);
        if(tc!==vc || tc>10000)throw new Error('Invalid effect track');
        bounds(to,tc*8);bounds(vo,vc*8);
        const timelines=[];
        for(let i=0;i<tc;i++) {
            if(globalSequence===65535 && i<seqCount && !(u32(seqOffset+i*64+12)&0x20)) {
                timelines.push({external:true});continue;
            }
            timelines.push({times:array(to+i*8,'uint32'),values:array(vo+i*8,type)});
        }
        return {interpolation,globalSequence,timelines};
    }
    function ramp(p,type) {return {times:array(p,'uint16').map(t=>t/32767),values:array(p+8,type)};}
    function records(header,stride,read) {
        const count=u32(header),offset=u32(header+4);
        if(count>4096)throw new Error('Too many emitters');bounds(offset,count*stride);
        return Array.from({length:count},(_,i)=>read(offset+i*stride,i));
    }
    const bones=records(44,88,(p,id)=>({id,parent:body.readInt16LE(p+8),pivot:value(p+76,'vec3'),
        translation:track(p+16,'vec3'),rotation:track(p+36,'quat'),scale:track(p+56,'vec3')}));
    const lights=records(0x108,156,(p,id)=>{
        const out={id,type:u16(p),bone:body.readInt16LE(p+2),position:value(p+4,'vec3')};
        for(const [i,name] of ['ambientColor','ambientIntensity','diffuseColor','diffuseIntensity','attenuationStart','attenuationEnd','visibility'].entries())
            out[name]=track(p+16+i*20,name.endsWith('Color')?'vec3':name==='visibility'?'byte':'float');
        return out;
    });
    const ribbons=records(0x120,176,(p,id)=>({id,bone:u32(p+4),position:value(p+8,'vec3'),textures:array(p+20,'uint16'),materials:array(p+28,'uint16'),
        color:track(p+36,'vec3'),alpha:track(p+56,'short'),heightAbove:track(p+76,'float'),heightBelow:track(p+96,'float'),
        edgesPerSecond:f32(p+116),lifetime:f32(p+120),gravity:f32(p+124),rows:u16(p+128),columns:u16(p+130),visibility:track(p+152,'byte')}));
    const particles=records(0x128,492,(p,id)=>{
        const out={id,flags:u32(p+4),position:value(p+8,'vec3'),bone:u16(p+20),texture:u16(p+22),blend:body[p+40],emitterType:body[p+41],colorIndex:u16(p+42),rows:u16(p+48),columns:u16(p+50)};
        let q=p+52;
        for(const name of ['speed','speedVariation','verticalRange','horizontalRange','gravity','lifespan']) {out[name]=track(q,'float');q+=20;}
        out.lifespanVariation=f32(q);q+=4;out.rate=track(q,'float');q+=20;out.rateVariation=f32(q);q+=4;
        for(const name of ['width','length','zSource']) {out[name]=track(q,'float');q+=20;}
        out.color=ramp(q,'vec3');q+=16;out.alpha=ramp(q,'short');q+=16;out.scale=ramp(q,'vec2');q+=16;
        out.scaleVariation=value(q,'vec2');q+=8;out.headUV=ramp(q,'uint16');q+=16;out.tailUV=ramp(q,'uint16');
        out.enabled=track(p+456,'byte');
        // Preserve fields not yet interpreted, including packed multitexture parameters.
        out.rawRecord=body.subarray(p,p+492).toString('base64');
        return out;
    });
    warnings.push('Experimental reconstruction: bone animation, particle extensions, multitexturing and engine lighting need review.');
    return {schema:'wow.export.effects.v1',version,coordinateSystem:'M2 model-local XYZ',globalSequences:array(20,'uint32'),bones,lights,ribbons,particles,
        extensionChunks:chunks.filter(c=>['EXP2','PGD1','LDV1','DETL','TEXL','PCOL','DPIV'].includes(c.tag)),warnings};
}
module.exports={decodeEffects};
