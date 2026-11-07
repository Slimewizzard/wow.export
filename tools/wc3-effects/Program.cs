// wow.export WC3 effect baker. Upstream simulation is MIT licensed; see vendor/LICENSE.
using System.Numerics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Wc3ModelViewer.Core.Formats;
using Wc3ModelViewer.Core.Formats.Popcorn;

try {
    if (args.Length != 2) throw new ArgumentException("Usage: wc3-effects <request.json> <output-directory>");
    if (new FileInfo(args[0]).Length > 32 * 1024 * 1024) throw new InvalidDataException("Effect request exceeds 32 MiB.");
    var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    var input = JsonSerializer.Deserialize<Request>(File.ReadAllText(args[0]), json) ?? throw new InvalidDataException("Empty request.");
    if (input.Fps is < 1 or > 60 || !float.IsFinite(input.Seconds) || input.Seconds is < 0.1f or > 30 || input.Emitters.Length is < 1 or > 128)
        throw new InvalidDataException("Bake limits: 1–60 fps, 0.1–30 seconds, 1–128 emitters.");
    int frames = (int)Math.Ceiling(input.Seconds * input.Fps) + 1;
    var warnings = new HashSet<string> { "Experimental simulation: turbulence is approximate; scene collisions and game target positions are not reproduced." };
    var emitters = new List<Emitter>();
    var batches = new List<Batch>();
    var dependencies = new List<object>();
    foreach (var source in input.Emitters) {
        var bytes = Convert.FromBase64String(source.Data);
        if (bytes.Length > 8 * 1024 * 1024) throw new InvalidDataException("Compiled effect exceeds 8 MiB.");
        var bake = PkBakeFile.Load(bytes);
        dependencies.Add(new { source = source.Source, references = bake.Strings.Where(s => Regex.IsMatch(s, @"\.(dds|tif|tga|blp|png|pkmm|pkcf|pkat|pkma|fbx)$", RegexOptions.IgnoreCase)).Distinct().ToArray() });
        var def = PkEffectDef.Load(bytes);
        foreach (var warning in def.Warnings) warnings.Add(source.Name + ": " + warning);
        var emitter = new Emitter(source, def); emitters.Add(emitter);
        foreach (var layer in def.Layers) foreach (var renderer in layer.Renderers) {
            var batch = new Batch { Id = batches.Count, Emitter = source.Name, Source = source.Source, Layer = layer.Name, Renderer = renderer };
            batches.Add(batch); emitter.Batches.Add(batch);
            if (renderer.Kind != PkRendererKind.Billboard) warnings.Add(source.Name + ": " + renderer.Kind + " renderer is not converted in this prototype.");
        }
    }
    Directory.CreateDirectory(args[1]);
    var offsets = new List<long>(); long totalSprites = 0;
    using (var stream = File.Create(Path.Combine(args[1], "frames.bin")))
    using (var writer = new BinaryWriter(stream)) {
        writer.Write(new byte[] { 87, 51, 70, 88 }); writer.Write(1);
        for (int frame = 0; frame < frames; frame++) {
            // Two simulation steps per output frame preserve burst timing without changing the cache FPS.
            for (int sub = frame == 0 ? 0 : 1; sub <= (frame == 0 ? 0 : 2); sub++) {
                int step = frame == 0 ? 0 : (frame - 1) * 2 + sub;
                foreach (var emitter in emitters) emitter.Step(step, frame == 0 ? 0 : 1f / (input.Fps * 2), input.TeamColor);
            }
            offsets.Add(stream.Position);
            int frameParticles = 0;
            foreach (var batch in batches) {
                var sprites = new List<float[]>();
                var emitter = emitters.First(e => e.Batches.Contains(batch));
                if (batch.Renderer.Kind == PkRendererKind.Billboard)
                    foreach (var instance in emitter.Instances) Collect(instance, batch.Renderer, sprites);
                frameParticles += sprites.Count;
                if (frameParticles > 20000) throw new InvalidDataException("Effect exceeds 20,000 visible particles per frame.");
                batch.MaxParticles = Math.Max(batch.MaxParticles, sprites.Count);
                if (batches.Sum(b => b.MaxParticles) > 20000) throw new InvalidDataException("Effect exceeds 20,000 allocated sprite slots; reduce duration.");
                totalSprites += sprites.Count;
                writer.Write(sprites.Count);
                foreach (var sprite in sprites) foreach (float value in sprite) writer.Write(value);
            }
            if (stream.Position > 128 * 1024 * 1024) throw new InvalidDataException("Effect cache exceeds 128 MiB; reduce duration or FPS.");
        }
    }
    foreach (var emitter in emitters) foreach (var message in emitter.Unsupported) warnings.Add(emitter.Source.Name + ": " + message);
    var metadata = new { schema = "wow.export.wc3fx.v1", fps = input.Fps, frameCount = frames, seconds = (frames - 1f) / input.Fps, frameOffsets = offsets, stride = 17, unitsPerMetre = 50, totalSprites,
        batches = batches.Select(b => new { b.Id, b.Emitter, b.Source, b.Layer, b.MaxParticles, kind = b.Renderer.Kind.ToString(), b.Renderer.Texture, billboard = (int)b.Renderer.Billboard, blend = (int)b.Renderer.Blend, b.Renderer.AtlasColumns, b.Renderer.AtlasRows, b.Renderer.FlipUVs }), dependencies, warnings };
    File.WriteAllText(Path.Combine(args[1], "bake.json"), JsonSerializer.Serialize(metadata, json));
    Console.WriteLine($"Baked {frames} frames, {totalSprites} sprite samples.");
} catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
return 0;

