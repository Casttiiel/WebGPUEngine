"""Shared helpers for the procedural Shardplate build (run inside Blender).

World space is Blender's (Z up, character faces -Y, T-pose). Every armor piece is
a mesh object tagged with the bone(s) that drive it:
  ob["bone"]  = "upperarm_l"        -> rigid, weight 1
  ob["bone"]  = "@transfer"         -> weights copied from the mannequin body
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix

TAU = math.tau


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_mannequin(path):
    bpy.ops.import_scene.gltf(filepath=path)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    body = next(o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith('Mannequin'))
    # drop the rigify widget empties the importer drags in
    for o in list(bpy.data.objects):
        if o.type == 'EMPTY':
            bpy.data.objects.remove(o)
    return arm, body


def bone_head(arm, name):
    return arm.matrix_world @ arm.data.bones[name].head_local


def bone_tail(arm, name):
    return arm.matrix_world @ arm.data.bones[name].tail_local


# ── Body sampling ───────────────────────────────────────────────────────────

class BodySampler:
    """World-space body vertices grouped by dominant bone, for fitting plates."""

    def __init__(self, body):
        names = {g.index: g.name for g in body.vertex_groups}
        mw = body.matrix_world
        self.by_bone = {}
        for v in body.data.vertices:
            if not v.groups:
                continue
            g = max(v.groups, key=lambda g: g.weight)
            self.by_bone.setdefault(names[g.group], []).append(mw @ v.co)

    def points(self, bones):
        out = []
        for b in bones:
            out += self.by_bone.get(b, [])
        return out

    @staticmethod
    def ring_fit(pts, origin, d, u, v, t, band=0.02, n=2.3):
        """Superellipse (exponent n) enclosing the body slice at distance t along d,
        in the (u, v) plane: bbox-centered, radii scaled until every slice vertex
        is inside. Returns (center_u, center_v, radius_u, radius_v) or None."""
        sel = []
        while len(sel) < 6 and band < 0.2:  # widen until the slice catches enough verts
            sel = [p for p in pts if abs((p - origin).dot(d) - t) < band]
            band *= 1.5
        if len(sel) < 3:
            return None
        us = [(p - origin).dot(u) for p in sel]
        vs = [(p - origin).dot(v) for p in sel]
        cu, cv = (max(us) + min(us)) / 2, (max(vs) + min(vs)) / 2
        hu, hv = max((max(us) - min(us)) / 2, 1e-4), max((max(vs) - min(vs)) / 2, 1e-4)
        k = max((abs(a - cu) / hu) ** n + (abs(b - cv) / hv) ** n for a, b in zip(us, vs)) ** (1.0 / n)
        return cu, cv, hu * k, hv * k


# ── Frames ──────────────────────────────────────────────────────────────────

def frame(d, up_hint=Vector((0, -1, 0))):
    """Orthonormal (d, u, v) with u as close to up_hint as possible."""
    d = d.normalized()
    u = (up_hint - d * up_hint.dot(d))
    if u.length < 1e-4:
        u = Vector((0, 0, 1)) - d * d.z
    u.normalize()
    v = d.cross(u).normalized()
    return d, u, v


# ── Loft: rings swept along an axis ────────────────────────────────────────

def superellipse(theta, ru, rv, n):
    c, s = math.cos(theta), math.sin(theta)
    x = math.copysign(abs(c) ** (2.0 / n), c) * ru
    y = math.copysign(abs(s) ** (2.0 / n), s) * rv
    return x, y


def loft(name, origin, d, u, v, rings, seg=24, arc=(0.0, TAU), cap_end=False,
         cap_start=False):
    """rings: list of dicts {t, cu, cv, ru, rv, n?, ridge?, ridge_w?, ridge_at?}
    t along d, center offset (cu, cv) in (u, v), radii, superellipse exponent n,
    optional ridge (extra radius peaking at angle ridge_at, width exponent ridge_w).
    arc: angular coverage; full circle -> closed ring.
    """
    closed = abs((arc[1] - arc[0]) - TAU) < 1e-6
    nseg = seg if closed else seg + 1
    bm = bmesh.new()
    grid = []
    for r in rings:
        row = []
        for j in range(nseg):
            a = arc[0] + (arc[1] - arc[0]) * j / seg
            x, y = superellipse(a, r['ru'], r['rv'], r.get('n', 2.0))
            if r.get('ridge'):
                k = max(0.0, math.cos(a - r.get('ridge_at', 0.0))) ** r.get('ridge_w', 8)
                x += math.cos(a) * r['ridge'] * k
                y += math.sin(a) * r['ridge'] * k
            t = r['t']
            if r.get('dip'):  # pull the ring along d around one angle (V-shaped hems)
                t += r['dip'] * max(0.0, math.cos(a - r.get('dip_at', 0.0))) ** r.get('dip_w', 4)
            p = origin + d * t + u * (r.get('cu', 0) + x) + v * (r.get('cv', 0) + y)
            row.append(bm.verts.new(p))
        grid.append(row)
    for i in range(len(grid) - 1):
        for j in range(seg):
            j2 = (j + 1) % nseg
            bm.faces.new((grid[i][j], grid[i][j2], grid[i + 1][j2], grid[i + 1][j]))
    for ends, rows in ((cap_start, grid[0]), (cap_end, grid[-1])):
        if ends:
            c = sum((x.co for x in rows), Vector()) / len(rows)
            cv = bm.verts.new(c)
            for j in range(seg):
                j2 = (j + 1) % nseg
                bm.faces.new((rows[j], rows[j2], cv) if rows is grid[-1] else (rows[j2], rows[j], cv))
    _orient_outward(bm, origin, d)
    return _to_object(bm, name)


def _orient_outward(bm, origin, d):
    score = 0.0
    for f in bm.faces:
        c = f.calc_center_median()
        radial = (c - origin) - d * (c - origin).dot(d)
        score += f.normal.dot(radial) if radial.length > 1e-5 else f.normal.dot(d)
    if score < 0:
        for f in bm.faces:
            f.normal_flip()


def _to_object(bm, name):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def from_bmesh(bm, name):
    return _to_object(bm, name)


# ── Finishing: thickness + bevel, the "plate" look ─────────────────────────

def plate(ob, bone, thick=0.008, bevel=0.003, segs=2, smooth=True, angle=40):
    ob["bone"] = bone
    if thick:
        m = ob.modifiers.new("solid", 'SOLIDIFY')
        m.thickness = thick
        m.offset = 1.0
        m.use_even_offset = True
    if bevel:
        m = ob.modifiers.new("bevel", 'BEVEL')
        m.width = bevel
        m.segments = segs
        m.limit_method = 'ANGLE'
        m.angle_limit = math.radians(angle)
        m.harden_normals = True
    for p in ob.data.polygons:
        p.use_smooth = smooth
    if smooth:
        try:
            ob.data.set_sharp_from_angle(angle=math.radians(angle))
        except AttributeError:
            pass
    return ob


def mirror_x(ob, bone_map):
    """Duplicate an object mirrored across X, remapping its bone tag (_l -> _r)."""
    me = ob.data.copy()
    me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
    me.flip_normals()
    dup = bpy.data.objects.new(ob.name.replace('_l', '_r'), me)
    bpy.context.scene.collection.objects.link(dup)
    for m in ob.modifiers:
        n = dup.modifiers.new(m.name, m.type)
        for attr in ('thickness', 'offset', 'use_even_offset', 'width', 'segments',
                     'limit_method', 'angle_limit', 'harden_normals'):
            if hasattr(m, attr):
                setattr(n, attr, getattr(m, attr))
    for k in ob.keys():
        dup[k] = ob[k]
    b = ob.get("bone", "")
    dup["bone"] = bone_map(b)
    if "bone2" in ob:
        dup["bone2"] = bone_map(ob["bone2"])
    return dup


def lr(name):
    return name[:-2] + '_r' if name.endswith('_l') else name


def sphere_cap(name, center, radius, scale=(1, 1, 1), lat=(0.0, math.pi / 2), seg=24, rings=8,
               rot=Matrix.Identity(3)):
    """Partial UV sphere (latitude range from the +Z pole), scaled, rotated."""
    bm = bmesh.new()
    grid = []
    for i in range(rings + 1):
        phi = lat[0] + (lat[1] - lat[0]) * i / rings
        row = []
        for j in range(seg):
            th = TAU * j / seg
            p = Vector((math.sin(phi) * math.cos(th) * scale[0],
                        math.sin(phi) * math.sin(th) * scale[1],
                        math.cos(phi) * scale[2])) * radius
            row.append(p)
        grid.append(row)
    verts = []
    for i, row in enumerate(grid):
        if i == 0 and lat[0] == 0.0:
            verts.append([bm.verts.new(center + rot @ row[0])] * seg)
        else:
            verts.append([bm.verts.new(center + rot @ p) for p in row])
    for i in range(rings):
        for j in range(seg):
            j2 = (j + 1) % seg
            q = [verts[i][j], verts[i][j2], verts[i + 1][j2], verts[i + 1][j]]
            uniq = []
            for x in q:
                if x not in uniq:
                    uniq.append(x)
            if len(uniq) >= 3:
                bm.faces.new(uniq)
    _orient_outward(bm, center, rot @ Vector((0, 0, 1)) * 1e-3)
    return _to_object(bm, name)


def box(name, center, size, rot=Matrix.Identity(3)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for vt in bm.verts:
        vt.co = center + rot @ Vector((vt.co.x * size[0], vt.co.y * size[1], vt.co.z * size[2]))
    return _to_object(bm, name)


# ── Surfaces + outline plates ──────────────────────────────────────────────
# A Surf is a stack of superellipse rings along an axis (usually fitted to the
# body). Plates are drawn on it as 2D outlines in (theta, t): theta = angle
# around the axis (0 = u), t = distance along d. That lets each plate have its
# own silhouette (teardrops, sickles, toothed hems) while hugging the body.

class Surf:
    def __init__(self, origin, d, u, v, rings, n=2.3):
        """rings: [(t, cu, cv, ru, rv)] sorted by t."""
        self.o, self.d, self.u, self.v, self.n = origin, d, u, v, n
        self.rings = sorted(rings)

    @classmethod
    def fit(cls, sampler_pts, origin, d, u, v, t0, t1, step=0.01, add=0.0, n=2.3, smooth=3,
            fallback=None):
        rings = []
        t = t0
        while t <= t1 + 1e-6:
            f = BodySampler.ring_fit(sampler_pts, origin, d, u, v, t, band=0.012, n=n)
            if f is None and fallback is not None:
                f = fallback(t)
            if f is not None:
                rings.append([t, f[0], f[1], f[2] + add, f[3] + add])
            t += step
        # Gaussian-smooth each channel (sigma = `smooth` samples) so the plate reads
        # as one sheet, then push radii out by the local worst miss so it still encloses.
        import numpy as np
        A = np.array(rings)
        sig = max(1.0, float(smooth))
        w = int(3 * sig)
        ker = np.exp(-0.5 * (np.arange(-w, w + 1) / sig) ** 2)

        def blur(y):
            p = np.pad(y, w, mode='edge')
            return np.convolve(p, ker / ker.sum(), mode='valid')

        out = [A[:, 0]]
        for k in (1, 2, 3, 4):
            y = blur(A[:, k])
            if k >= 3:
                miss = np.maximum(A[:, k] - y, 0.0)
                p = np.pad(miss, w, mode='edge')
                local = np.array([p[i:i + 2 * w + 1].max() for i in range(len(miss))])
                y = y + blur(local)
            out.append(y)
        rings = [tuple(float(x) for x in row) for row in np.stack(out, axis=1)]
        return cls(origin, d, u, v, rings, n)

    def ring(self, t):
        R = self.rings
        if t <= R[0][0]:
            return R[0][1:]
        if t >= R[-1][0]:
            return R[-1][1:]
        lo, hi = 0, len(R) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if R[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        a, b = R[lo], R[hi]
        k = (t - a[0]) / (b[0] - a[0])
        return tuple(a[i] + (b[i] - a[i]) * k for i in range(1, 5))

    def mean_radius(self):
        return sum((r[3] + r[4]) / 2 for r in self.rings) / len(self.rings)

    def point(self, theta, t, off=0.0):
        cu, cv, ru, rv = self.ring(t)
        x, y = superellipse(theta, ru, rv, self.n)
        radial = Vector((math.cos(theta) * rv, math.sin(theta) * ru))  # approx. normal of the ellipse
        radial.normalize()
        return (self.o + self.d * t + self.u * (cu + x + radial.x * off)
                + self.v * (cv + y + radial.y * off))


def _inside(poly, x, y):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            c = not c
        j = i
    return c


def _closest_on_poly(poly, x, y):
    best, bd = (x, y), 1e9
    for i in range(len(poly)):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % len(poly)]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        k = 0.0 if L < 1e-12 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L))
        px, py = ax + dx * k, ay + dy * k
        d = (px - x) ** 2 + (py - y) ** 2
        if d < bd:
            best, bd = (px, py), d
    return best


def outline_plate(name, surf, outline, off, cell=0.013, holes=()):
    """Plate covering the (theta, t) polygon `outline` on `surf`.
    off: float or f(theta, t) -> offset from the surface (bulges, ridges, flares).
    Grid-sampled; boundary vertices are snapped onto the outline so edges stay clean."""
    R = surf.mean_radius()
    xs = [p[0] * R for p in outline]   # work in ~metric units (theta * R)
    ys = [p[1] for p in outline]
    poly = list(zip(xs, ys))
    hp = [[(p[0] * R, p[1]) for p in h] for h in holes]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    nx = max(2, int(math.ceil((x1 - x0) / cell)))
    ny = max(2, int(math.ceil((y1 - y0) / cell)))
    gx = [x0 + (x1 - x0) * i / nx for i in range(nx + 1)]
    gy = [y0 + (y1 - y0) * j / ny for j in range(ny + 1)]

    def ok(x, y):
        return _inside(poly, x, y) and not any(_inside(h, x, y) for h in hp)

    # a cell is kept when its center is inside; its corners are then snapped
    keep = {}
    for i in range(nx):
        for j in range(ny):
            cx, cy = (gx[i] + gx[i + 1]) / 2, (gy[j] + gy[j + 1]) / 2
            if ok(cx, cy):
                keep[(i, j)] = True
    used = {}
    for (i, j) in keep:
        for c in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
            used[c] = used.get(c, 0) + 1
    bm = bmesh.new()
    vmap = {}
    for (i, j), cnt in used.items():
        x, y = gx[i], gy[j]
        boundary = cnt < 4 or not ok(x, y)
        if boundary:
            cands = [_closest_on_poly(poly, x, y)] + [_closest_on_poly(h, x, y) for h in hp]
            x, y = min(cands, key=lambda p: (p[0] - x) ** 2 + (p[1] - y) ** 2)
        th, t = x / R, y
        o = off(th, t) if callable(off) else off
        vmap[(i, j)] = bm.verts.new(surf.point(th, t, o))
    for (i, j) in keep:
        q = [vmap[(i, j)], vmap[(i + 1, j)], vmap[(i + 1, j + 1)], vmap[(i, j + 1)]]
        try:
            bm.faces.new(q)
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=1e-5)
    _orient_outward(bm, surf.o, surf.d)
    return _to_object(bm, name)


def poly_ellipse(ct, cth, rt, rth, n=24, rot=0.0):
    """Ellipse outline in (theta, t) — rth in radians, rt in meters."""
    out = []
    for i in range(n):
        a = TAU * i / n
        x, y = math.cos(a) * rth, math.sin(a) * rt
        out.append((cth + x * math.cos(rot) - y * math.sin(rot), ct + x * math.sin(rot) + y * math.cos(rot)))
    return out


def zigzag(p0, p1, teeth, depth):
    """Points from p0 to p1 (exclusive of p1) with `teeth` triangular teeth,
    tips displaced by `depth` along +t."""
    out = []
    for k in range(teeth):
        a = k / teeth
        b = (k + 0.5) / teeth
        out.append((p0[0] + (p1[0] - p0[0]) * a, p0[1] + (p1[1] - p0[1]) * a))
        out.append((p0[0] + (p1[0] - p0[0]) * b, p0[1] + (p1[1] - p0[1]) * b + depth))
    return out


def bump(th, t, cth, ct, wth, wt):
    """Smooth dome falloff (1 at the center, 0 outside the ellipse)."""
    q = ((th - cth) / wth) ** 2 + ((t - ct) / wt) ** 2
    return max(0.0, 1.0 - q) ** 1.5
