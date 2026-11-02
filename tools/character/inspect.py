import bpy, sys, json
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=sys.argv[-1])
out = {}
for ob in bpy.data.objects:
    print("OBJ", ob.name, ob.type, tuple(round(v,3) for v in ob.location), tuple(round(v,3) for v in ob.rotation_euler), tuple(round(v,3) for v in ob.dimensions))
    if ob.type == 'ARMATURE':
        for b in ob.data.bones:
            h = ob.matrix_world @ b.head_local; t = ob.matrix_world @ b.tail_local
            out[b.name] = [[round(x,4) for x in h],[round(x,4) for x in t], b.parent.name if b.parent else None]
json.dump(out, open("bones.json","w"), indent=0)
for k in ["pelvis","spine_01","spine_03","neck_01","Head","clavicle_l","upperarm_l","lowerarm_l","hand_l","thigh_l","calf_l","foot_l","ball_l"]:
    print(k, out[k][0], out[k][1])
