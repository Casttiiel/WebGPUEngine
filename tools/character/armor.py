"""Procedural Shardplate on the mannequin skeleton.

  blender -b --python armor.py -- <character.gltf> <out_dir> [preview]

Builds every plate as its own object tagged with its bone (see lib.py), then
optionally renders a turnaround to <out_dir>/preview.png and saves armor.blend.
The undersuit renders magenta in the preview: any magenta is a coverage hole.
"""
import bpy, sys, os, math
sys.path.insert(0, os.path.dirname(__file__))
import lib
from lib import Vector, Matrix, TAU, loft, plate, frame, lr
import preview

argv = sys.argv[sys.argv.index('--') + 1:]
GLTF, OUT = argv[0], argv[1]
DO_PREVIEW = 'preview' in argv

lib.clear()
arm, body = lib.import_mannequin(GLTF)
S = lib.BodySampler(body)
H = lambda b: lib.bone_head(arm, b)
T = lambda b: lib.bone_tail(arm, b)
PI = math.pi
FRONT = PI / 2           # torso/arm lofts: angle pi/2 points to -Y (front)

# ── Torso ───────────────────────────────────────────────────────────────────
TORSO = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r', 'neck_01']
tpts = S.points(TORSO)
Z0, UX, VF = Vector((0, 0, 0)), Vector((1, 0, 0)), Vector((0, -1, 0))
DZ = Vector((0, 0, 1))


def tfit(z, band=0.025):
    f = S.ring_fit([p for p in tpts if abs(p.x) < 0.2], Z0, DZ, UX, VF, z, band)
    return f


def torso_ring(z, grow_u, grow_v, add, **kw):
    cu, cv, hu, hv = tfit(z)
    r = dict(t=z, cu=0.0, cv=cv + kw.pop('shift', 0.0), ru=hu * grow_u + add, rv=hv * grow_v + add)
    r.update(kw)
    return r


def sleeve(name, origin, d_, u_, v_, pts, ts, add=0.012, n=2.2, seg=24):
    """Flexible joint cover: fitted tube whose weights come from the body, so it
    bends with the skin under the rigid plates and nothing shows through."""
    rings = []
    for t in ts:
        cu_, cv_, hu, hv = S.ring_fit(pts, origin, d_, u_, v_, t)
        rings.append(dict(t=t, cu=cu_, cv=cv_, ru=hu + add, rv=hv + add, n=n))
    ob = loft(name, origin, d_, u_, v_, rings, seg=seg)
    ob["sleeve"] = True
    return plate(ob, '@transfer', thick=0.004, bevel=0.0015, segs=1)


# Cuirass: fitted barrel, soft keel, V hem; one shell (breast + back) on spine_03.
CU = [  # (z, grow_u, grow_v, add, extra)
    (1.215, 1.0, 1.0, 0.02, dict(dip=-0.045, dip_at=FRONT, dip_w=5)),
    (1.27, 1.0, 1.02, 0.02, {}),
    (1.33, 1.01, 1.04, 0.021, {}),
    (1.39, 1.02, 1.04, 0.022, {}),
    (1.44, 1.03, 1.0, 0.022, {}),
]
cu_rings = [torso_ring(z, gu, gv, ad, n=2.5, ridge=0.008, ridge_at=FRONT, ridge_w=3, **ex)
            for z, gu, gv, ad, ex in CU]
cuirass = loft('cuirass', Z0, DZ, UX, VF, cu_rings + [
    dict(t=1.485, cv=0.0, ru=0.205, rv=0.125, n=2.6),   # broad over the shoulders
    dict(t=1.515, cv=0.0, ru=0.13, rv=0.095, n=2.3),
], seg=44)
plate(cuirass, 'spine_03', thick=0.008, bevel=0.003)

# Breastplate: the raised shield covering the whole front of the chest,
# collar to a V point over the belly (reference), laid 1 cm over the cuirass.
bp_rings = [torso_ring(z, gu, gv, ad + 0.009, n=2.5, ridge=0.012, ridge_at=FRONT, ridge_w=3)
            for z, gu, gv, ad, ex in CU[1:]]
