/**
 * GLB → engine glTF layout converter.
 *
 * GLTFLoader only reads `.gltf` + external `.bin` from assets/meshes/<name>/ and resolves
 * texture URIs as assets/textures/<name>/<uri>. This splits a `.glb` (with embedded images)
 * into that layout:
 *   public/assets/meshes/<name>/<name>.gltf + <name>.bin
 *   public/assets/textures/<name>/<image>.<ext>
 *
 * Usage:
 *   npx tsx scripts/convert-glb.mts <input.glb> [--name dungeon] [--roughness 0.3] [--metallic 0]
 *
 * --roughness / --metallic override the factor of every material (useful to reproduce
 * reference scenes, e.g. three.js' SSR example forces roughness = 0.3).
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join, basename, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const input = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!input) {
  console.error(
    'Usage: npx tsx scripts/convert-glb.mts <input.glb> [--name n] [--roughness r] [--metallic m]',
  );
  process.exit(1);
}

const name = flag('name') ?? basename(input, extname(input));
const roughness = flag('roughness');
const metallic = flag('metallic');

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/ktx2': 'ktx2',
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();

// Unique, filesystem-safe URIs for every image
const used = new Set<string>();
root.listTextures().forEach((tex, i) => {
  const ext = MIME_EXT[tex.getMimeType()] ?? 'png';
  const base = (tex.getName() || `texture_${i}`).replace(/[^\w.-]+/g, '_');
  let uri = `${base}.${ext}`;
  for (let n = 1; used.has(uri); n++) uri = `${base}_${n}.${ext}`;
  used.add(uri);
  tex.setURI(uri);
});

for (const mat of root.listMaterials()) {
  if (roughness !== undefined) mat.setRoughnessFactor(Number(roughness));
  if (metallic !== undefined) mat.setMetallicFactor(Number(metallic));
}

// Single external buffer
for (const buffer of root.listBuffers()) buffer.setURI(`${name}.bin`);

const { json, resources } = await io.writeJSON(doc, { format: 0 /* Format.GLTF */ });

const meshDir = join(REPO_ROOT, 'public', 'assets', 'meshes', name);
const texDir = join(REPO_ROOT, 'public', 'assets', 'textures', name);
mkdirSync(meshDir, { recursive: true });
mkdirSync(texDir, { recursive: true });

writeFileSync(join(meshDir, `${name}.gltf`), JSON.stringify(json));
let images = 0;
for (const [uri, data] of Object.entries(resources)) {
  if (uri.endsWith('.bin')) {
    writeFileSync(join(meshDir, uri), data);
  } else {
    writeFileSync(join(texDir, uri), data);
    images++;
  }
}

console.log(
  `✓ ${name}: ${root.listMeshes().length} meshes, ${root.listMaterials().length} materials, ${images} images`,
);
console.log(`  ${meshDir}`);
console.log(`  ${texDir}`);
