/**
 * Binned-SAH BVH2 builder (no DOM, runs in bvh.worker.ts and on the main thread for the TLAS).
 *
 * Node layout (8 × 32-bit, matches gi/common/bvh.wgsl):
 *   [0..2] aabb min   [3] leftFirst (u32)   [4..6] aabb max   [7] count (u32)
 * count == 0 → internal node, children at leftFirst and leftFirst + 1.
 * count  > 0 → leaf over primitives order[leftFirst .. leftFirst + count).
 */

export const BVH_NODE_FLOATS = 8;

export interface BVHBuildInput {
  /** Per primitive: min.xyz, max.xyz (6 floats). */
  bounds: Float32Array;
  count: number;
  /** Leaves stop splitting at this size; SAH may stop earlier when splitting doesn't pay. */
  maxLeafSize: number;
  /** Largest leaf SAH may keep when no split is cheaper (1 = always split down to single primitives). */
  maxSahLeafSize?: number;
}

export interface BVHBuildResult {
  nodes: Float32Array;
  nodeCount: number;
  /** Leaf primitive order: leaf ranges index this array. */
  order: Uint32Array;
}

const BINS = 16;
const TRAVERSAL_COST = 1.0;
const INTERSECT_COST = 1.0;
/** Default largest leaf SAH keeps when no split is cheaper. */
const MAX_SAH_LEAF = 8;

function area(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx);
}

