var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { M as o, R as B, E as b, T as l, G as h, a as f, b as S, B as g, P as w, __tla as __tla_0 } from "./index-D_qy4Vxk.js";
let x;
let __tla = Promise.all([
  (() => {
    try {
      return __tla_0;
    } catch {
    }
  })()
]).then(async () => {
  const m = {
    txAlbedo: "albedo",
    txNormal: "normal",
    txMetallic: "metallic",
    txRoughness: "roughness",
    txEmissive: "emissive"
  };
  x = class extends o {
    constructor(t, e) {
      super({
        path: e,
        type: B.MATERIAL,
        technique: t.getTechnique(),
        category: t.getCategory(),
        castsShadows: t.getCastsShadows(),
        shadows: t.getShadows()
      });
      __publicField(this, "instanceParent");
      this.instanceParent = t;
    }
    static async from(t, e = {}, i) {
      const r = i ?? `${t.getName()}__instance_${b.generateDynamicId()}`, n = new x(t, r);
      return await n.initFromParent(t, e), n;
    }
    async load() {
    }
    async initFromParent(t, e) {
      var _a;
      this.baseColorFactor = e.baseColorFactor ? [
        ...e.baseColorFactor
      ] : [
        ...t.getBaseColorFactor()
      ], this.roughnessFactor = e.roughnessFactor ?? t.getRoughnessFactor(), this.metallicFactor = e.metallicFactor ?? t.getMetallicFactor(), this.emissiveFactor = e.emissiveFactor ?? t.getEmissiveFactor(), this.uvXScale = e.uvXScale ?? t.getUvXScale(), this.uvYScale = e.uvYScale ?? t.getUvYScale(), this.appearanceBlend = e.appearanceBlend ?? t.getAppearanceBlend(), this.surfaceBlend = e.surfaceBlend ?? t.getSurfaceBlend(), this.pomScale = e.pomScale ?? t.getPomScale(), this.extras = {
        ...t.getExtras(),
        ...e.extras ?? {}
      }, t.getCastsShadows() && (this.shadowsMaterial = t.getShadowsMaterial());
      const i = (_a = t.getTechnique()) == null ? void 0 : _a.getMaterialSlots();
      i ? await this.initCustomSlot(t, e, i) : await this.initPBR(t, e);
    }
    async initCustomSlot(t, e, i) {
      var _a;
      const r = o.extractMaterialState(t);
      this.customSlotTextures = new Map(r.customSlotTextures), this.rawTextures = {
        ...r.rawTextures
      }, e.textures && await Promise.all(Object.entries(e.textures).map(async ([s, a]) => {
        var _a2;
        const c = ((_a2 = i.find((d) => d.name === s)) == null ? void 0 : _a2.srgb) ?? false, u = await l.getAsync(a, false, c);
        this.customSlotTextures.set(s, u), this.rawTextures[s] = a, this.textureViewUnsubs.push(u.addViewListener(() => this.tryBuildCustomBindGroup(i)));
      }));
      for (const [s, a] of r.customSlotTextures) ((_a = e.textures) == null ? void 0 : _a[s]) || this.textureViewUnsubs.push(a.addViewListener(() => this.tryBuildCustomBindGroup(i)));
      this.customUniformBuffer = h.createBuffer(`${this.path}_ub`, f, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), this.writeFactorsToGPU();
      const n = () => this.tryBuildCustomBindGroup(i);
      for (const s of i) {
        if (s.type === "sampler" || s.type === "uniform") continue;
        const a = this.rawTextures[s.name] ?? s.defaultValue ?? "";
        a.startsWith("@engine:") && this.customUnsubscribes.push(S.subscribe(a.slice(1), n));
      }
      this.tryBuildCustomBindGroup(i);
    }
    async initPBR(t, e) {
      var _a, _b;
      const i = o.extractMaterialState(t);
      this.textures = new Map(i.textures), this.textureFiles = i.textureFiles ? {
        ...i.textureFiles
      } : {
        albedo: "white.png",
        normal: "no-normal.jpg",
        metallic: "black.png",
        roughness: "black.png",
        emissive: "black.png"
      }, e.textures && await Promise.all(Object.entries(e.textures).map(async ([r, n]) => {
        var _a2;
        const s = m[r] ?? r, a = s === "normal", c = s === "albedo" && (((_a2 = t.getTechnique()) == null ? void 0 : _a2.getSrgbAlbedo()) ?? false), u = await l.getAsync(n, a, c);
        this.textures.set(s, u), this.textureViewUnsubs.push(u.addViewListener(() => void this.rebuildPBRBindGroup()));
      }));
      for (const [r, n] of i.textures) {
        const s = (_a = Object.entries(m).find(([, a]) => a === r)) == null ? void 0 : _a[0];
        (!s || !((_b = e.textures) == null ? void 0 : _b[s])) && this.textureViewUnsubs.push(n.addViewListener(() => void this.rebuildPBRBindGroup()));
      }
      this.uniformBuffer = h.createBuffer(`${this.path}_ub`, f, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), this.writeFactorsToGPU(), await this.rebuildPBRBindGroup();
    }
    async rebuildPBRBindGroup() {
      const t = [];
      let e = 0;
      for (const n of [
        "albedo",
        "normal",
        "metallic",
        "roughness",
        "emissive"
      ]) {
        const s = this.textures.get(n);
        if (!s) return;
        const a = o.getSlotView(s, n, this.instanceParent.getTechnique());
        if (!a) return;
        t.push({
          binding: e++,
          resource: a
        });
      }
      const i = this.textures.get("albedo");
      if (!i) return;
      const r = i.getSampler();
      r && (t.push({
        binding: e++,
        resource: r
      }), this.uniformBuffer && (t.push({
        binding: 6,
        resource: {
          buffer: this.uniformBuffer
        }
      }), this.textureBindGroup = g.createBindGroup(`${this.path}_bg`, g.getLayoutFromEnum(w.MATERIAL_TEXTURES), t)));
    }
    getParent() {
      return this.instanceParent;
    }
  };
});
export {
  x as MaterialInstance,
  __tla
};
