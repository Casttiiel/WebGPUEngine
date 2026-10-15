var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { M as u, R as x, E as B, T as l, G as h, a as b, B as f, P as p, __tla as __tla_0 } from "./index-CnZpZoZ4.js";
let m;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  const g = {
    txAlbedo: "albedo",
    txNormal: "normal",
    txMetallic: "metallic",
    txRoughness: "roughness",
    txEmissive: "emissive"
  };
  m = class extends u {
    constructor(t, e) {
      super({
        path: e,
        type: x.MATERIAL,
        technique: t.getTechnique(),
        category: t.getCategory(),
        castsShadows: t.getCastsShadows(),
        shadows: t.getShadows()
      });
      __publicField(this, "instanceParent");
      this.instanceParent = t;
    }
    static async from(t, e = {}, i) {
      const n = i ?? `${t.getName()}__instance_${B.generateDynamicId()}`, r = new m(t, n);
      return await r.initFromParent(t, e), r;
    }
    async load() {
    }
    async initFromParent(t, e) {
      var _a;
      this.baseColorFactor = e.baseColorFactor ? [
        ...e.baseColorFactor
      ] : [
        ...t.getBaseColorFactor()
      ], this.roughnessFactor = e.roughnessFactor ?? t.getRoughnessFactor(), this.metallicFactor = e.metallicFactor ?? t.getMetallicFactor(), this.emissiveFactor = e.emissiveFactor ?? t.getEmissiveFactor(), this.uvXScale = e.uvXScale ?? t.getUvXScale(), this.uvYScale = e.uvYScale ?? t.getUvYScale(), this.appearanceBlend = e.appearanceBlend ?? t.getAppearanceBlend(), this.surfaceBlend = e.surfaceBlend ?? t.getSurfaceBlend(), this.pomScale = e.pomScale ?? t.getPomScale(), t.getCastsShadows() && (this.shadowsMaterial = t.getShadowsMaterial());
      const i = (_a = t.getTechnique()) == null ? void 0 : _a.getMaterialSlots();
      i ? await this.initCustomSlot(t, e, i) : await this.initPBR(t, e);
    }
    async initCustomSlot(t, e, i) {
      var _a;
      const n = u.extractMaterialState(t);
      this.customSlotTextures = new Map(n.customSlotTextures), this.rawTextures = {
        ...n.rawTextures
      }, e.textures && await Promise.all(Object.entries(e.textures).map(async ([s, a]) => {
        var _a2;
        const c = ((_a2 = i.find((d) => d.name === s)) == null ? void 0 : _a2.srgb) ?? false, o = await l.getAsync(a, false, c);
        this.customSlotTextures.set(s, o), this.rawTextures[s] = a, this.textureViewUnsubs.push(o.addViewListener(() => this.tryBuildCustomBindGroup(i)));
      }));
      for (const [s, a] of n.customSlotTextures) ((_a = e.textures) == null ? void 0 : _a[s]) || this.textureViewUnsubs.push(a.addViewListener(() => this.tryBuildCustomBindGroup(i)));
      this.customUniformBuffer = h.createBuffer(`${this.path}_ub`, 48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), this.writeFactorsToGPU();
      const r = () => this.tryBuildCustomBindGroup(i);
      for (const s of i) {
        if (s.type === "sampler" || s.type === "uniform") continue;
        const a = this.rawTextures[s.name] ?? s.defaultValue ?? "";
        a.startsWith("@engine:") && this.customUnsubscribes.push(b.subscribe(a.slice(1), r));
      }
      this.tryBuildCustomBindGroup(i);
    }
    async initPBR(t, e) {
      var _a, _b;
      const i = u.extractMaterialState(t);
      this.textures = new Map(i.textures), this.textureFiles = i.textureFiles ? {
        ...i.textureFiles
      } : {
        albedo: "white.png",
        normal: "no-normal.jpg",
        metallic: "black.png",
        roughness: "black.png",
        emissive: "black.png"
      }, e.textures && await Promise.all(Object.entries(e.textures).map(async ([n, r]) => {
        var _a2;
        const s = g[n] ?? n, a = s === "normal", c = s === "albedo" && (((_a2 = t.getTechnique()) == null ? void 0 : _a2.getSrgbAlbedo()) ?? false), o = await l.getAsync(r, a, c);
        this.textures.set(s, o), this.textureViewUnsubs.push(o.addViewListener(() => void this.rebuildPBRBindGroup()));
      }));
      for (const [n, r] of i.textures) {
        const s = (_a = Object.entries(g).find(([, a]) => a === n)) == null ? void 0 : _a[0];
        (!s || !((_b = e.textures) == null ? void 0 : _b[s])) && this.textureViewUnsubs.push(r.addViewListener(() => void this.rebuildPBRBindGroup()));
      }
      this.uniformBuffer = h.createBuffer(`${this.path}_ub`, 48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), this.writeFactorsToGPU(), await this.rebuildPBRBindGroup();
    }
    async rebuildPBRBindGroup() {
      const t = [];
      let e = 0;
      for (const r of [
        "albedo",
        "normal",
        "metallic",
        "roughness",
        "emissive"
      ]) {
        const s = this.textures.get(r);
        if (!s) return;
        const a = u.getSlotView(s, r, this.instanceParent.getTechnique());
        if (!a) return;
        t.push({
          binding: e++,
          resource: a
        });
      }
      const i = this.textures.get("albedo");
      if (!i) return;
      const n = i.getSampler();
      n && (t.push({
        binding: e++,
        resource: n
      }), this.uniformBuffer && (t.push({
        binding: 6,
        resource: {
          buffer: this.uniformBuffer
        }
      }), this.textureBindGroup = f.createBindGroup(`${this.path}_bg`, f.getLayoutFromEnum(p.MATERIAL_TEXTURES), t)));
    }
    getParent() {
      return this.instanceParent;
    }
  };
});
export {
  m as MaterialInstance,
  __tla
};