first = torso_ring(1.235, 1.0, 1.0, 0.03, n=2.5, ridge=0.01, ridge_at=FRONT, ridge_w=3,
                   dip=-0.07, dip_at=FRONT, dip_w=3)
last = dict(t=1.478, cv=0.0, ru=0.20, rv=0.135, n=2.6, ridge=0.006, ridge_at=FRONT, ridge_w=3)
breast = loft('breastplate', Z0, DZ, UX, VF, [first] + bp_rings + [last], seg=26,
              arc=(FRONT - 1.15, FRONT + 1.15))
plate(breast, 'spine_03', thick=0.007, bevel=0.003)

# Abdomen lames: overlapping hoops tucked under the breastplate
lames = [(1.225, 1.17, 'spine_02'), (1.18, 1.125, 'spine_01'), (1.135, 1.08, 'spine_01'), (1.09, 1.035, 'pelvis')]
for i, (zt, zb, bone) in enumerate(lames):
    rt = torso_ring(zt, 1.0, 1.0, 0.02 - i * 0.001, n=2.4)
    rb = torso_ring(zb, 1.0, 1.0, 0.015 - i * 0.001, n=2.4)
    rt['t'], rb['t'] = zt, zb
    ob = loft(f'lame_{i}', Z0, DZ, UX, VF, [rb, rt], seg=36)
    plate(ob, bone, thick=0.006, bevel=0.0025)

# Gorget: collar from the helmet rim down over the shoulders; blends neck/spine
neck_pts = [p for p in S.points(TORSO + ['Head']) if abs(p.x) < 0.2]
g_rings = []
for z, add in ((1.455, 0.03), (1.49, 0.022), (1.525, 0.016), (1.59, 0.016)):
    cu_, cv_, hu, hv = S.ring_fit(neck_pts, Z0, DZ, UX, VF, z, band=0.015)
    g_rings.append(dict(t=z, cv=cv_, ru=hu + add, rv=hv + add, n=2.3))
gorget = loft('gorget', Z0, DZ, UX, VF, g_rings, seg=32)
plate(gorget, '@transfer', thick=0.007, bevel=0.003)

# ── Helmet (Head bone): armet shape fitted to the head ─────────────────────
hpts = [p for b, ps in S.by_bone.items() for p in ps if p.z > 1.54 and abs(p.x) < 0.14]


# Head slices -> one common center, radii grown to stay enclosing, then a convex
# envelope along z so the shell reads as a smooth armet, not a face mask.
HZ = [1.56 + 0.03 * i for i in range(9)]          # 1.56 .. 1.80
fits = [S.ring_fit(hpts, Z0, DZ, UX, VF, z, band=0.015, n=2.4) for z in HZ]
cv0 = sum(f[1] for f in fits) / len(fits)
RU = [f[2] + abs(f[0]) for f in fits]
RV = [f[3] + abs(f[1] - cv0) for f in fits]
for _ in range(4):
    for R in (RU, RV):
        for i in range(1, len(R) - 1):
            R[i] = max(R[i], 0.5 * (R[i - 1] + R[i + 1]))
HADD = 0.02


def keel(z):  # sharp visor keel over the lower face, fading out at the brow
    return 0.03 * max(0.0, min(1.0, (1.745 - z) / 0.06)) * max(0.0, min(1.0, (z - 1.545) / 0.04))


def helm_ring(i, extra=0.0, **kw):
    r = dict(t=HZ[i], cv=cv0, ru=RU[i] + HADD + extra, rv=RV[i] + HADD + extra, n=2.4,
             ridge=keel(HZ[i]), ridge_at=FRONT, ridge_w=16)
    r.update(kw)
    return r


helm_rings = [dict(helm_ring(0, 0.008), t=1.535)] + [helm_ring(i) for i in range(len(HZ))]
top = helm_rings[-1]
for t, k in ((1.83, 0.88), (1.855, 0.66), (1.872, 0.34)):
    helm_rings.append(dict(t=t, cv=cv0, ru=top['ru'] * k, rv=top['rv'] * k, n=2.2))
helm = loft('helmet', Z0, DZ, UX, VF, helm_rings, seg=48, cap_end=True)
plate(helm, 'Head', thick=0.008, bevel=0.003)

