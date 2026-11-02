// Assemble the Blender dump (mesh.bin/mesh.json) into a glTF that reuses the
// mannequin's exact skeleton (nodes, skin, inverse binds) so every clip retargets 1:1.
//
//   node tools/character/build.mjs <dump_dir> [name=shardplate]
import fs from 'node:fs';
import path from 'node:path';

const [dumpDir, name = 'shardplate'] = process.argv.slice(2);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../..');
const srcDir = path.join(ROOT, 'public/assets/meshes/character');
const src = JSON.parse(fs.readFileSync(path.join(srcDir, 'character.gltf'), 'utf8'));
const srcBin = fs.readFileSync(path.join(srcDir, src.buffers[0].uri));

const meta = JSON.parse(fs.readFileSync(path.join(dumpDir, 'mesh.json'), 'utf8'));
const dump = fs.readFileSync(path.join(dumpDir, 'mesh.bin'));
const { vertexCount: N, indexCount: I, stride: S } = meta;

// Blender bone index -> glTF skin joint slot (matched by node name)
const skin = src.skins[0];
const jointSlot = new Map(skin.joints.map((n, i) => [src.nodes[n].name, i]));
const remap = meta.bones.map((b) => {
  const s = jointSlot.get(b);
  if (s === undefined) throw new Error(`bone ${b} not in mannequin skin`);
  return s;
});

// De-interleave into tightly packed attribute streams
const pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3), uv = new Float32Array(N * 2);
const tan = new Float32Array(N * 4), wgt = new Float32Array(N * 4), jnt = new Uint16Array(N * 4);
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < N; i++) {
  const o = i * S;
  for (let k = 0; k < 3; k++) {
    pos[i * 3 + k] = dump.readFloatLE(o + k * 4);
    min[k] = Math.min(min[k], pos[i * 3 + k]);
    max[k] = Math.max(max[k], pos[i * 3 + k]);
    nrm[i * 3 + k] = dump.readFloatLE(o + 12 + k * 4);
  }
  uv[i * 2] = dump.readFloatLE(o + 24);
  uv[i * 2 + 1] = dump.readFloatLE(o + 28);
  for (let k = 0; k < 4; k++) {
    tan[i * 4 + k] = dump.readFloatLE(o + 32 + k * 4);
    wgt[i * 4 + k] = dump.readFloatLE(o + 48 + k * 4);
    jnt[i * 4 + k] = remap[dump.readUInt16LE(o + 64 + k * 2)];
  }
}
const idx = new Uint32Array(dump.buffer.slice(dump.byteOffset + N * S, dump.byteOffset + N * S + I * 4));

// Inverse bind matrices straight from the source buffer
const ibmAcc = src.accessors[skin.inverseBindMatrices];
const ibmView = src.bufferViews[ibmAcc.bufferView];
const ibm = srcBin.subarray((ibmView.byteOffset ?? 0) + (ibmAcc.byteOffset ?? 0),
  (ibmView.byteOffset ?? 0) + (ibmAcc.byteOffset ?? 0) + ibmAcc.count * 64);

const chunks = [], bufferViews = [], accessors = [];
let offset = 0;
const add = (data, acc, target) => {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
  chunks.push(bytes);
  offset += bytes.length;
  accessors.push({ bufferView: bufferViews.length - 1, ...acc });
  return accessors.length - 1;
};
const ARRAY = 34962, ELEMENT = 34963;
const attributes = {
  POSITION: add(pos, { componentType: 5126, count: N, type: 'VEC3', min, max }, ARRAY),
  NORMAL: add(nrm, { componentType: 5126, count: N, type: 'VEC3' }, ARRAY),
  TEXCOORD_0: add(uv, { componentType: 5126, count: N, type: 'VEC2' }, ARRAY),
  TANGENT: add(tan, { componentType: 5126, count: N, type: 'VEC4' }, ARRAY),
  JOINTS_0: add(jnt, { componentType: 5123, count: N, type: 'VEC4' }, ARRAY),
  WEIGHTS_0: add(wgt, { componentType: 5126, count: N, type: 'VEC4' }, ARRAY),
};
const indices = add(idx, { componentType: 5125, count: I, type: 'SCALAR' }, ELEMENT);
const ibmIndex = add(new Uint8Array(ibm), { componentType: 5126, count: ibmAcc.count, type: 'MAT4' });

const tex = (file) => fs.existsSync(path.join(ROOT, 'public/assets/textures', name, file));
const images = [], textures = [];
const texRef = (file) => {
  if (!tex(file)) return undefined;
  images.push({ uri: file });
  textures.push({ source: images.length - 1 });
  return { index: textures.length - 1 };
};
const baseColorTexture = texRef(`${name}_albedo.png`);
const mrTex = texRef(`${name}_orm.png`);
const normalTexture = texRef(`${name}_normal.png`);
const material = {
  name: `M_${name}`,
  pbrMetallicRoughness: {
    baseColorFactor: baseColorTexture ? [1, 1, 1, 1] : [0.1, 0.22, 0.55, 1],
    metallicFactor: mrTex ? 1 : 0.7,
    roughnessFactor: mrTex ? 1 : 0.4,
    ...(baseColorTexture ? { baseColorTexture } : {}),
    ...(mrTex ? { metallicRoughnessTexture: mrTex } : {}),
  },
  ...(normalTexture ? { normalTexture } : {}),
  ...(mrTex ? { occlusionTexture: { index: mrTex.index } } : {}),
};

const meshNode = src.nodes.findIndex((n) => n.mesh !== undefined);
const nodes = src.nodes.map((n, i) => (i === meshNode ? { ...n, name: name, mesh: 0, skin: 0 } : n));
const out = {
  asset: { version: '2.0', generator: 'tools/character/build.mjs' },
  scene: src.scene ?? 0,
  scenes: src.scenes,
  nodes,
  meshes: [{ name, primitives: [{ attributes, indices, material: 0 }] }],
  materials: [material],
  ...(images.length ? { images, textures, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }] } : {}),
  skins: [{ ...skin, inverseBindMatrices: ibmIndex }],
  accessors,
  bufferViews,
  buffers: [{ uri: `${name}.bin`, byteLength: offset }],
};
if (out.textures) out.textures.forEach((t) => (t.sampler = 0));

const outDir = path.join(ROOT, 'public/assets/meshes', name);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${name}.bin`), Buffer.concat(chunks));
fs.writeFileSync(path.join(outDir, `${name}.gltf`), JSON.stringify(out));
console.log(`${name}.gltf: ${N} verts, ${I / 3} tris, ${(offset / 1048576).toFixed(1)} MB, bounds`, min.map((v) => v.toFixed(3)), max.map((v) => v.toFixed(3)));
