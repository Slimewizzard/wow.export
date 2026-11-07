# Experimental M2 effects

Enable **Export M2 Effects (Experimental)** in wow.export settings for OBJ exports. Keep textures enabled. This creates a `.effects.json` next to the OBJ and its usual metadata. In Blender's WoW OBJ importer, enable **Import M2 Effects (Experimental)**. Both options default off.

For existing OBJ exports and matching raw models, run:

    node tools/export-m2-effects.cjs model.m2 model.json

This command refuses to overwrite an existing effects sidecar. The decoder currently accepts modern MD21 version 274. It preserves effect extension chunks and uninterpreted particle records for later work.

The preview creates parented lights and bounded, looping sprites (maximum 24 per emitter). It uses initial emission rate/speed, particle lifetime color/alpha/size curves and a single texture layer. Point-light power is adjustable on the effects parent under Custom Properties. Review notes are stored on the parent and emitters.

This is not an exact WoW renderer. Bone animation, lighting attenuation, engine blend equations, sprite billboarding, atlas animation, multitexturing, drag and turbulence are not reproduced. Lights use initial color/intensity, not flicker tracks. Ribbons produce attachment markers only; trails require motion history. External animation data is not decoded. Materials, power and particle orientation may need adjustment. Import errors are surfaced rather than silently treating unsupported data as successful.

Validated raw samples: Old Salt's Fireplace has 1 light, 3 particle emitters and no ribbons; Sturdy Fireplace has 2 lights, 4 particle emitters and no ribbons. No ribbon sample has been validated.

The current prototype exports bone tracks and applies their initial pose to particles. Sphere emitters use an experimental surface/cone interpretation, validated for Old Salt's spawn height (approximately 0.63 units) and upward motion. Blend-7 particles have an approximate premultiplied shader with two scrolling modulation layers and luminance-based coverage. This is not a verified copy of the game shader. Each emitter has a Size multiplier, default 1; the live Old Salt test uses 12 as artistic tuning. Animated bone evaluation and accurate emission scheduling remain unsupported.