export function buildBVH(input: BVHBuildInput): BVHBuildResult {
  const { bounds, count, maxLeafSize } = input;
  const maxSahLeaf = input.maxSahLeafSize ?? MAX_SAH_LEAF;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;

  const centroids = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const b = i * 6;
    centroids[i * 3] = (bounds[b]! + bounds[b + 3]!) * 0.5;
    centroids[i * 3 + 1] = (bounds[b + 1]! + bounds[b + 4]!) * 0.5;
    centroids[i * 3 + 2] = (bounds[b + 2]! + bounds[b + 5]!) * 0.5;
  }

  const maxNodes = Math.max(1, 2 * count - 1);
  const buffer = new ArrayBuffer(maxNodes * BVH_NODE_FLOATS * 4);
  const nodes = new Float32Array(buffer);
  const nodesU = new Uint32Array(buffer);
  let nodeCount = 1;

  // Bin scratch: count + bounds per bin, and the right-to-left sweep.
  const binCount = new Uint32Array(BINS);
  const binBounds = new Float32Array(BINS * 6);
  const rightArea = new Float32Array(BINS);
  const rightCount = new Uint32Array(BINS);

  // Work stack of (node, first, count) triples, popped in reverse.
  const stack: number[] = [0, 0, count];

  while (stack.length > 0) {
    const nCount = stack.pop()!;
    const first = stack.pop()!;
    const node = stack.pop()!;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let i = first; i < first + nCount; i++) {
      const p = order[i]!;
      const b = p * 6;
      if (bounds[b]! < minX) minX = bounds[b]!;
      if (bounds[b + 1]! < minY) minY = bounds[b + 1]!;
      if (bounds[b + 2]! < minZ) minZ = bounds[b + 2]!;
      if (bounds[b + 3]! > maxX) maxX = bounds[b + 3]!;
      if (bounds[b + 4]! > maxY) maxY = bounds[b + 4]!;
      if (bounds[b + 5]! > maxZ) maxZ = bounds[b + 5]!;
      const c = p * 3;
      const cx = centroids[c]!, cy = centroids[c + 1]!, cz = centroids[c + 2]!;
      if (cx < cMinX) cMinX = cx;
      if (cy < cMinY) cMinY = cy;
      if (cz < cMinZ) cMinZ = cz;
      if (cx > cMaxX) cMaxX = cx;
      if (cy > cMaxY) cMaxY = cy;
      if (cz > cMaxZ) cMaxZ = cz;
    }

    const o = node * BVH_NODE_FLOATS;
    nodes[o] = minX;
    nodes[o + 1] = minY;
    nodes[o + 2] = minZ;
    nodes[o + 4] = maxX;
    nodes[o + 5] = maxY;
    nodes[o + 6] = maxZ;

    const makeLeaf = () => {
      nodesU[o + 3] = first;
      nodesU[o + 7] = nCount;
    };

    if (nCount <= maxLeafSize) {
      makeLeaf();
      continue;
    }

    // ── Binned SAH over the three axes ────────────────────────────────────
    let bestAxis = -1;
    let bestSplit = 0;
    let bestCost = Infinity;
    const cMin = [cMinX, cMinY, cMinZ];
    const cMax = [cMaxX, cMaxY, cMaxZ];

    for (let axis = 0; axis < 3; axis++) {
      const lo = cMin[axis]!;
      const extent = cMax[axis]! - lo;
      if (extent <= 1e-6) continue;
      const scale = BINS / extent;

      binCount.fill(0);
      for (let b = 0; b < BINS; b++) {
        binBounds[b * 6] = Infinity;
        binBounds[b * 6 + 1] = Infinity;
        binBounds[b * 6 + 2] = Infinity;
        binBounds[b * 6 + 3] = -Infinity;
        binBounds[b * 6 + 4] = -Infinity;
        binBounds[b * 6 + 5] = -Infinity;
      }
      for (let i = first; i < first + nCount; i++) {
        const p = order[i]!;
        const bin = Math.min(BINS - 1, ((centroids[p * 3 + axis]! - lo) * scale) | 0);
        binCount[bin]!++;
        const bb = bin * 6;
        const pb = p * 6;
        for (let k = 0; k < 3; k++) {
          if (bounds[pb + k]! < binBounds[bb + k]!) binBounds[bb + k] = bounds[pb + k]!;
          if (bounds[pb + 3 + k]! > binBounds[bb + 3 + k]!) binBounds[bb + 3 + k] = bounds[pb + 3 + k]!;
        }
      }

      // Sweep right → left: area/count of bins [b+1, BINS).
      let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity;
      let rMaxX = -Infinity, rMaxY = -Infinity, rMaxZ = -Infinity;
      let rCount = 0;
      for (let b = BINS - 1; b > 0; b--) {
        const bb = b * 6;
        if (binCount[b]! > 0) {
          rMinX = Math.min(rMinX, binBounds[bb]!);
          rMinY = Math.min(rMinY, binBounds[bb + 1]!);
          rMinZ = Math.min(rMinZ, binBounds[bb + 2]!);
          rMaxX = Math.max(rMaxX, binBounds[bb + 3]!);
          rMaxY = Math.max(rMaxY, binBounds[bb + 4]!);
          rMaxZ = Math.max(rMaxZ, binBounds[bb + 5]!);
        }
        rCount += binCount[b]!;
        rightCount[b - 1] = rCount;
        rightArea[b - 1] = rCount > 0 ? area(rMinX, rMinY, rMinZ, rMaxX, rMaxY, rMaxZ) : 0;
      }

      // Sweep left → right and evaluate split after bin b.
      let lMinX = Infinity, lMinY = Infinity, lMinZ = Infinity;
      let lMaxX = -Infinity, lMaxY = -Infinity, lMaxZ = -Infinity;
      let lCount = 0;
      for (let b = 0; b < BINS - 1; b++) {
        const bb = b * 6;
        if (binCount[b]! > 0) {
          lMinX = Math.min(lMinX, binBounds[bb]!);
          lMinY = Math.min(lMinY, binBounds[bb + 1]!);
          lMinZ = Math.min(lMinZ, binBounds[bb + 2]!);
          lMaxX = Math.max(lMaxX, binBounds[bb + 3]!);
          lMaxY = Math.max(lMaxY, binBounds[bb + 4]!);
          lMaxZ = Math.max(lMaxZ, binBounds[bb + 5]!);
        }
        lCount += binCount[b]!;
        const rc = rightCount[b]!;
        if (lCount === 0 || rc === 0) continue;
        const cost =
          lCount * area(lMinX, lMinY, lMinZ, lMaxX, lMaxY, lMaxZ) + rc * rightArea[b]!;
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestSplit = b;
        }
      }
    }

    const parentArea = area(minX, minY, minZ, maxX, maxY, maxZ);
    const leafCost = nCount * INTERSECT_COST;
    const splitCost =
      parentArea > 0 ? TRAVERSAL_COST + (INTERSECT_COST * bestCost) / parentArea : Infinity;

    let mid: number;
    if (bestAxis < 0) {
      // All centroids coincide: split by count so leaves stay bounded.
      mid = first + (nCount >> 1);
    } else {
      if (splitCost >= leafCost && nCount <= maxSahLeaf) {
        makeLeaf();
        continue;
      }
      const lo = cMin[bestAxis]!;
      const scale = BINS / (cMax[bestAxis]! - lo);
      let i = first;
      let j = first + nCount - 1;
      while (i <= j) {
        const p = order[i]!;
        const bin = Math.min(BINS - 1, ((centroids[p * 3 + bestAxis]! - lo) * scale) | 0);
        if (bin <= bestSplit) {
          i++;
        } else {
          order[i] = order[j]!;
          order[j] = p;
          j--;
        }
      }
      mid = i;
      if (mid === first || mid === first + nCount) mid = first + (nCount >> 1);
    }

    const left = nodeCount;
    nodeCount += 2;
    nodesU[o + 3] = left;
    nodesU[o + 7] = 0;
    stack.push(left, first, mid - first);
    stack.push(left + 1, mid, first + nCount - mid);
  }

  return { nodes: nodes.slice(0, nodeCount * BVH_NODE_FLOATS), nodeCount, order };
}

/** Per-triangle bounds for an indexed mesh (input to buildBVH). */
export function triangleBounds(positions: Float32Array, indices: ArrayLike<number>): Float32Array {
  const triCount = Math.floor(indices.length / 3);
  const out = new Float32Array(triCount * 6);
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const c = indices[t * 3 + 2]! * 3;
    for (let k = 0; k < 3; k++) {
      const va = positions[a + k]!, vb = positions[b + k]!, vc = positions[c + k]!;
      out[t * 6 + k] = Math.min(va, vb, vc);
      out[t * 6 + 3 + k] = Math.max(va, vb, vc);
    }
  }
  return out;
}