static void Collect(PkEffectInstance instance, PkRendererDef r, List<float[]> result) {
    foreach (var st in instance.Slots) {
        if (st is null || !st.Def.Renderers.Contains(r)) continue;
        int pos = r.Input("Position"), size = r.Input("Size"), size2 = r.Input("Size2"), axis = r.Input("Axis"), normal = r.Input("NormalAxis"), rotation = r.Input("Rotation"), color = r.Input("Color"), enabled = r.Input("Enabled"), texture = r.Input("TextureID");
        for (int p = 0; p < st.Count; p++) {
            if (enabled >= 0 && st.Fields[enabled][p].I0 == 0) continue;
            var c = color >= 0 ? st.Fields[color][p].Xyzw : Vector4.One;
            if (r.Blend != PopcornBlend.AdditiveNoAlpha && c.W <= 0.002f) continue;
            var s = r.Size2D && size2 >= 0 ? new Vector2(st.Fields[size2][p].X, st.Fields[size2][p].Y) : new Vector2(size >= 0 ? st.Fields[size][p].X : 1);
            if (s.X <= 0 && s.Y <= 0) continue;
            var v = (pos >= 0 ? st.Fields[pos][p].Xyz : Vector3.Zero) * 50;
            var a = (axis >= 0 ? st.Fields[axis][p].Xyz : Vector3.UnitZ) * 50;
            var n = normal >= 0 ? st.Fields[normal][p].Xyz : Vector3.UnitZ;
            float[] record = [v.X, v.Y, v.Z, s.X * 50, s.Y * 50, a.X, a.Y, a.Z, n.X, n.Y, n.Z,
                rotation >= 0 ? float.DegreesToRadians(st.Fields[rotation][p].X) : 0, c.X, c.Y, c.Z, c.W,
                texture >= 0 ? MathF.Max(0, st.Fields[texture][p].X) : 0];
            if (record.All(float.IsFinite)) result.Add(record);
        }
    }
}

sealed class Request { public int Fps { get; set; } = 30; public float Seconds { get; set; } = 3; public float[] TeamColor { get; set; } = [1, 0, 0]; public EmitterSource[] Emitters { get; set; } = []; }
sealed class EmitterSource { public string Name { get; set; } = "Effect"; public string Source { get; set; } = ""; public string Data { get; set; } = ""; public State[] States { get; set; } = []; }
sealed class State { public float[] Matrix { get; set; } = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; public float[] Color { get; set; } = [1, 1, 1, 1]; public float Rate { get; set; } = 1; public bool On { get; set; } = true; public bool Restart { get; set; } }
sealed class Batch { public int Id { get; set; } public string Emitter { get; set; } = ""; public string Source { get; set; } = ""; public string Layer { get; set; } = ""; public int MaxParticles { get; set; } public required PkRendererDef Renderer { get; init; } }
sealed class Emitter(EmitterSource source, PkEffectDef definition) {
    public EmitterSource Source { get; } = source;
    public List<Batch> Batches { get; } = [];
    public List<PkEffectInstance> Instances { get; } = [];
    public HashSet<string> Unsupported { get; } = [];
    private bool wasOn;
    private int seed = 42;
    public void Step(int step, float dt, float[] team) {
        var state = Source.States.Length == 0 ? new State() : Source.States[Math.Min(step, Source.States.Length - 1)];
        bool stillEmitting = Instances.Any(fx => fx.Slots.Skip(1).Any(s => s is { Count: > 0 } && s.Def.Renderers.Count == 0));
        if (state.On && (!wasOn || (state.Restart && !stillEmitting))) Instances.Add(new PkEffectInstance(definition, new PkEnvironment(), seed++));
        wasOn = state.On;
        if (Instances.Count > 32) throw new InvalidDataException("Too many overlapping effect instances.");
        var m = state.Matrix;
        if (m.Length != 16 || state.Color.Length != 4 || team.Length != 3 || !m.All(float.IsFinite) || !state.Color.All(float.IsFinite)) throw new InvalidDataException("Invalid emitter state.");
        for (int i = Instances.Count - 1; i >= 0; i--) {
            var fx = Instances[i];
            fx.Env.LocalToWorld = new Matrix4x4(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);
            fx.Env.ColorMultiplier = new Vector4(state.Color[0], state.Color[1], state.Color[2], state.Color[3]);
            fx.Env.TeamColor = new Vector4(team[0], team[1], team[2], 1);
            fx.Env.EmissionRateMultiplier = state.Rate;
            fx.Env.Running = state.On && i == Instances.Count - 1;
            fx.Update(dt);
            foreach (var message in fx.Unsupported) Unsupported.Add(message);
            if (!fx.IsAlive) Instances.RemoveAt(i);
        }
    }
}