# Brow band: raised strip wrapping the front at eye level
ib = HZ.index(min(HZ, key=lambda z: abs(z - 1.74)))
brow = loft('helm_brow', Z0, DZ, UX, VF, [
    helm_ring(ib, 0.005, t=1.728, ridge=0.0),
    helm_ring(ib, 0.004, t=1.752, ridge=0.0),
], seg=32, arc=(FRONT - 1.75, FRONT + 1.75))
plate(brow, 'Head', thick=0.006, bevel=0.002)

# Eye slits: two banks of three either side of the keel, just under the brow
ie = HZ.index(min(HZ, key=lambda z: abs(z - 1.70)))
front_y = -(cv0 + RV[ie] + HADD)
for side in (-1, 1):
    for i, z in enumerate((1.684, 1.700, 1.716)):
        ob = lib.box(f'visor_slit_{"rl"[side > 0]}{i}', Vector((side * 0.045, front_y + 0.008, z)),
                     (0.044 - i * 0.004, 0.03, 0.0075))
        ob["slit"] = True
        plate(ob, 'Head', thick=0, bevel=0.0012, segs=1)

# ── Arms (built on the left, mirrored) ─────────────────────────────────────
sh = H('upperarm_l')
el = H('lowerarm_l')
wr = H('hand_l')
AX = Vector((1, 0, 0))
d, u, v = frame(AX, up_hint=Vector((0, 0, 1)))   # u = up, v = front
apts = S.points(['upperarm_l'])
fpts = S.points(['lowerarm_l'])
L_ua = (el - sh).length
L_fa = (wr - el).length


def afit(pts, origin, t, band=0.02):
    return S.ring_fit(pts, origin, d, u, v, t, band)


# Joint sleeves: shoulder/armpit and elbow
sleeve('shoulder_sleeve_l', sh, d, u, v, S.points(['upperarm_l', 'clavicle_l']), (-0.05, 0.0, 0.06, 0.13), add=0.012)
sleeve('elbow_sleeve_l', sh, d, u, v, S.points(['upperarm_l', 'lowerarm_l']),
       (L_ua - 0.07, L_ua - 0.02, L_ua + 0.03, L_ua + 0.08), add=0.011)

# Pauldron: rounded lames hanging over the shoulder (top arc), on the upper arm
P_ARC = (-PI * 0.64, PI * 0.64)   # angle 0 = up: from under-back, over the top, to under-front
pl = [  # (t start, t end, radius, vertical lift)
    (-0.06, 0.07, 0.148, 0.032),
    (0.02, 0.115, 0.140, 0.018),
    (0.07, 0.16, 0.128, 0.006),
    (0.115, 0.20, 0.115, -0.004),
]
for i, (t0, t1, r, lift) in enumerate(pl):
    tm = (t0 + t1) / 2
    rings = [  # bulged profile: narrower at both edges, so each lame reads rounded
        dict(t=t0, cu=lift, ru=r * 0.90, rv=r * 0.92, n=2.2),
        dict(t=t0 + (tm - t0) * 0.5, cu=lift + 0.004, ru=r * 0.98, rv=r * 0.99, n=2.2),
        dict(t=tm, cu=lift + 0.005, ru=r, rv=r * 1.01, n=2.2),
        dict(t=t1 - (t1 - tm) * 0.4, cu=lift + 0.004, ru=r * 0.995, rv=r * 1.0, n=2.2),
        dict(t=t1, cu=lift, ru=r * 0.95, rv=r * 0.96, n=2.2),
    ]
    ob = loft(f'pauldron_{i}_l', sh, d, u, v, rings, seg=28, arc=P_ARC)
    plate(ob, 'upperarm_l', thick=0.008, bevel=0.003)

