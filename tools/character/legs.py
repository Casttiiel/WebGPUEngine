"""Waist-down Shardplate, traced from the reference sheet.

Called from armor.py with the shared context. Left-side pieces end in _l and are
mirrored by armor.py; centered pieces (belt, scale panel, culet) are built whole.

Pieces (reference):
  belt + buckle plate
  front panel of pointed scales between the legs
  tassets: five flared lames over each hip, toothed hem on the last one
  culet: two rows of tall pointed tiles over the backside
  cuisse with an arched hem over the knee + three articulated lames above the knee
  poleyn: teardrop knee cop running down the shin, round boss, sickle wing outside
  greave: central ridge, rimmed edges, stepped lames down the back of the calf
  sabaton: pointed shoe, ribbed ankle cuff, three diagonal straps, toe cap, cleated sole
"""
import math
from mathutils import Vector
import lib
from lib import Surf, outline_plate, plate, frame, bump, zigzag, poly_ellipse

PI = math.pi


def build(S, H, T, sleeve):
    built = []

    def P(ob, bone, **kw):
        plate(ob, bone, **kw)
        built.append(ob)
        return ob

    # ── Hip surface: around the pelvis + both thighs, t grows downward ─────
    WAIST = 1.045
    ho = Vector((0, 0, WAIST))
    hd, hu, hv = Vector((0, 0, -1)), Vector((0, -1, 0)), Vector((-1, 0, 0))
    # theta 0 = front, +pi/2 = character's right (-X), -pi/2 = character's left (+X)
    hip_pts = [p for p in S.points(['pelvis', 'spine_01', 'thigh_l', 'thigh_r']) if 0.55 < p.z < 1.1]
    hs = Surf.fit(hip_pts, ho, hd, hu, hv, 0.0, 0.46, step=0.01, add=0.016, n=2.6, smooth=3)

    # Belt (dark leather) + buckle plate
    P(outline_plate('belt', hs, [(-PI, 0.0), (PI, 0.0), (PI, 0.05), (-PI, 0.05)], 0.004), '@transfer',
      thick=0.006, bevel=0.002)
    P(outline_plate('waist_buckle', hs, poly_ellipse(0.026, 0.0, 0.032, 0.28, n=28),
                    lambda th, t: 0.012 + 0.008 * bump(th, t, 0.0, 0.026, 0.3, 0.034)), '@transfer',
      thick=0.005, bevel=0.002)

    bk = P(outline_plate('scale_backing', hs, [(-0.66, 0.04), (0.66, 0.04), (0.66, 0.40), (0.0, 0.43), (-0.66, 0.40)],
                         0.006, cell=0.01), '@transfer', thick=0.003, bevel=0.0)
    bk["sleeve"] = True

    # Front panel: staggered rows of pointed scales, each row tucked under the one above
    PANEL = 0.62            # half-width in theta
    rows = 8
    pitch = 0.042
    sh_h, sh_w = 0.064, 0.052
    for r in range(rows):
        t_top = 0.045 + r * pitch
        R = sum(hs.ring(t_top + sh_h / 2)[2:]) / 2
        dth = sh_w / R
        k0 = -int(PANEL / dth) - 1
        for k in range(k0, -k0 + 1):
            cth = (k + (0.5 if r % 2 else 0.0)) * dth
            if abs(cth) + dth * 0.3 > PANEL:
                continue
            w = dth * 0.5
            outline = [(cth - w, t_top), (cth + w, t_top), (cth + w, t_top + sh_h * 0.5),
                       (cth, t_top + sh_h), (cth - w, t_top + sh_h * 0.5)]
            off = (lambda tt, base: (lambda th, t: base + 0.009 * (t - tt) / sh_h))(t_top, 0.01 + 0.0015 * r)
            P(outline_plate(f'scale_{r}_{k}', hs, outline, off, cell=0.01), '@transfer',
              thick=0.004, bevel=0.0012, segs=1)

    # Tassets (left; mirrored): five flared lames hung on their own hip->thigh
    # surface so they follow the leg instead of boxing both legs in.
    A = Vector((0.10, 0.0, WAIST))
    kd, ku, kv = frame(H('calf_l') - A, up_hint=Vector((0, -1, 0)))   # ku front, kv inner
    side_pts = [p for p in S.points(['pelvis', 'spine_01', 'thigh_l']) if p.x > 0.03 and 0.6 < p.z < 1.1]
    ks = Surf.fit(side_pts, A, kd, ku, kv, 0.0, 0.42, add=0.02, n=2.4, smooth=3)
    TF, TB = -0.3, -2.45        # front edge leaves room for the scale panel; back edge (0 = front of thigh)
    for k in range(5):
        t0 = 0.045 + k * 0.062
        t1 = t0 + 0.078
        if k == 4:   # toothed hem (reference, front view)
            hem = zigzag((TB, t1), (TF, t1), 14, 0.018)
            outline = [(TF, t0), (TB, t0)] + hem + [(TF, t1)]
        else:
            outline = [(TF, t0), (TB, t0), (TB, t1), (TF + 0.04, t1), (TF, t1 - 0.02)]
        off = (lambda a, b: (lambda th, t: 0.006 + 0.004 * b + 0.016 * (t - a) / 0.078))(t0, k)
        P(outline_plate(f'tasset_{k}_l', ks, outline, off, cell=0.012), '@transfer',
          thick=0.005, bevel=0.002)

    # Culet: two rows of tall pointed tiles over the backside, upper row outside
    for row, (t0, h, n, base) in enumerate(((0.05, 0.17, 6, 0.02), (0.18, 0.18, 5, 0.012))):
        R = sum(hs.ring(t0 + h / 2)[2:]) / 2
        dth = 0.085 / R
        for k in range(n):
            cth = PI + (k - (n - 1) / 2) * dth
            w = dth * 0.47
            outline = [(cth - w, t0), (cth + w, t0), (cth + w, t0 + h * 0.72), (cth, t0 + h),
                       (cth - w, t0 + h * 0.72)]
            off = (lambda a, b: (lambda th, t: b + 0.014 * (t - a) / h))(t0, base)
            P(outline_plate(f'culet_{row}_{k}', hs, outline, off, cell=0.012), '@transfer',
              thick=0.005, bevel=0.002)

    sleeve('hip_sleeve', ho, hd, hu, hv, hip_pts, (0.0, 0.08, 0.16, 0.22), add=0.01, seg=36)

    # ── Leg surfaces (left) ─────────────────────────────────────────────────
    hip, knee, ank = H('thigh_l'), H('calf_l'), H('foot_l')
    td, tu, tv = frame(knee - hip, up_hint=Vector((0, -1, 0)))     # tu front, tv inner (-X)
    cd, cu_, cv = frame(ank - knee, up_hint=Vector((0, -1, 0)))
    L_th, L_cf = (knee - hip).length, (ank - knee).length
    # theta: 0 front, +pi/2 inner, -pi/2 outer
    ts = Surf.fit(S.points(['thigh_l']), hip, td, tu, tv, 0.08, L_th + 0.04, add=0.016, n=2.3)
    ss = Surf.fit(S.points(['calf_l']), knee, cd, cu_, cv, -0.08, L_cf, add=0.016, n=2.3,
                  fallback=lambda t: None)

    sleeve('knee_sleeve_l', hip, td, tu, tv, S.points(['thigh_l', 'calf_l']),
           (L_th - 0.09, L_th - 0.03, L_th + 0.03, L_th + 0.09), add=0.016)
    sleeve('ankle_sleeve_l', knee, cd, cu_, cv, S.points(['calf_l', 'foot_l']),
           (L_cf - 0.1, L_cf - 0.05, L_cf - 0.005), add=0.009)

    # Cuisse: full tube, top hidden under the tassets, hem arched over the knee
    hem = [(th, L_th - 0.07 - 0.03 * math.cos(th) ** 2 * (1 if abs(th) < PI / 2 else 0))
           for th in [PI - 2 * PI * i / 40 for i in range(41)]]
    cuisse = [(-PI, 0.12), (PI, 0.12)] + hem
    P(outline_plate('cuisse_l', ts, cuisse, lambda th, t: 0.004 + 0.007 * max(0.0, math.cos(th)) ** 8),
      'thigh_l', thick=0.006, bevel=0.0025)

    # Articulated lames above the knee (front + sides), ribbed look of the reference
    for k in range(3):
        t0 = L_th - 0.095 + 0.026 * k
        t1 = t0 + 0.032
        W = 2.05
        outline = [(-W, t0), (W, t0), (W, t1), (-W, t1)]
        off = (lambda a, b: (lambda th, t: 0.011 + 0.003 * b + 0.007 * (t - a) / 0.032))(t0, k)
        P(outline_plate(f'knee_lame_{k}_l', ts, outline, off, cell=0.01), '@transfer',
          thick=0.004, bevel=0.0015, segs=1)

    # Poleyn: teardrop cop from just above the knee down the upper shin
    def cop_off(th, t):
        return 0.022 + 0.04 * bump(th, t, 0.0, 0.0, 1.35, 0.13) + 0.006 * max(0.0, math.cos(th)) ** 24 * (t > 0.03)

    top = [(1.2 * math.cos(a), 0.02 - 0.075 * math.sin(a)) for a in [PI * i / 16 for i in range(17)]]
    top = [(-x, y) for x, y in top]                       # from outer (-) over the top to inner (+)
    down = [(1.2 - 1.2 * s ** 0.8, 0.02 + 0.17 * s) for s in [i / 10 for i in range(1, 11)]]
    up = [(-x, y) for x, y in reversed(down[:-1])]
    cop = top + down + up
    P(outline_plate('poleyn_l', ss, cop, cop_off, cell=0.01), 'calf_l', thick=0.007, bevel=0.0025)

    # Round boss on the cop (front-outer)
    bth, bt = -0.22, 0.0
    R_s = ss.mean_radius()
    P(outline_plate('poleyn_boss_l', ss, poly_ellipse(bt, bth, 0.04, 0.04 / R_s, n=32),
                    lambda th, t: cop_off(th, t) + 0.008 + 0.012 * bump(th, t, bth, bt, 0.042 / R_s, 0.042)),
      'calf_l', thick=0.005, bevel=0.002)

    # Sickle wing rising from the outer side of the knee
    outer = [(-2.15, 0.10), (-2.25, 0.02), (-2.2, -0.06), (-2.02, -0.13), (-1.75, -0.18)]
    inner = [(-1.72, -0.12), (-1.78, -0.05), (-1.62, 0.03), (-1.38, 0.10)]
    wing = outer + inner + [(-1.75, 0.13)]
    P(outline_plate('poleyn_wing_l', ss, wing,
                    lambda th, t: 0.035 + 0.03 * max(0.0, -t) / 0.18, cell=0.01), 'calf_l',
      thick=0.006, bevel=0.0025)

    # Greave front: central ridge, rims along both edges
    GW = 1.95
    g_top = [(th, 0.10 - 0.05 * math.cos(th) ** 2) for th in [-GW + 2 * GW * i / 20 for i in range(21)]]
    greave = g_top + [(GW, L_cf - 0.035), (-GW, L_cf - 0.035)]
    gfront = lambda th, t: 0.004 + 0.008 * max(0.0, math.cos(th)) ** 12
    P(outline_plate('greave_l', ss, greave, gfront), 'calf_l', thick=0.006, bevel=0.0025)
    for side in (-1, 1):
        a, b = side * (GW - 0.16), side * GW
        rim = [(min(a, b), 0.11), (max(a, b), 0.10), (max(a, b), L_cf - 0.045), (min(a, b), L_cf - 0.045)]
        P(outline_plate(f'greave_rim_{"io"[side < 0]}_l', ss, rim, lambda th, t: gfront(th, t) + 0.006,
                        cell=0.008), 'calf_l', thick=0.003, bevel=0.0012, segs=1)

    # Stepped lames down the back of the calf (stair silhouette)
    for k in range(4):
        t0 = 0.05 + 0.078 * k
        t1 = min(t0 + 0.095, L_cf - 0.03)
        BW = 1.42
        outline = [(PI - BW, t0), (PI + BW, t0), (PI + BW, t1), (PI - BW, t1)]
        off = (lambda a: (lambda th, t: 0.006 + 0.012 * (t - a) / 0.095))(t0)
        P(outline_plate(f'calf_lame_{k}_l', ss, outline, off, cell=0.012), 'calf_l',
          thick=0.005, bevel=0.002)

    # Ankle cuff with two raised ribs
    a0, a1 = L_cf - 0.07, L_cf + 0.0
    P(outline_plate('ankle_cuff_l', ss, [(-PI, a0), (PI, a0), (PI, a1), (-PI, a1)],
                    lambda th, t: 0.014 + 0.01 * (t - a0) / 0.07), '@transfer', thick=0.005, bevel=0.002)
    for k, tc in enumerate((a0 + 0.018, a0 + 0.042)):
        P(outline_plate(f'ankle_rib_{k}_l', ss, [(-PI, tc - 0.005), (PI, tc - 0.005), (PI, tc + 0.005), (-PI, tc + 0.005)],
                        lambda th, t: 0.02 + 0.01 * (t - a0) / 0.07, cell=0.008), '@transfer',
          thick=0.003, bevel=0.0012, segs=1)

    # ── Sabaton ─────────────────────────────────────────────────────────────
    heel = Vector((ank.x, ank.y + 0.075, 0.0))
    fd, fu, fv = frame(Vector((0, -1, 0)), up_hint=Vector((0, 0, 1)))   # fu up, fv inner (-X)
    foot_pts = S.points(['foot_l', 'ball_l'])
    toe = T('ball_l')
    L_ft = (toe - heel).dot(fd)
    fs = Surf.fit(foot_pts, heel, fd, fu, fv, 0.0, L_ft - 0.01, step=0.01, add=0.012, n=2.7, smooth=2)
    # keep the sole on the ground: lift each ring by the clearance it gained underneath
    fs.rings = [(t, c_u + 0.012, c_v, r_u, r_v) for t, c_u, c_v, r_u, r_v in fs.rings]
    last = fs.rings[-1]
    for dt, k in ((0.03, 0.72), (0.055, 0.42), (0.072, 0.12)):   # long pointed toe
        ru_, rv_ = last[3] * k, last[4] * k
        fs.rings.append((last[0] + dt, ru_ + 0.002, last[2], ru_, rv_))
    shell = lib.loft('sabaton_l', heel, fd, fu, fv,
                     [dict(t=t, cu=a, cv=b, ru=c, rv=e, n=2.7) for t, a, b, c, e in fs.rings],
                     seg=32, cap_start=True, cap_end=True)
    P(shell, '@transfer', thick=0.006, bevel=0.002)
    # three diagonal straps over the instep, running down to the sole near the toe
    for k, t0 in enumerate((0.10, 0.128, 0.156)):
        SW = 2.25
        cl = [(th, t0 + 0.05 * abs(th) / SW) for th in [-SW + 2 * SW * i / 24 for i in range(25)]]
        outline = [(th, t - 0.0075) for th, t in cl] + [(th, t + 0.0075) for th, t in reversed(cl)]
        P(outline_plate(f'sabaton_strap_{k}_l', fs, outline, 0.007, cell=0.007), '@transfer',
          thick=0.003, bevel=0.0012, segs=1)
    # toe cap with a V edge
    tt = fs.rings[-4][0] - 0.02
    cap = [(-1.9, tt + 0.03), (0.0, tt), (1.9, tt + 0.03), (1.9, fs.rings[-1][0]), (-1.9, fs.rings[-1][0])]
    P(outline_plate('sabaton_toecap_l', fs, cap, 0.003, cell=0.008), '@transfer', thick=0.003, bevel=0.0012, segs=1)
    # cleated sole: footprint outline with small bumps, slab on the ground
    left = [(t, c_v + r_v + 0.004) for t, c_u, c_v, r_u, r_v in fs.rings]
    right = [(t, c_v - r_v - 0.004) for t, c_u, c_v, r_u, r_v in fs.rings]
    foot_outline = left + list(reversed(right))
    bm = lib.bmesh.new()
    vs = []
    per = 0.0
    for i, (t, y) in enumerate(foot_outline):
        t2, y2 = foot_outline[(i + 1) % len(foot_outline)]
        seg = math.hypot(t2 - t, y2 - y)
        steps = max(1, int(seg / 0.006))
        for s in range(steps):
            a = s / steps
            pt = heel + fd * (t + (t2 - t) * a) + fv * (y + (y2 - y) * a)
            bumpy = 0.0025 if int((per + seg * a) / 0.012) % 2 else 0.0
            out = (pt - (heel + fd * (t + (t2 - t) * a))).normalized() if abs(y) > 1e-4 else fd
            pt = pt + out * bumpy
            vs.append(bm.verts.new((pt.x, pt.y, 0.0)))
        per += seg
    f = bm.faces.new(vs)
    if f.normal.z < 0:
        f.normal_flip()
    sole = lib.from_bmesh(bm, 'sabaton_sole_l')
    P(sole, '@transfer', thick=0.014, bevel=0.002)
    return built
