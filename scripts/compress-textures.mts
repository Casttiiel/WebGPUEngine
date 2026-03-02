/**
 * Texture compression pipeline — converts PNG/JPG/WebP → KTX2 (Basis Universal / UASTC)
 *
 * Prerequisites:
 *   1. Download the basisu binary for your platform from:
 *      https://github.com/BinomialLLC/basis_universal/releases
 *   2. Place basisu.exe (Windows) or basisu (Linux/Mac) in scripts/bin/
 *      OR add it to your system PATH.
 *
 * Usage:
 *   npm run compress-textures
 *   npm run compress-textures -- --force   (re-compress all, even existing .ktx2)
 *   npm run compress-textures -- --dir sponza  (only process a subdirectory)
 */

import { existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, extname, relative, basename, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const TEXTURES_DIR = join(REPO_ROOT, 'public', 'assets', 'textures');

// ─── Config ───────────────────────────────────────────────────────────────────

const BASISU_BINARY = existsSync(join(__dirname, 'bin', 'basisu.exe'))
  ? join(__dirname, 'bin', 'basisu.exe')
  : existsSync(join(__dirname, 'bin', 'basisu'))
    ? join(__dirname, 'bin', 'basisu')
    : 'basisu'; // fallback: assume it's in PATH

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// Filename patterns that indicate linear (non-sRGB) data.
// Everything else is treated as sRGB (base color, albedo, emissive).
const LINEAR_PATTERNS = [
  /normal/i,
  /nrm/i,
  /nor_/i,
  /metallic/i,
  /roughness/i,
  /metallicRoughness/i,
  /occlusion/i,
  /ao\b/i,
  /orm\b/i, // occlusion-roughness-metallic packed
  /height/i,
  /displacement/i,
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isLinear(filePath: string): boolean {
  const name = basename(filePath);
  return LINEAR_PATTERNS.some((p) => p.test(name));
}

function findTextures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findTextures(full));
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

// ─── Conversion ──────────────────────────────────────────────────────────────

interface CompressResult {
  skipped: number;
  ok: number;
  failed: number;
}

function compress(texturePath: string, force: boolean): 'skip' | 'ok' | 'fail' {
  const ktx2Path = texturePath.replace(/\.(png|jpg|jpeg|webp)$/i, '.ktx2');
  const rel = relative(TEXTURES_DIR, texturePath);

  if (!force && existsSync(ktx2Path)) {
    return 'skip';
  }

  const linear = isLinear(texturePath);

  const args: string[] = [
    texturePath,
    '-output_file',
    ktx2Path,
    '-ktx2',
    '-uastc', // UASTC encoding (higher quality than ETC1S, transcodes to BC7/ASTC)
    '-uastc_level',
    '2', // 0=fastest, 4=best; 2 is a good balance
    '-mipmap', // embed all mip levels (skip generateMipmaps at runtime)
  ];

  if (linear) {
    args.push('-linear');
  }

  const result = spawnSync(BASISU_BINARY, args, { encoding: 'utf8' });

  if (result.error) {
    // Binary not found
    console.error(`\n[ERROR] Could not run basisu: ${result.error.message}`);
    console.error(
      '  → Download basisu from https://github.com/BinomialLLC/basis_universal/releases',
    );
    console.error('    and place it in scripts/bin/ or add to PATH.\n');
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`  ✗ FAIL  ${rel}`);
    if (result.stderr) console.error(`    ${result.stderr.trim()}`);
    return 'fail';
  }

  // Print size comparison
  const srcStat = statSync(texturePath);
  const dstStat = statSync(ktx2Path);
  const ratio = ((dstStat.size / srcStat.size) * 100).toFixed(0);
  const colorTag = linear ? '[L]' : '[S]'; // [L]inear / [S]RGB
  console.log(
    `  ✓  ${colorTag}  ${rel}  (${ratio}% of original, ${(dstStat.size / 1024).toFixed(0)} KB)`,
  );
  return 'ok';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const force = args.includes('--force');
const dirArg = args.find((a) => a.startsWith('--dir='))?.slice(6) ?? null;

const searchDir = dirArg ? join(TEXTURES_DIR, dirArg) : TEXTURES_DIR;
const textures = findTextures(searchDir);

if (textures.length === 0) {
  console.log('No textures found in', searchDir);
  process.exit(0);
}

console.log(`\n🗜  Compressing ${textures.length} textures → KTX2/UASTC`);
console.log(`   Force: ${force ? 'yes' : 'no (skip existing)'}`);
console.log(`   Directory: ${relative(REPO_ROOT, searchDir)}\n`);
console.log(`   [L] = linear (normals, roughness, metallic)`);
console.log(`   [S] = sRGB   (base color, albedo)\n`);

const result: CompressResult = { skipped: 0, ok: 0, failed: 0 };

for (const tex of textures) {
  const outcome = compress(tex, force);
  result[outcome === 'skip' ? 'skipped' : outcome === 'ok' ? 'ok' : 'failed']++;
}

console.log(`\n── Summary ────────────────────────────`);
console.log(`   Converted : ${result.ok}`);
console.log(`   Skipped   : ${result.skipped} (already exist)`);
console.log(`   Failed    : ${result.failed}`);
console.log(`───────────────────────────────────────\n`);

if (result.failed > 0) process.exit(1);