# Dome + rim + haute-piece (upright neck guard) ride the clavicle, so raising
# the arm slides the lames under them instead of driving them into the helmet.
DC = sh + Vector((-0.015, 0.0, 0.04))
dome = lib.sphere_cap('pauldron_dome_l', DC, 0.132, scale=(1.0, 0.95, 0.78), lat=(0.0, PI * 0.42), seg=32, rings=8)
plate(dome, 'clavicle_l', thick=0.009, bevel=0.003)
rim = lib.sphere_cap('pauldron_rim_l', DC, 0.137, scale=(1.0, 0.95, 0.78), lat=(PI * 0.37, PI * 0.43), seg=32, rings=1)
plate(rim, 'clavicle_l', thick=0.012, bevel=0.003)
hx = DC.x - 0.075
haute = loft('pauldron_haute_l', Vector((hx, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)), Vector((1, 0, 0)), [
    dict(t=-0.10, cu=DC.z + 0.075, ru=0.012, rv=0.004, n=2.0),
    dict(t=-0.06, cu=DC.z + 0.10, ru=0.032, rv=0.005, n=2.0),
    dict(t=0.0, cu=DC.z + 0.112, ru=0.042, rv=0.005, n=2.0),
    dict(t=0.06, cu=DC.z + 0.10, ru=0.032, rv=0.005, n=2.0),
    dict(t=0.10, cu=DC.z + 0.075, ru=0.012, rv=0.004, n=2.0),
], seg=16, cap_start=True, cap_end=True)
plate(haute, 'clavicle_l', thick=0, bevel=0.002)

# Rerebrace (upper-arm tube under the pauldron, overlapping the elbow)
rings = []
for t in (0.08, 0.16, L_ua - 0.04, L_ua + 0.012):
    cu_, cv_, hu, hv = afit(apts, sh, min(t, L_ua - 0.02))
    rings.append(dict(t=t, cu=cu_, cv=cv_, ru=hu + 0.02, rv=hv + 0.02, n=2.2))
ob = loft('rerebrace_l', sh, d, u, v, rings, seg=24)
plate(ob, 'upperarm_l', thick=0.006, bevel=0.0025)

# Couter: elbow cap (elbow points +Y / back in T-pose)
couter = lib.sphere_cap('couter_l', el + Vector((0.0, 0.022, 0.0)), 0.07, scale=(1.25, 1.0, 0.8),
                        lat=(0.0, PI * 0.5), seg=24, rings=8, rot=Matrix.Rotation(-PI / 2, 3, 'X'))
plate(couter, 'lowerarm_l', thick=0.008, bevel=0.003)

# Vambrace: from the elbow to a flared wrist, two overlapping plates
for k, (ta, tb) in enumerate(((0.015, 0.14), (0.125, L_fa + 0.01))):
    rings = []
    for t in (ta, (ta + tb) / 2, tb):
        cu_, cv_, hu, hv = afit(fpts, el, min(max(t, 0.03), L_fa - 0.02))
        flare = 0.01 * max(0.0, (t - L_fa * 0.7) / (L_fa * 0.3))
        g = 0.018 + k * 0.004 + flare
        rings.append(dict(t=t, cu=cu_, cv=cv_, ru=hu + g, rv=hv + g, n=2.3))
    ob = loft(f'vambrace_{k}_l', el, d, u, v, rings, seg=24)
    plate(ob, 'lowerarm_l', thick=0.006, bevel=0.0025)

# Gauntlet cuff (flared bell over the wrist)
ob = loft('gauntlet_cuff_l', wr, d, u, v, [
    dict(t=-0.05, ru=0.052, rv=0.055, n=2.4),
    dict(t=0.0, ru=0.062, rv=0.066, n=2.4),
    dict(t=0.025, ru=0.068, rv=0.072, n=2.4),
], seg=24)
plate(ob, 'lowerarm_l', thick=0.006, bevel=0.0025)

# Hand: closed shell from the wrist to the knuckles
hand_pts = S.points(['hand_l'])
L_h = (H('middle_01_l') - wr).dot(d)
rings = []
for t in (0.0, L_h * 0.5, L_h + 0.028):
    cu_, cv_, hu, hv = afit(hand_pts, wr, min(t, L_h))
    shrink = 0.004 if t > L_h else 0.0   # knuckle guard tucks over the finger bases
    rings.append(dict(t=t, cu=cu_ + 0.002, cv=cv_, ru=hu + 0.012 - shrink, rv=hv + 0.012 - shrink, n=3.0))
ob = loft('gauntlet_hand_l', wr, d, u, v, rings, seg=24)
plate(ob, 'hand_l', thick=0.005, bevel=0.002)

