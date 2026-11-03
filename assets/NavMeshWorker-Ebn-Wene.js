(async ()=>{
    const K = [
        "Recast",
        "Detour",
        "DetourNavMeshBuilder",
        "DetourTileCacheBuilder",
        "NavMeshImporter",
        "NavMeshExporter",
        "CrowdUtils",
        "ChunkyTriMeshUtils",
        "RecastDebugDraw",
        "DetourDebugDraw"
    ], Q = [
        "rcConfig",
        "rcContext",
        "dtNavMeshParams",
        "dtNavMeshCreateParams",
        "RecastLinearAllocator",
        "RecastFastLZCompressor",
        "rcChunkyTriMesh",
        "dtTileCacheParams",
        "dtTileCacheLayerHeader",
        "Vec3",
        "BoolRef",
        "IntRef",
        "UnsignedIntRef",
        "UnsignedCharRef",
        "UnsignedShortRef",
        "FloatRef",
        "IntArray",
        "UnsignedIntArray",
        "UnsignedCharArray",
        "UnsignedShortArray",
        "FloatArray"
    ], r = {
        isNull: (s)=>r.Module.getPointer(s) === 0,
        destroy: (s)=>{
            r.Module.destroy(s);
        }
    }, o = {}, Z = async (s)=>{
        if (r.Module === void 0) {
            {
                const e = (await import("./recast-navigation.wasm-compat-DncuL3C6.js")).default;
                r.Module = await e();
            }
            for (const e of K)r[e] = new r.Module[e];
            for (const e of Q)r[e] = r.Module[e];
            o.RC_BORDER_REG = r.Recast.BORDER_REG, o.RC_MULTIPLE_REGS = r.Recast.MULTIPLE_REGS, o.RC_BORDER_VERTEX = r.Recast.BORDER_VERTEX, o.RC_AREA_BORDER = r.Recast.AREA_BORDER, o.RC_CONTOUR_REG_MASK = r.Recast.CONTOUR_REG_MASK, o.RC_MESH_NULL_IDX = r.Recast.MESH_NULL_IDX, o.RC_NULL_AREA = r.Recast.NULL_AREA, o.RC_WALKABLE_AREA = r.Recast.WALKABLE_AREA, o.RC_NOT_CONNECTED = r.Recast.NOT_CONNECTED, o.RC_CONTOUR_TESS_WALL_EDGES = r.Module.RC_CONTOUR_TESS_WALL_EDGES, o.RC_CONTOUR_TESS_AREA_EDGES = r.Module.RC_CONTOUR_TESS_AREA_EDGES, o.RC_LOG_PROGRESS = r.Module.RC_LOG_PROGRESS, o.RC_LOG_WARNING = r.Module.RC_LOG_WARNING, o.RC_LOG_ERROR = r.Module.RC_LOG_ERROR, o.RC_TIMER_TOTAL = r.Module.RC_TIMER_TOTAL, o.RC_TIMER_TEMP = r.Module.RC_TIMER_TEMP, o.RC_TIMER_RASTERIZE_TRIANGLES = r.Module.RC_TIMER_RASTERIZE_TRIANGLES, o.RC_TIMER_BUILD_COMPACTHEIGHTFIELD = r.Module.RC_TIMER_BUILD_COMPACTHEIGHTFIELD, o.RC_TIMER_BUILD_CONTOURS = r.Module.RC_TIMER_BUILD_CONTOURS, o.RC_TIMER_BUILD_CONTOURS_TRACE = r.Module.RC_TIMER_BUILD_CONTOURS_TRACE, o.RC_TIMER_BUILD_CONTOURS_SIMPLIFY = r.Module.RC_TIMER_BUILD_CONTOURS_SIMPLIFY, o.RC_TIMER_FILTER_BORDER = r.Module.RC_TIMER_FILTER_BORDER, o.RC_TIMER_FILTER_WALKABLE = r.Module.RC_TIMER_FILTER_WALKABLE, o.RC_TIMER_MEDIAN_AREA = r.Module.RC_TIMER_MEDIAN_AREA, o.RC_TIMER_FILTER_LOW_OBSTACLES = r.Module.RC_TIMER_FILTER_LOW_OBSTACLES, o.RC_TIMER_BUILD_POLYMESH = r.Module.RC_TIMER_BUILD_POLYMESH, o.RC_TIMER_MERGE_POLYMESH = r.Module.RC_TIMER_MERGE_POLYMESH, o.RC_TIMER_ERODE_AREA = r.Module.RC_TIMER_ERODE_AREA, o.RC_TIMER_MARK_BOX_AREA = r.Module.RC_TIMER_MARK_BOX_AREA, o.RC_TIMER_MARK_CYLINDER_AREA = r.Module.RC_TIMER_MARK_CYLINDER_AREA, o.RC_TIMER_MARK_CONVEXPOLY_AREA = r.Module.RC_TIMER_MARK_CONVEXPOLY_AREA, o.RC_TIMER_BUILD_DISTANCEFIELD = r.Module.RC_TIMER_BUILD_DISTANCEFIELD, o.RC_TIMER_BUILD_DISTANCEFIELD_DIST = r.Module.RC_TIMER_BUILD_DISTANCEFIELD_DIST, o.RC_TIMER_BUILD_DISTANCEFIELD_BLUR = r.Module.RC_TIMER_BUILD_DISTANCEFIELD_BLUR, o.RC_TIMER_BUILD_REGIONS = r.Module.RC_TIMER_BUILD_REGIONS, o.RC_TIMER_BUILD_REGIONS_WATERSHED = r.Module.RC_TIMER_BUILD_REGIONS_WATERSHED, o.RC_TIMER_BUILD_REGIONS_EXPAND = r.Module.RC_TIMER_BUILD_REGIONS_EXPAND, o.RC_TIMER_BUILD_REGIONS_FLOOD = r.Module.RC_TIMER_BUILD_REGIONS_FLOOD, o.RC_TIMER_BUILD_REGIONS_FILTER = r.Module.RC_TIMER_BUILD_REGIONS_FILTER, o.RC_TIMER_BUILD_LAYERS = r.Module.RC_TIMER_BUILD_LAYERS, o.RC_TIMER_BUILD_POLYMESHDETAIL = r.Module.RC_TIMER_BUILD_POLYMESHDETAIL, o.RC_TIMER_MERGE_POLYMESHDETAIL = r.Module.RC_TIMER_MERGE_POLYMESHDETAIL, o.RC_MAX_TIMERS = r.Module.RC_MAX_TIMERS, r.Detour.FAILURE, r.Detour.SUCCESS, r.Detour.IN_PROGRESS, r.Detour.STATUS_DETAIL_MASK, r.Detour.WRONG_MAGIC, r.Detour.WRONG_VERSION, r.Detour.OUT_OF_MEMORY, r.Detour.INVALID_PARAM, r.Detour.BUFFER_TOO_SMALL, r.Detour.OUT_OF_NODES, r.Detour.PARTIAL_RESULT, r.Detour.ALREADY_OCCUPIED, r.Detour.VERTS_PER_POLYGON, r.Detour.NAVMESH_MAGIC, r.Detour.NAVMESH_VERSION, r.Detour.NAVMESH_STATE_MAGIC, r.Detour.NAVMESH_STATE_VERSION, r.Detour.TILECACHE_MAGIC, r.Detour.TILECACHE_VERSION, r.Detour.TILECACHE_NULL_AREA, r.Detour.TILECACHE_WALKABLE_AREA, r.Detour.TILECACHE_NULL_IDX, r.Detour.NULL_LINK, r.Detour.NULL_LINK, r.Detour.EXT_LINK, r.Detour.OFFMESH_CON_BIDIR, r.Module.DT_STRAIGHTPATH_START, r.Module.DT_STRAIGHTPATH_END, r.Module.DT_STRAIGHTPATH_OFFMESH_CONNECTION, r.Module.DT_STRAIGHTPATH_AREA_CROSSINGS, r.Module.DT_STRAIGHTPATH_ALL_CROSSINGS, r.Module.DT_FINDPATH_ANY_ANGLE, r.Module.DT_RAYCAST_USE_COSTS, r.Module.DT_CROWDAGENT_STATE_INVALID, r.Module.DT_CROWDAGENT_STATE_WALKING, r.Module.DT_CROWDAGENT_STATE_OFFMESH, r.Module.DT_CROWDAGENT_TARGET_NONE, r.Module.DT_CROWDAGENT_TARGET_FAILED, r.Module.DT_CROWDAGENT_TARGET_VALID, r.Module.DT_CROWDAGENT_TARGET_REQUESTING, r.Module.DT_CROWDAGENT_TARGET_WAITING_FOR_QUEUE, r.Module.DT_CROWDAGENT_TARGET_WAITING_FOR_PATH, r.Module.DT_CROWDAGENT_TARGET_VELOCITY, r.Module.DT_COMPRESSEDTILE_FREE_DATA, r.Module.DT_TILE_FREE_DATA;
        }
    };
    class O {
        get size() {
            return this.raw.size;
        }
        constructor(e){
            this.raw = e;
        }
        get(e) {
            return this.raw.get(e);
        }
        set(e, t) {
            this.raw.set(e, t);
        }
        resize(e) {
            this.raw.resize(e);
        }
        copy(e) {
            this.raw.resize(e.length), this.getHeapView().set(e);
        }
        destroy() {
            r.destroy(this.raw);
        }
        getHeapView() {
            const e = this.getHeap();
            return new this.typedArrayClass(e.buffer, this.raw.getDataPointer(), this.size);
        }
        toTypedArray() {
            const e = this.getHeapView(), t = new this.typedArrayClass(this.size);
            return t.set(e), t;
        }
    }
    class P extends O {
        typedArrayClass = Int32Array;
        constructor(e){
            super(e ?? new r.Module.IntArray);
        }
        getHeap() {
            return r.Module.HEAP32;
        }
        static fromRaw(e) {
            return new P(e);
        }
    }
    class L extends O {
        typedArrayClass = Uint8Array;
        constructor(e){
            super(e ?? new r.Module.UnsignedCharArray);
        }
        getHeap() {
            return r.Module.HEAPU8;
        }
        static fromRaw(e) {
            return new L(e);
        }
    }
    class x extends O {
        typedArrayClass = Float32Array;
        constructor(e){
            super(e ?? new r.Module.FloatArray);
        }
        getHeap() {
            return r.Module.HEAPF32;
        }
        static fromRaw(e) {
            return new x(e);
        }
    }
    const j = x, $ = P, q = L, w = {
        toRaw: ({ x: s, y: e, z: t }, a)=>a ? (a.x = s, a.y = e, a.z = t, a) : new r.Module.Vec3(s, e, t),
        fromRaw: (s)=>{
            const { x: e, y: t, z: a } = s;
            return {
                x: e,
                y: t,
                z: a
            };
        },
        fromArray: ([s, e, t])=>({
                x: s,
                y: e,
                z: t
            }),
        toArray: ({ x: s, y: e, z: t })=>[
                s,
                e,
                t
            ],
        lerp: (s, e, t, a = {
            x: 0,
            y: 0,
            z: 0
        })=>{
            a.x = s.x + (e.x - s.x) * t, a.y = s.y + (e.y - s.y) * t, a.z = s.z + (e.z - s.z) * t;
        },
        copy: (s, e = {
            x: 0,
            y: 0,
            z: 0
        })=>{
            e.x = s.x, e.y = s.y, e.z = s.z;
        }
    }, d = (s, e)=>{
        const t = [];
        for(let a = 0; a < e; a++)t.push(s(a));
        return t;
    }, k = (s)=>r.Detour.statusSucceed(s);
    class J {
        constructor(e){
            this.raw = e;
        }
        vertBase() {
            return this.raw.vertBase;
        }
        triBase() {
            return this.raw.triBase;
        }
        vertCount() {
            return this.raw.vertCount;
        }
        triCount() {
            return this.raw.triCount;
        }
    }
    class ee {
        constructor(e){
            this.raw = e;
        }
        ref() {
            return this.raw.ref;
        }
        next() {
            return this.raw.next;
        }
        edge() {
            return this.raw.edge;
        }
        side() {
            return this.raw.side;
        }
        bmin() {
            return this.raw.bmin;
        }
        bmax() {
            return this.raw.bmax;
        }
    }
    class te {
        constructor(e){
            this.raw = e;
        }
        bmin() {
            return w.fromArray(d((e)=>this.raw.get_bmin(e), 3));
        }
        bmax() {
            return w.fromArray(d((e)=>this.raw.get_bmax(e), 3));
        }
        i() {
            return this.raw.i;
        }
    }
    class Y {
        constructor(e){
            this.raw = e;
        }
        pos(e) {
            return this.raw.get_pos(e);
        }
        rad() {
            return this.raw.rad;
        }
        poly() {
            return this.raw.poly;
        }
        flags() {
            return this.raw.flags;
        }
        side() {
            return this.raw.side;
        }
        userId() {
            return this.raw.userId;
        }
    }
    class re {
        constructor(e){
            this.raw = e;
        }
        magic() {
            return this.raw.magic;
        }
        version() {
            return this.raw.version;
        }
        x() {
            return this.raw.x;
        }
        y() {
            return this.raw.y;
        }
        layer() {
            return this.raw.layer;
        }
        userId() {
            return this.raw.userId;
        }
        polyCount() {
            return this.raw.polyCount;
        }
        vertCount() {
            return this.raw.vertCount;
        }
        maxLinkCount() {
            return this.raw.maxLinkCount;
        }
        detailMeshCount() {
            return this.raw.detailMeshCount;
        }
        detailVertCount() {
            return this.raw.detailVertCount;
        }
        detailTriCount() {
            return this.raw.detailTriCount;
        }
        bvNodeCount() {
            return this.raw.bvNodeCount;
        }
        offMeshConCount() {
            return this.raw.offMeshConCount;
        }
        offMeshBase() {
            return this.raw.offMeshBase;
        }
        walkableHeight() {
            return this.raw.walkableHeight;
        }
        walkableRadius() {
            return this.raw.walkableRadius;
        }
        walkableClimb() {
            return this.raw.walkableClimb;
        }
        bmin(e) {
            return this.raw.get_bmin(e);
        }
        bmax(e) {
            return this.raw.get_bmax(e);
        }
        bvQuantFactor() {
            return this.raw.bvQuantFactor;
        }
    }
    class N {
        constructor(e){
            this.raw = e;
        }
        firstLink() {
            return this.raw.firstLink;
        }
        verts(e) {
            return this.raw.get_verts(e);
        }
        neis(e) {
            return this.raw.get_neis(e);
        }
        flags() {
            return this.raw.flags;
        }
        vertCount() {
            return this.raw.vertCount;
        }
        areaAndType() {
            return this.raw.get_areaAndtype();
        }
        getType() {
            return this.raw.getType();
        }
    }
    class I {
        constructor(e){
            this.raw = e;
        }
        salt() {
            return this.raw.salt;
        }
        linksFreeList() {
            return this.raw.linksFreeList;
        }
        header() {
            return r.isNull(this.raw.header) ? null : new re(this.raw.header);
        }
        polys(e) {
            return new N(this.raw.get_polys(e));
        }
        verts(e) {
            return this.raw.get_verts(e);
        }
        links(e) {
            return new ee(this.raw.get_links(e));
        }
        detailMeshes(e) {
            return new J(this.raw.get_detailMeshes(e));
        }
        detailVerts(e) {
            return this.raw.get_detailVerts(e);
        }
        detailTris(e) {
            return this.raw.get_detailTris(e);
        }
        bvTree(e) {
            return new te(this.raw.get_bvTree(e));
        }
        offMeshCons(e) {
            return new Y(this.raw.get_offMeshCons(e));
        }
        data(e) {
            return this.raw.get_data(e);
        }
        dataSize() {
            return this.raw.dataSize;
        }
        flags() {
            return this.raw.flags;
        }
        next() {
            return new I(this.raw.next);
        }
    }
    const se = (s)=>{
        const e = r.DetourNavMeshBuilder.createNavMeshData(s.raw);
        return {
            success: e.success,
            navMeshData: L.fromRaw(e.navMeshData)
        };
    };
    class ae {
        constructor(e){
            this.raw = e ?? new r.Module.dtNavMeshCreateParams;
        }
        setPolyMeshCreateParams(e) {
            r.DetourNavMeshBuilder.setPolyMeshCreateParams(this.raw, e.raw);
        }
        setPolyMeshDetailCreateParams(e) {
            r.DetourNavMeshBuilder.setPolyMeshDetailCreateParams(this.raw, e.raw);
        }
        setOffMeshConnections(e) {
            if (e.length <= 0) return;
            const t = [], a = [], i = [], n = [], u = [], h = [];
            for(let R = 0; R < e.length; R++){
                const c = e[R];
                t.push(c.startPosition.x, c.startPosition.y, c.startPosition.z), t.push(c.endPosition.x, c.endPosition.y, c.endPosition.z), a.push(c.radius), i.push(c.bidirectional ? 1 : 0), n.push(c.area ?? 0), u.push(c.flags ?? 1), h.push(c.userId ?? 1e3 + R);
            }
            r.DetourNavMeshBuilder.setOffMeshConnections(this.raw, e.length, t, a, i, n, u, h);
        }
        verts(e) {
            return this.raw.get_verts(e);
        }
        setVerts(e, t) {
            this.raw.set_verts(e, t);
        }
        vertCount() {
            return this.raw.vertCount;
        }
        polys(e) {
            return this.raw.get_polys(e);
        }
        setPolys(e, t) {
            this.raw.set_polys(e, t);
        }
        polyAreas(e) {
            return this.raw.get_polyAreas(e);
        }
        setPolyAreas(e, t) {
            this.raw.set_polyAreas(e, t);
        }
        polyFlags(e) {
            return this.raw.get_polyFlags(e);
        }
        setPolyFlags(e, t) {
            this.raw.set_polyFlags(e, t);
        }
        polyCount() {
            return this.raw.polyCount;
        }
        nvp() {
            return this.raw.nvp;
        }
        setNvp(e) {
            this.raw.nvp = e;
        }
        detailMeshes(e) {
            return this.raw.get_detailMeshes(e);
        }
        setDetailMeshes(e, t) {
            this.raw.set_detailMeshes(e, t);
        }
        detailVerts(e) {
            return this.raw.get_detailVerts(e);
        }
        setDetailVerts(e, t) {
            this.raw.set_detailVerts(e, t);
        }
        detailVertsCount() {
            return this.raw.detailVertsCount;
        }
        detailTris(e) {
            return this.raw.get_detailTris(e);
        }
        setDetailTris(e, t) {
            this.raw.set_detailTris(e, t);
        }
        detailTriCount() {
            return this.raw.detailTriCount;
        }
        offMeshConVerts(e) {
            return this.raw.get_offMeshConVerts(e);
        }
        offMeshConRad(e) {
            return this.raw.get_offMeshConRad(e);
        }
        offMeshConDir(e) {
            return this.raw.get_offMeshConDir(e);
        }
        offMeshConAreas(e) {
            return this.raw.get_offMeshConAreas(e);
        }
        offMeshConFlags(e) {
            return this.raw.get_offMeshConFlags(e);
        }
        offMeshConUserID(e) {
            return this.raw.get_offMeshConUserID(e);
        }
        offMeshConCount() {
            return this.raw.offMeshConCount;
        }
        userId() {
            return this.raw.userId;
        }
        tileX() {
            return this.raw.tileX;
        }
        setTileX(e) {
            this.raw.tileX = e;
        }
        tileY() {
            return this.raw.tileY;
        }
        setTileY(e) {
            this.raw.tileY = e;
        }
        tileLayer() {
            return this.raw.tileLayer;
        }
        setTileLayer(e) {
            this.raw.tileLayer = e;
        }
        boundsMin() {
            return d((e)=>this.raw.get_bmin(e), 3);
        }
        setBoundsMin(e) {
            this.raw.set_bmin(0, e[0]), this.raw.set_bmin(1, e[1]), this.raw.set_bmin(2, e[2]);
        }
        boundsMax() {
            return d((e)=>this.raw.get_bmax(e), 3);
        }
        setBoundsMax(e) {
            this.raw.set_bmax(0, e[0]), this.raw.set_bmax(1, e[1]), this.raw.set_bmax(2, e[2]);
        }
        walkableHeight() {
            return this.raw.walkableHeight;
        }
        setWalkableHeight(e) {
            this.raw.walkableHeight = e;
        }
        walkableRadius() {
            return this.raw.walkableRadius;
        }
        setWalkableRadius(e) {
            this.raw.walkableRadius = e;
        }
        walkableClimb() {
            return this.raw.walkableClimb;
        }
        setWalkableClimb(e) {
            this.raw.walkableClimb = e;
        }
        cellSize() {
            return this.raw.cs;
        }
        setCellSize(e) {
            this.raw.cs = e;
        }
        cellHeight() {
            return this.raw.ch;
        }
        setCellHeight(e) {
            this.raw.ch = e;
        }
        buildBvTree() {
            return this.raw.buildBvTree;
        }
        setBuildBvTree(e) {
            this.raw.buildBvTree = e;
        }
    }
    class ie {
        constructor(e){
            this.raw = e;
        }
        tiles(e) {
            return new I(this.raw.get_tiles(e));
        }
        tileCount() {
            return this.raw.tileCount;
        }
    }
    class ne {
        constructor(e){
            this.raw = e;
        }
        data() {
            return d((e)=>this.raw.get_data(e), this.raw.dataSize);
        }
        dataSize() {
            return this.raw.dataSize;
        }
    }
    class oe {
        constructor(e){
            this.raw = e;
        }
        tileX() {
            return this.raw.tileX;
        }
        tileY() {
            return this.raw.tileY;
        }
    }
    class le {
        constructor(e){
            this.raw = e;
        }
        data() {
            return d((e)=>this.raw.get_data(e), this.raw.dataSize);
        }
        dataSize() {
            return this.raw.dataSize;
        }
    }
    class ue {
        constructor(e){
            this.raw = e ?? new r.Module.NavMesh;
        }
        initSolo(e) {
            return this.raw.initSolo(e.raw);
        }
        initTiled(e) {
            return this.raw.initTiled(e.raw);
        }
        addTile(e, t, a) {
            const i = new r.UnsignedIntRef, n = this.raw.addTile(e.raw, t, a, i), u = i.value;
            return r.destroy(i), {
                status: n,
                tileRef: u
            };
        }
        decodePolyId(e) {
            const t = new r.UnsignedIntRef, a = new r.UnsignedIntRef, i = new r.UnsignedIntRef;
            this.raw.decodePolyId(e, t, a, i);
            const n = t.value;
            r.destroy(t);
            const u = a.value;
            r.destroy(a);
            const h = i.value;
            return r.destroy(i), {
                tileSalt: n,
                tileIndex: u,
                tilePolygonIndex: h
            };
        }
        encodePolyId(e, t, a) {
            return this.raw.encodePolyId(e, t, a);
        }
        removeTile(e) {
            return new ne(this.raw.removeTile(e));
        }
        calcTileLoc(e) {
            return new oe(this.raw.calcTileLoc(w.toArray(e)));
        }
        getTileAt(e, t, a) {
            const i = this.raw.getTileAt(e, t, a);
            return r.isNull(i) ? null : new I(i);
        }
        getTilesAt(e, t, a) {
            return new ie(this.raw.getTilesAt(e, t, a));
        }
        getTileRefAt(e, t, a) {
            return this.raw.getTileRefAt(e, t, a);
        }
        getTileRef(e) {
            return this.raw.getTileRef(e.raw);
        }
        getTileByRef(e) {
            const t = this.raw.getTileByRef(e);
            return r.isNull(t) ? null : new I(t);
        }
        getMaxTiles() {
            return this.raw.getMaxTiles();
        }
        getTile(e) {
            return new I(this.raw.getTile(e));
        }
        getTileAndPolyByRef(e) {
            const t = this.raw.getTileAndPolyByRef(e), a = new I(t.tile), i = new N(t.poly);
            return {
                success: k(t.status),
                status: t.status,
                tile: a,
                poly: i
            };
        }
        getTileAndPolyByRefUnsafe(e) {
            const t = this.raw.getTileAndPolyByRef(e), a = new I(t.tile), i = new N(t.poly);
            return {
                tile: a,
                poly: i
            };
        }
        isValidPolyRef(e) {
            return this.raw.isValidPolyRef(e);
        }
        getPolyRefBase(e) {
            return this.raw.getPolyRefBase(e.raw);
        }
        getOffMeshConnectionPolyEndPoints(e, t) {
            const a = new r.Vec3, i = new r.Vec3, n = this.raw.getOffMeshConnectionPolyEndPoints(e, t, a, i), u = w.fromRaw(a);
            r.destroy(a);
            const h = w.fromRaw(i);
            return r.destroy(i), {
                success: k(n),
                status: n,
                start: u,
                end: h
            };
        }
        getOffMeshConnectionByRef(e) {
            return new Y(this.raw.getOffMeshConnectionByRef(e));
        }
        setPolyFlags(e, t) {
            return this.raw.setPolyFlags(e, t);
        }
        getPolyFlags(e) {
            const t = new r.UnsignedShortRef, a = this.raw.getPolyFlags(e, t), i = t.value;
            return r.destroy(t), {
                status: a,
                flags: i
            };
        }
        setPolyArea(e, t) {
            return this.raw.setPolyArea(e, t);
        }
        getPolyArea(e) {
            const t = new r.UnsignedCharRef, a = this.raw.getPolyArea(e, t), i = t.value;
            return r.destroy(t), {
                status: a,
                area: i
            };
        }
        getTileStateSize(e) {
            return this.raw.getTileStateSize(e.raw);
        }
        storeTileState(e, t) {
            return new le(this.raw.storeTileState(e.raw, t));
        }
        restoreTileState(e, t, a) {
            return this.raw.restoreTileState(e.raw, t, a);
        }
        destroy() {
            this.raw.destroy(), r.Module.destroy(this.raw);
        }
    }
    const X = {
        borderSize: 0,
        tileSize: 0,
        cs: .2,
        ch: .2,
        walkableSlopeAngle: 60,
        walkableHeight: 2,
        walkableClimb: 2,
        walkableRadius: .5,
        maxEdgeLen: 12,
        maxSimplificationError: 1.3,
        minRegionArea: 8,
        mergeRegionArea: 20,
        maxVertsPerPoly: 6,
        detailSampleDist: 6,
        detailSampleMaxError: 1
    }, he = (s)=>{
        const e = {
            ...X,
            ...s
        }, t = new r.Module.rcConfig;
        return t.borderSize = e.borderSize, t.tileSize = e.tileSize, t.cs = e.cs, t.ch = e.ch, t.walkableSlopeAngle = e.walkableSlopeAngle, t.walkableHeight = e.walkableHeight, t.walkableClimb = e.walkableClimb, t.walkableRadius = e.walkableRadius, t.maxEdgeLen = e.maxEdgeLen, t.maxSimplificationError = e.maxSimplificationError, t.minRegionArea = e.minRegionArea, t.mergeRegionArea = e.mergeRegionArea, t.maxVertsPerPoly = e.maxVertsPerPoly, t.detailSampleDist = e.detailSampleDist, t.detailSampleMaxError = e.detailSampleMaxError, t;
    };
    class ce {
        logs = [];
        startTimes = {};
        accumulatedTimes = {};
        constructor(e = !0){
            const t = new r.Module.RecastBuildContextImpl;
            t.log = (a, i, n)=>{
                if (!this.raw.logEnabled()) return;
                const u = i, h = new Uint8Array(r.Module.HEAPU8.buffer, u, n), R = new Uint8Array(n);
                R.set(h);
                const c = new TextDecoder().decode(R);
                this.log(a, c);
            }, t.resetLog = ()=>{
                this.resetLog();
            }, t.startTimer = (a)=>{
                this.raw.timerEnabled() && this.startTimer(a);
            }, t.stopTimer = (a)=>{
                this.raw.timerEnabled() && this.stopTimer(a);
            }, t.getAccumulatedTime = (a)=>this.raw.timerEnabled() ? this.getAccumulatedTime(a) : -1, t.resetTimers = ()=>{
                this.raw.timerEnabled() && (this.startTimes = {}, this.accumulatedTimes = {});
            }, this.raw = new r.Module.RecastBuildContext(t), this.raw.enableTimer(e), this.raw.enableLog(e), this.resetTimers();
        }
        log(e, t) {
            this.logs.push({
                category: e,
                msg: t
            });
        }
        resetLog() {
            this.logs = [];
        }
        startTimer(e) {
            this.startTimes[e] = performance.now();
        }
        stopTimer(e) {
            const a = performance.now() - this.startTimes[e];
            this.accumulatedTimes[e] === -1 ? this.accumulatedTimes[e] = a : this.accumulatedTimes[e] += a;
        }
        getAccumulatedTime(e) {
            return this.accumulatedTimes[e];
        }
        resetTimers() {
            for(let e = 0; e < o.RC_MAX_TIMERS; e++)this.startTimes[e] = -1, this.accumulatedTimes[e] = -1;
        }
    }
    class D {
        constructor(e){
            this.raw = e;
        }
        smin() {
            return this.raw.smin;
        }
        smax() {
            return this.raw.smax;
        }
        area() {
            return this.raw.area;
        }
        next() {
            return r.isNull(this.raw.next) ? null : new D(this.raw.next);
        }
    }
    class v {
        constructor(e){
            this.raw = e;
        }
        next() {
            return r.isNull(this.raw.next) ? null : new v(this.raw.next);
        }
        items(e) {
            return new D(this.raw.get_items(e));
        }
    }
    class we {
        constructor(e){
            this.raw = e;
        }
        width() {
            return this.raw.width;
        }
        height() {
            return this.raw.height;
        }
        bmin() {
            return w.fromArray(d((e)=>this.raw.get_bmin(e), 3));
        }
        bmax() {
            return w.fromArray(d((e)=>this.raw.get_bmax(e), 3));
        }
        cs() {
            return this.raw.cs;
        }
        ch() {
            return this.raw.ch;
        }
        spans(e) {
            return new D(this.raw.get_spans(e));
        }
        pools(e) {
            return new v(this.raw.get_pools(e));
        }
        freelist(e) {
            return new D(this.raw.get_freelist(e));
        }
    }
    class Re {
        constructor(e){
            this.raw = e;
        }
        index() {
            return this.raw.get_index();
        }
        count() {
            return this.raw.get_count();
        }
    }
    class de {
        constructor(e){
            this.raw = e;
        }
        y() {
            return this.raw.get_y();
        }
        reg() {
            return this.raw.get_reg();
        }
        con() {
            return this.raw.get_con();
        }
        h() {
            return this.raw.get_h();
        }
    }
    class _e {
        constructor(e){
            this.raw = e;
        }
        width() {
            return this.raw.width;
        }
        height() {
            return this.raw.height;
        }
        spanCount() {
            return this.raw.spanCount;
        }
        walkableHeight() {
            return this.raw.walkableHeight;
        }
        walkableClimb() {
            return this.raw.walkableClimb;
        }
        borderSize() {
            return this.raw.borderSize;
        }
        maxDistance() {
            return this.raw.maxDistance;
        }
        maxRegions() {
            return this.raw.maxRegions;
        }
        bmin() {
            return w.fromArray(d((e)=>this.raw.get_bmin(e), 3));
        }
        bmax() {
            return w.fromArray(d((e)=>this.raw.get_bmax(e), 3));
        }
        cs() {
            return this.raw.cs;
        }
        ch() {
            return this.raw.ch;
        }
        cells(e) {
            return new Re(this.raw.get_cells(e));
        }
        spans(e) {
            return new de(this.raw.get_spans(e));
        }
        dist(e) {
            return this.raw.get_dist(e);
        }
        areas(e) {
            return this.raw.get_areas(e);
        }
    }
    class Ee {
        constructor(e){
            this.raw = e;
        }
        verts(e) {
            return this.raw.get_verts(e);
        }
        nverts() {
            return this.raw.nverts;
        }
        rverts(e) {
            return this.raw.get_rverts(e);
        }
        nrverts() {
            return this.raw.nrverts;
        }
        reg() {
            return this.raw.reg;
        }
        area() {
            return this.raw.area;
        }
    }
    class Te {
        constructor(e){
            this.raw = e;
        }
        conts(e) {
            return new Ee(this.raw.get_conts(e));
        }
        nconts() {
            return this.raw.nconts;
        }
        bmin() {
            return w.fromArray(d((e)=>this.raw.get_bmin(e), 3));
        }
        bmax() {
            return w.fromArray(d((e)=>this.raw.get_bmax(e), 3));
        }
        cs() {
            return this.raw.cs;
        }
        ch() {
            return this.raw.ch;
        }
        width() {
            return this.raw.width;
        }
        height() {
            return this.raw.height;
        }
        borderSize() {
            return this.raw.borderSize;
        }
        maxError() {
            return this.raw.maxError;
        }
    }
    class Me {
        constructor(e){
            this.raw = e;
        }
        verts(e) {
            return this.raw.get_verts(e);
        }
        polys(e) {
            return this.raw.get_polys(e);
        }
        regs(e) {
            return this.raw.get_regs(e);
        }
        flags(e) {
            return this.raw.get_flags(e);
        }
        setFlags(e, t) {
            this.raw.set_flags(e, t);
        }
        areas(e) {
            return this.raw.get_areas(e);
        }
        setAreas(e, t) {
            this.raw.set_areas(e, t);
        }
        nverts() {
            return this.raw.nverts;
        }
        npolys() {
            return this.raw.npolys;
        }
        maxpolys() {
            return this.raw.maxpolys;
        }
        nvp() {
            return this.raw.nvp;
        }
        bmin() {
            return w.fromArray(d((e)=>this.raw.get_bmin(e), 3));
        }
        bmax() {
            return w.fromArray(d((e)=>this.raw.get_bmax(e), 3));
        }
        cs() {
            return this.raw.cs;
        }
        ch() {
            return this.raw.ch;
        }
        borderSize() {
            return this.raw.borderSize;
        }
        maxEdgeError() {
            return this.raw.maxEdgeError;
        }
    }
    class ge {
        constructor(e){
            this.raw = e;
        }
        meshes(e) {
            return this.raw.get_meshes(e);
        }
        verts(e) {
            return this.raw.get_verts(e);
        }
        tris(e) {
            return this.raw.get_tris(e);
        }
        nmeshes() {
            return this.raw.nmeshes;
        }
        nverts() {
            return this.raw.nverts;
        }
        ntris() {
            return this.raw.ntris;
        }
    }
    const Ce = (s, e, t)=>r.Recast.calcGridSize(s, e, t), Ae = (s, e, t, a, i, n, u, h)=>r.Recast.createHeightfield(s.raw, e.raw, t, a, i, n, u, h), fe = (s, e, t, a, i, n, u)=>r.Recast.markWalkableTriangles(s.raw, e, t.raw, a, i.raw, n, u.raw), me = (s, e, t, a, i, n, u, h = 1)=>r.Recast.rasterizeTriangles(s.raw, e.raw, t, a.raw, i.raw, n, u.raw, h), Ie = (s, e, t)=>r.Recast.filterLowHangingWalkableObstacles(s.raw, e, t.raw), ye = (s, e, t, a)=>r.Recast.filterLedgeSpans(s.raw, e, t, a.raw), De = (s, e, t)=>r.Recast.filterWalkableLowHeightSpans(s.raw, e, t.raw), Se = (s, e, t, a, i)=>r.Recast.buildCompactHeightfield(s.raw, e, t, a.raw, i.raw), be = (s, e, t)=>r.Recast.erodeWalkableArea(s.raw, e, t.raw), Le = (s, e)=>r.Recast.buildDistanceField(s.raw, e.raw), pe = (s, e, t, a, i)=>r.Recast.buildRegions(s.raw, e.raw, t, a, i), Ne = (s, e, t, a, i, n = o.RC_CONTOUR_TESS_WALL_EDGES)=>r.Recast.buildContours(s.raw, e.raw, t, a, i.raw, n), Oe = (s, e, t, a)=>r.Recast.buildPolyMesh(s.raw, e.raw, t, a.raw), Pe = (s, e, t, a, i, n)=>r.Recast.buildPolyMeshDetail(s.raw, e.raw, t.raw, a, i, n.raw), xe = ()=>new we(r.Recast.allocHeightfield()), F = (s)=>r.Recast.freeHeightfield(s.raw), ve = ()=>new _e(r.Recast.allocCompactHeightfield()), z = (s)=>r.Recast.freeCompactHeightfield(s.raw), He = ()=>new Te(r.Recast.allocContourSet()), V = (s)=>r.Recast.freeContourSet(s.raw), Be = ()=>new Me(r.Recast.allocPolyMesh()), Ue = (s)=>r.Recast.freePolyMesh(s.raw), Ge = ()=>new ge(r.Recast.allocPolyMeshDetail()), ke = (s)=>r.Recast.freePolyMeshDetail(s.raw), Fe = (s, e)=>{
        const t = r.NavMeshExporter.exportNavMesh(s.raw, e?.raw), a = new Uint8Array(r.Module.HEAPU8.buffer, t.dataPointer, t.size), i = new Uint8Array(t.size);
        return i.set(a), r.NavMeshExporter.freeNavMeshExport(t), i;
    }, ze = (s)=>Fe(s), Ve = (s, e)=>{
        const t = {
            x: 1 / 0,
            y: 1 / 0,
            z: 1 / 0
        }, a = {
            x: -1 / 0,
            y: -1 / 0,
            z: -1 / 0
        };
        for(let i = 0; i < e.length; i++){
            const n = e[i], u = s[n * 3], h = s[n * 3 + 1], R = s[n * 3 + 2];
            t.x = Math.min(t.x, u), t.y = Math.min(t.y, h), t.z = Math.min(t.z, R), a.x = Math.max(a.x, u), a.y = Math.max(a.y, h), a.z = Math.max(a.z, R);
        }
        return {
            bbMin: w.toArray(t),
            bbMax: w.toArray(a)
        };
    }, We = {
        ...X,
        buildBvTree: !0
    }, Ye = (s, e, t = {}, a = !1)=>{
        const i = new ce, n = {
            type: "solo",
            buildContext: i
        }, u = ()=>{
            a || (n.heightfield && (F(n.heightfield), n.heightfield = void 0), n.compactHeightfield && (z(n.compactHeightfield), n.compactHeightfield = void 0), n.contourSet && (V(n.contourSet), n.contourSet = void 0), n.polyMesh && (Ue(n.polyMesh), n.polyMesh = void 0), n.polyMeshDetail && (ke(n.polyMeshDetail), n.polyMeshDetail = void 0));
        }, h = (E)=>(u(), {
                navMeshData: void 0,
                success: !1,
                intermediates: n,
                error: E
            }), R = s, c = e.length, y = new j;
        y.copy(R);
        const H = e, _ = e.length / 3, g = new $;
        g.copy(H);
        let C, A;
        if (t.bounds) C = t.bounds[0], A = t.bounds[1];
        else {
            const E = Ve(s, e);
            C = E.bbMin, A = E.bbMax;
        }
        const B = {
            ...We,
            ...t
        }, l = he(B);
        l.minRegionArea = l.minRegionArea * l.minRegionArea, l.mergeRegionArea = l.mergeRegionArea * l.mergeRegionArea, l.detailSampleDist = l.detailSampleDist < .9 ? 0 : l.cs * l.detailSampleDist, l.detailSampleMaxError = l.ch * l.detailSampleMaxError;
        const U = Ce(C, A, l.cs);
        l.width = U.width, l.height = U.height;
        const f = xe();
        if (n.heightfield = f, !Ae(i, f, l.width, l.height, C, A, l.cs, l.ch)) return h("Could not create heightfield");
        const S = new q;
        if (S.resize(_), fe(i, l.walkableSlopeAngle, y, c, g, _, S), !me(i, y, c, g, S, _, f, l.walkableClimb)) return h("Could not rasterize triangles");
        S.destroy(), y.destroy(), g.destroy(), Ie(i, l.walkableClimb, f), ye(i, l.walkableHeight, l.walkableClimb, f), De(i, l.walkableHeight, f);
        const m = ve();
        if (n.compactHeightfield = m, !Se(i, l.walkableHeight, l.walkableClimb, f, m)) return h("Failed to build compact data");
        if (a || (F(f), n.heightfield = void 0), !be(i, l.walkableRadius, m)) return h("Failed to erode walkable area");
        if (!Le(i, m)) return h("Failed to build distance field");
        if (!pe(i, m, l.borderSize, l.minRegionArea, l.mergeRegionArea)) return h("Failed to build regions");
        const b = He();
        if (n.contourSet = b, !Ne(i, m, l.maxSimplificationError, l.maxEdgeLen, b, o.RC_CONTOUR_TESS_WALL_EDGES)) return h("Failed to create contours");
        const M = Be();
        if (n.polyMesh = M, !Oe(i, b, l.maxVertsPerPoly, M)) return h("Failed to triangulate contours");
        const p = Ge();
        if (n.polyMeshDetail = p, !Pe(i, M, m, l.detailSampleDist, l.detailSampleMaxError, p)) return h("Failed to build detail mesh");
        a || (z(m), n.compactHeightfield = void 0, V(b), n.contourSet = void 0);
        for(let E = 0; E < M.npolys(); E++)M.areas(E) === o.RC_WALKABLE_AREA && M.setAreas(E, 0), M.areas(E) === 0 && M.setFlags(E, 1);
        const T = new ae;
        T.setPolyMeshCreateParams(M), T.setPolyMeshDetailCreateParams(p), T.setWalkableHeight(l.walkableHeight * l.ch), T.setWalkableRadius(l.walkableRadius * l.cs), T.setWalkableClimb(l.walkableClimb * l.ch), T.setCellSize(l.cs), T.setCellHeight(l.ch), T.setBuildBvTree(B.buildBvTree), t.offMeshConnections && T.setOffMeshConnections(t.offMeshConnections);
        const G = se(T);
        return G.success ? (u(), {
            navMeshData: G.navMeshData,
            success: !0,
            intermediates: n
        }) : h("Failed to create Detour navmesh data");
    }, Xe = (s, e, t = {}, a = !1)=>{
        if (!r.Module) throw new Error('"init" must be called before using any recast-navigation-js APIs. See: https://github.com/isaac-mason/recast-navigation-js?tab=readme-ov-file#initialization');
        const i = Ye(s, e, t, a);
        if (!i.success) return {
            navMesh: void 0,
            success: !1,
            intermediates: i.intermediates,
            error: i.error
        };
        const { navMeshData: n } = i, u = new ue;
        return u.initSolo(n) ? {
            success: !0,
            navMesh: u,
            intermediates: i.intermediates
        } : (n.destroy(), {
            navMesh: void 0,
            success: !1,
            intermediates: i.intermediates,
            error: "Failed to initialize solo NavMesh"
        });
    }, W = {
        cs: .3,
        ch: .1,
        walkableSlopeAngle: 45,
        walkableHeight: 20,
        walkableClimb: 3,
        walkableRadius: 0,
        maxEdgeLen: 120,
        maxSimplificationError: 1.3,
        minRegionArea: 2,
        mergeRegionArea: 20,
        maxVertsPerPoly: 6,
        detailSampleDist: 6,
        detailSampleMaxError: 1
    };
    self.onmessage = async (s)=>{
        const { positions: e, indices: t, recastOverrides: a } = s.data, i = a ? {
            ...W,
            ...a
        } : W;
        try {
            await Z();
            const n = Math.floor(t.length / 3), u = new Float32Array(n * 3);
            for(let _ = 0; _ < n; _++){
                const g = t[_ * 3], C = t[_ * 3 + 1], A = t[_ * 3 + 2];
                u[_ * 3] = (e[g * 3] + e[C * 3] + e[A * 3]) / 3, u[_ * 3 + 1] = (e[g * 3 + 1] + e[C * 3 + 1] + e[A * 3 + 1]) / 3, u[_ * 3 + 2] = (e[g * 3 + 2] + e[C * 3 + 2] + e[A * 3 + 2]) / 3;
            }
            const h = performance.now(), { success: R, navMesh: c } = Xe(e, t, i);
            if (console.log(`[NavMeshWorker] generateSoloNavMesh: ${(performance.now() - h).toFixed(1)}ms`), !R || !c) {
                postMessage({
                    error: "Recast generateSoloNavMesh returned failure"
                });
                return;
            }
            const y = ze(c);
            c.destroy(), postMessage({
                navmeshBytes: y,
                centroids: u,
                triCount: n
            }, [
                y.buffer,
                u.buffer
            ]);
        } catch (n) {
            const u = {
                error: String(n)
            };
            postMessage(u);
        }
    };
})();