# Finger segments: a boxy tube per phalanx; the last one runs to the fingertip
FINGERS = ['index', 'middle', 'ring', 'pinky', 'thumb']
for f in FINGERS:
    for k in (1, 2, 3):
        bn = f'{f}_0{k}_l'
        if bn not in arm.data.bones:
            continue
        h, tl = H(bn), T(bn)
        if k == 3 and f'{f}_04_leaf_l' in arm.data.bones:
            tl = T(f'{f}_04_leaf_l')
        fd = (tl - h)
        if fd.length < 1e-4:
            continue
        fd_, fu, fv = frame(fd, up_hint=Vector((0, 0, 1)))
        fpts_ = S.points([bn] + ([f'{f}_04_leaf_l'] if k == 3 else []))
        rings = []
        for t in (-0.007, fd.length * 0.5, fd.length + (0.009 if k == 3 else 0.004)):
            fit = S.ring_fit(fpts_, h, fd_, fu, fv, min(max(t, 0.0), fd.length), n=3.0) if fpts_ else None
            cu_, cv_, ru_, rv_ = fit or (0.0, 0.0, 0.011, 0.011)
            rings.append(dict(t=t, cu=cu_, cv=cv_, ru=ru_ + 0.004, rv=rv_ + 0.004, n=3.0))
        ob = loft(f'finger_{f}{k}_l', h, fd_, fu, fv, rings, seg=12, cap_end=(k == 3))
        plate(ob, bn, thick=0.003, bevel=0.0012, segs=1)

# ── Waist down: traced from the reference (legs.py) ────────────────────
import legs
legs.build(S, H, T, sleeve)

# ── Mirror left -> right ───────────────────────────────────────────────────
for ob in list(bpy.data.objects):
    if ob.type == 'MESH' and ob.name.endswith('_l'):
        lib.mirror_x(ob, lr)

# ── Undersuit: the mannequin body itself, slightly inflated ───────────────
body.name = 'undersuit'
body["bone"] = '@body'
m = body.modifiers.new('inflate', 'DISPLACE')
m.strength = 0.004
m.mid_level = 0.0
# the armature modifier must not deform the rest pose preview
for mod in body.modifiers:
    if mod.type == 'ARMATURE':
        mod.show_render = False
        mod.show_viewport = False


# Material colors for the blockout preview
def mat(name, rgb):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    return m


M_PLATE = mat('plate', (0.12, 0.28, 0.62))
M_DARK = mat('dark', (0.05, 0.05, 0.06))
M_SUIT = mat('suit', (1.0, 0.0, 1.0))   # magenta: any visible undersuit is a coverage hole
M_SLEEVE = mat('sleeve', (0.07, 0.15, 0.32))
for ob in bpy.data.objects:
    if ob.type != 'MESH':
        continue
    ob.data.materials.clear()
    if ob.name == 'undersuit':
        ob.data.materials.append(M_SUIT)
    elif ob.get('sleeve'):
        ob.data.materials.append(M_SLEEVE)
    elif ob.get('slit') or ob.name.startswith(('belt', 'sabaton_sole')):
        ob.data.materials.append(M_DARK)
    else:
        ob.data.materials.append(M_PLATE)

os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'armor.blend'))
if DO_PREVIEW:
    preview.render_views(os.path.join(OUT, 'preview.png'), hide=('Armature',))
if 'legs' in argv:  # waist-down turnaround
    preview.render_views(os.path.join(OUT, 'legs.png'), views=('front', 'side', 'back', 'threeq'),
                         center=Vector((0, 0, 0.55)), ortho=1.2, res=560)
if 'zoom' in argv:  # close-ups: head, left hand, feet
    preview.render_views(os.path.join(OUT, 'zoom_head.png'), views=('front', 'side', 'threeq'),
                         center=Vector((0, 0, 1.6)), ortho=0.75, res=480)
    preview.render_views(os.path.join(OUT, 'zoom_hand.png'), views=('front', 'top', 'threeq'),
                         center=Vector((0.8, 0, 1.44)), ortho=0.4, res=420)
    preview.render_views(os.path.join(OUT, 'zoom_feet.png'), views=('front', 'side', 'threeq', 'back'),
                         center=Vector((0, 0, 0.25)), ortho=0.7, res=420)
print("PIECES", sum(1 for o in bpy.data.objects if o.type == 'MESH'))
