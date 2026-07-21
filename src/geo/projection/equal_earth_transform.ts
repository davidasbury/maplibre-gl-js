import {LngLat, type LngLatLike} from '../lng_lat.ts';
import {MercatorCoordinate, mercatorZfromAltitude} from '../mercator_coordinate.ts';
import Point from '@mapbox/point-geometry';
import {clamp, createMat4f64, degreesToRadians, createIdentityMat4f32, zoomScale, type Mat4f32, type Mat4f64} from '../../util/util.ts';
import {type mat2, mat4, vec3, vec4} from 'gl-matrix';
import {UnwrappedTileID, OverscaledTileID, type CanonicalTileID, calculateTileKey} from '../../tile/tile_id.ts';
import {interpolates} from '@maplibre/maplibre-gl-style-spec';
import {type PointProjection, xyTransformMat4} from '../../symbol/projection.ts';
import {LngLatBounds} from '../lng_lat_bounds.ts';
import {getMercatorHorizon, maxMercatorHorizonAngle, cameraMercatorCoordinateFromCenterAndRotation, calculateTileMatrix} from './mercator_utils.ts';
import {equalEarthWorldFromLngLat, lngLatFromEqualEarthWorld, equalEarthXScaleAtLat, latFromEqualEarthWorldY, EQUAL_EARTH_WORLD_Y_NORTH_POLE, EQUAL_EARTH_WORLD_Y_SOUTH_POLE} from '../equal_earth_coordinate.ts';
import {projectToEqualEarthWorldCoordinates} from './equal_earth_utils.ts';
import {EXTENT} from '../../data/extent.ts';
import {TransformHelper} from '../transform_helper.ts';
import {EqualEarthCoveringTilesDetailsProvider} from './equal_earth_covering_tiles_details_provider.ts';
import {Frustum} from '../../util/primitives/frustum.ts';
import {fastInvertProjMat4} from '../../util/fast_maths.ts';

import type {Terrain} from '../../render/terrain.ts';
import type {IReadonlyTransform, ITransform, TransformConstrainFunction} from '../transform_interface.ts';
import type {TransformOptions} from '../transform_helper.ts';
import type {PaddingOptions} from '../edge_insets.ts';
import type {CustomLayerProjectionData, ProjectionDataParams, RendererProjectionData} from './projection_data.ts';
import type {CoveringTilesDetailsProvider} from './covering_tiles_details_provider.ts';

/**
 * Plain-object analogue of `MercatorCoordinate` for the Equal Earth plane
 * (same "fraction of world" unit convention, no branded class -- this
 * project deliberately keeps `equal_earth_coordinate.ts` to plain
 * functions/objects, and this Transform matches that). `z` is optional so
 * callers that only ever produce x/y (e.g. `equalEarthWorldFromLngLat`)
 * don't need to fabricate a fake altitude.
 *
 * These are unit-square world coordinates: (0.5, 0.5) is (0°, 0°), y is DOWN
 * (north is smaller y; the north-pole line sits at y≈0.2566), matching
 * mercator's screen-oriented world space -- the convention the copied camera
 * math in `_calcMatrices` assumes. `equal_earth_coordinate.ts`'s
 * `equalEarthWorldFromLngLat`/`lngLatFromEqualEarthWorld` carry the whole
 * conversion (scale + y-flip); this file never touches the paper-convention
 * functions directly.
 */
type EqualEarthCoordinate = {x: number; y: number; z?: number};

export class EqualEarthTransform implements ITransform {
    private _helper: TransformHelper;

    //
    // Implementation of transform getters and setters
    //

    get pixelsToClipSpaceMatrix(): mat4 {
        return this._helper.pixelsToClipSpaceMatrix;
    }
    get clipSpaceToPixelsMatrix(): mat4 {
        return this._helper.clipSpaceToPixelsMatrix;
    }
    get pixelsToGLUnits(): [number, number] {
        return this._helper.pixelsToGLUnits;
    }
    get centerOffset(): Point {
        return this._helper.centerOffset;
    }
    get size(): Point {
        return this._helper.size;
    }
    get rotationMatrix(): mat2 {
        return this._helper.rotationMatrix;
    }
    get centerPoint(): Point {
        return this._helper.centerPoint;
    }
    get pixelsPerMeter(): number {
        return this._helper.pixelsPerMeter;
    }
    setMinZoom(zoom: number): void {
        this._helper.setMinZoom(zoom);
    }
    setMaxZoom(zoom: number): void {
        this._helper.setMaxZoom(zoom);
    }
    setMinPitch(pitch: number): void {
        this._helper.setMinPitch(pitch);
    }
    setMaxPitch(pitch: number): void {
        this._helper.setMaxPitch(pitch);
    }
    setRenderWorldCopies(renderWorldCopies: boolean): void {
        this._helper.setRenderWorldCopies(renderWorldCopies);
    }
    setBearing(bearing: number): void {
        this._helper.setBearing(bearing);
    }
    setPitch(pitch: number): void {
        this._helper.setPitch(pitch);
    }
    setRoll(roll: number): void {
        this._helper.setRoll(roll);
    }
    setFov(fov: number): void {
        this._helper.setFov(fov);
    }
    setZoom(zoom: number): void {
        this._helper.setZoom(zoom);
    }
    setCenter(center: LngLat): void {
        this._helper.setCenter(center);
    }
    setElevation(elevation: number): void {
        this._helper.setElevation(elevation);
    }
    setMinElevationForCurrentTile(elevation: number): void {
        this._helper.setMinElevationForCurrentTile(elevation);
    }
    setPadding(padding: PaddingOptions): void {
        this._helper.setPadding(padding);
    }
    interpolatePadding(start: PaddingOptions, target: PaddingOptions, t: number): void {
        this._helper.interpolatePadding(start, target, t);
    }
    isPaddingEqual(padding: PaddingOptions): boolean {
        return this._helper.isPaddingEqual(padding);
    }
    resize(width: number, height: number, constrain: boolean = true): void {
        this._helper.resize(width, height, constrain);
    }
    getMaxBounds(): LngLatBounds {
        return this._helper.getMaxBounds();
    }
    setMaxBounds(bounds?: LngLatBounds): void {
        this._helper.setMaxBounds(bounds);
    }
    setConstrainOverride(constrain?: TransformConstrainFunction | null): void {
        this._helper.setConstrainOverride(constrain);
    }
    overrideNearFarZ(nearZ: number, farZ: number): void {
        this._helper.overrideNearFarZ(nearZ, farZ);
    }
    clearNearFarZOverride(): void {
        this._helper.clearNearFarZOverride();
    }
    getCameraQueryGeometry(queryGeometry: Point[]): Point[] {
        return this._helper.getCameraQueryGeometry(this.getCameraPoint(), queryGeometry);
    }

    get tileSize(): number {
        return this._helper.tileSize;
    }
    get tileZoom(): number {
        return this._helper.tileZoom;
    }
    get scale(): number {
        return this._helper.scale;
    }
    get worldSize(): number {
        return this._helper.worldSize;
    }
    get width(): number {
        return this._helper.width;
    }
    get height(): number {
        return this._helper.height;
    }
    get lngRange(): [number, number] {
        return this._helper.lngRange;
    }
    get latRange(): [number, number] {
        return this._helper.latRange;
    }
    get minZoom(): number {
        return this._helper.minZoom;
    }
    get maxZoom(): number {
        return this._helper.maxZoom;
    }
    get zoom(): number {
        return this._helper.zoom;
    }
    get center(): LngLat {
        return this._helper.center;
    }
    get minPitch(): number {
        return this._helper.minPitch;
    }
    get maxPitch(): number {
        return this._helper.maxPitch;
    }
    get pitch(): number {
        return this._helper.pitch;
    }
    get pitchInRadians(): number {
        return this._helper.pitchInRadians;
    }
    get roll(): number {
        return this._helper.roll;
    }
    get rollInRadians(): number {
        return this._helper.rollInRadians;
    }
    get bearing(): number {
        return this._helper.bearing;
    }
    get bearingInRadians(): number {
        return this._helper.bearingInRadians;
    }
    get fov(): number {
        return this._helper.fov;
    }
    get fovInRadians(): number {
        return this._helper.fovInRadians;
    }
    get elevation(): number {
        return this._helper.elevation;
    }
    get minElevationForCurrentTile(): number {
        return this._helper.minElevationForCurrentTile;
    }
    get padding(): PaddingOptions {
        return this._helper.padding;
    }
    get unmodified(): boolean {
        return this._helper.unmodified;
    }
    get renderWorldCopies(): boolean {
        return this._helper.renderWorldCopies;
    }
    get cameraToCenterDistance(): number {
        return this._helper.cameraToCenterDistance;
    }
    get constrainOverride(): TransformConstrainFunction {
        return this._helper.constrainOverride;
    }
    public get nearZ(): number {
        return this._helper.nearZ;
    }
    public get farZ(): number {
        return this._helper.farZ;
    }
    public get autoCalculateNearFarZ(): boolean {
        return this._helper.autoCalculateNearFarZ;
    }
    setTransitionState(_value: number, _error: number): void {
        // Do nothing
    }
    //
    // Implementation of equal earth transform
    //

    private _cameraPosition: vec3;

    private _projectionMatrix: mat4;
    private _viewProjMatrix: mat4;
    private _equalEarthMatrix: mat4;
    private _equalEarthMatrix32f: Mat4f32;
    private _invViewProjMatrix: mat4;
    private _invProjMatrix: mat4;
    private _alignedProjMatrix: mat4;
    private _pixelMatrix: mat4;
    private _pixelMatrix3D: mat4;
    private _pixelMatrixInverse: mat4;
    private _fogMatrix: mat4;

    private _posMatrixCache: Map<string, {f64: Mat4f64; f32: Mat4f32}> = new Map();
    private _alignedPosMatrixCache: Map<string, {f64: Mat4f64; f32: Mat4f32}> = new Map();
    private _fogMatrixCacheF32: Map<string, mat4> = new Map();

    private _coveringTilesDetailsProvider;

    constructor(options?: TransformOptions) {
        this._helper = new TransformHelper({
            calcMatrices: () => this._calcMatrices(),
            defaultConstrain: (center, zoom) => { return this.defaultConstrain(center, zoom); }
        }, options);
        // Stage A step 6 ("Covering tiles v1"): EE-aware naive-bbox provider.
        // See equal_earth_covering_tiles_details_provider.ts and
        // docs/resources/2026-07-20-stage-a-step6-covering-tiles.md (outer
        // project) for the design. Replaces the step-5 mercator placeholder.
        this._coveringTilesDetailsProvider = new EqualEarthCoveringTilesDetailsProvider();
    }

    public clone(): ITransform {
        const clone = new EqualEarthTransform();
        clone.apply(this, false);
        return clone;
    }

    public apply(that: IReadonlyTransform, constrain: boolean, forceOverrideZ?: boolean): void {
        this._helper.apply(that, constrain, forceOverrideZ);
    }

    public get cameraPosition(): vec3 { return this._cameraPosition; }
    public get projectionMatrix(): mat4 { return this._projectionMatrix; }
    public get modelViewProjectionMatrix(): mat4 { return this._viewProjMatrix; }
    public get inverseProjectionMatrix(): mat4 { return this._invProjMatrix; }

    getVisibleUnwrappedCoordinates(tileID: CanonicalTileID): UnwrappedTileID[] {
        // Stage B step 8 (Mechanism 2's world copies): mercator's version,
        // essentially verbatim (see the design doc) -- it only needs
        // screenPointToMercatorCoordinate on the viewport corners and
        // renderWorldCopies, both already available here. The "banana
        // tiling" fact (design doc) means the floor()-derived wrap range is
        // correct as-is: Equal Earth's world copies partition every
        // horizontal line of the projected plane exactly, just like
        // mercator's do, so the same corner-unprojection logic that finds
        // "which wrap indices are on screen" for mercator applies unchanged.
        const result = [new UnwrappedTileID(0, tileID)];
        if (this._helper._renderWorldCopies) {
            const utl = this.screenPointToMercatorCoordinate(new Point(0, 0));
            const utr = this.screenPointToMercatorCoordinate(new Point(this._helper._width, 0));
            const ubl = this.screenPointToMercatorCoordinate(new Point(this._helper._width, this._helper._height));
            const ubr = this.screenPointToMercatorCoordinate(new Point(0, this._helper._height));
            const w0 = Math.floor(Math.min(utl.x, utr.x, ubl.x, ubr.x));
            const w1 = Math.floor(Math.max(utl.x, utr.x, ubl.x, ubr.x));

            // Add an extra copy of the world on each side to properly render ImageSources and CanvasSources.
            // Both sources draw outside the tile boundaries of the tile that "contains them" so we need
            // to add extra copies on both sides in case offscreen tiles need to draw into on-screen ones.
            const extraWorldCopy = 1;

            for (let w = w0 - extraWorldCopy; w <= w1 + extraWorldCopy; w++) {
                if (w === 0) continue;
                result.push(new UnwrappedTileID(w, tileID));
            }
        }
        return result;
    }

    getCameraFrustum(): Frustum {
        return Frustum.fromInvProjectionMatrix(this._invViewProjMatrix, this.worldSize);
    }
    getClippingPlane(): vec4 | null {
        return null;
    }
    getCoveringTilesDetailsProvider(): CoveringTilesDetailsProvider {
        return this._coveringTilesDetailsProvider;
    }

    recalculateZoomAndCenter(terrain?: Terrain): void {
        // find position the camera is looking on
        const center = this.screenPointToLocation(this.centerPoint, terrain);
        const elevation = terrain ? terrain.getElevationForLngLatZoom(center, this._helper._tileZoom) : 0;
        this._helper.recalculateZoomAndCenter(elevation);
    }

    /**
     * Stage B step 8 closed-form solve (replaces the Stage A world-coordinate
     * subtraction, which assumed a center-independent, fixed-lambda0
     * mapping -- no longer true once lambda0 tracks center.lng). See
     * docs/resources/2026-07-20-stage-b-step8-dynamic-lambda0-design.md
     * (outer project), "setLocationAtPoint closed-form solve", for the
     * derivation. `a`/`b` are unit-world coordinates from the matrix
     * pipeline (built from the CURRENT, pre-update center/lambda0) for the
     * target screen point and the current center screen point respectively;
     * their difference is a frame-independent screen-space-derived world
     * delta (the old center's lambda0 cancels out of a subtraction, so this
     * still works even though it's measured in the soon-to-be-replaced
     * frame).
     *
     * Vertical is lambda-free (world-y depends only on latitude), so it
     * inverts directly via `latFromEqualEarthWorldY`. Horizontal exploits the
     * lambda0-tracking invariant that center always sits at unit x 0.5: solve
     * for the new center longitude (lambda0') that reproduces the observed
     * x-offset for `lnglat` at ITS OWN latitude's x-scale
     * (`equalEarthXScaleAtLat`) -- not the new center's latitude, since it is
     * specifically `lnglat` that must land exactly on `point`.
     */
    setLocationAtPoint(lnglat: LngLat, point: Point): void {
        const z = mercatorZfromAltitude(this.elevation, this.center.lat);
        const a = this.screenPointToEqualEarthCoordinateAtZ(point, z);
        const b = this.screenPointToEqualEarthCoordinateAtZ(this.centerPoint, z);

        // Vertical: y_c' = y_unit(lat_loc) - (a.y - b.y), then invert.
        // lambda0 is irrelevant to y (equalEarthWorldFromLngLat's default 0
        // is fine -- y never depends on it), so only .y is used here.
        const locY = equalEarthWorldFromLngLat(lnglat.lng, lnglat.lat).y;
        const newCenterY = clamp(locY - (a.y - b.y), EQUAL_EARTH_WORLD_Y_NORTH_POLE, EQUAL_EARTH_WORLD_Y_SOUTH_POLE);
        const newCenterLat = latFromEqualEarthWorldY(newCenterY);

        // Horizontal: 0.5 + (lng_loc - lambda0') * scale - 0.5 = a.x - b.x
        // => lambda0' = lng_loc - (a.x - b.x) / scale. Division is always
        // safe: equalEarthXScaleAtLat is > 0 everywhere (EE's poles are
        // lines, not points -- no singularity).
        const scale = equalEarthXScaleAtLat(lnglat.lat);
        const newCenterLng = lnglat.lng - (a.x - b.x) / scale;

        this.setCenter(new LngLat(newCenterLng, newCenterLat));
        if (this._helper._renderWorldCopies) {
            this.setCenter(this.center.wrap());
        }
    }

    locationToScreenPoint(lnglat: LngLat, terrain?: Terrain): Point {
        const coord: EqualEarthCoordinate = equalEarthWorldFromLngLat(lnglat.lng, lnglat.lat, this.center.lng);
        return terrain ?
            this.coordinatePoint(coord, terrain.getElevationForLngLat(lnglat, this), this._pixelMatrix3D) :
            this.coordinatePoint(coord);
    }

    screenPointToLocation(p: Point, terrain?: Terrain): LngLat {
        const coord = this.screenPointToEqualEarthCoordinate(p, terrain);
        const {lng, lat} = lngLatFromEqualEarthWorld(coord.x, coord.y, this.center.lng);
        return new LngLat(lng, lat);
    }

    /**
     * Required by `ITransform` under this exact name (not renamed): tile
     * pyramids are always mercator-addressed regardless of the on-screen
     * projection, and external consumers (e.g. `covering_tiles.ts`,
     * `tile_manager.ts`) call it by this name on any transform. Mirrors how
     * `VerticalPerspectiveTransform` satisfies the same interface member for
     * globe: unproject through this projection's own inverse, then
     * re-express the result in mercator terms.
     */
    screenPointToMercatorCoordinate(p: Point, terrain?: Terrain): MercatorCoordinate {
        return MercatorCoordinate.fromLngLat(this.screenPointToLocation(p, terrain));
    }

    screenPointToEqualEarthCoordinate(p: Point, terrain?: Terrain): EqualEarthCoordinate {
        // terrain.pointCoordinate returns a MercatorCoordinate (DEM data is
        // mercator-tiled, not Equal-Earth-tiled), so it must be re-expressed
        // in Equal Earth space before returning — callers feed x/y straight
        // into lngLatFromEqualEarthWorld. Terrain support overall is a
        // non-goal for this projection and this branch is unverified beyond
        // that coordinate-space conversion.
        if (terrain) {
            const coordinate = terrain.pointCoordinate(p);
            if (coordinate != null) {
                const lngLat = coordinate.toLngLat();
                // Same unit-square y-down world convention as the AtZ path
                // below (see `EqualEarthCoordinate`).
                const {x, y} = equalEarthWorldFromLngLat(lngLat.lng, lngLat.lat, this.center.lng);
                return {x, y, z: coordinate.z};
            }
        }
        return this.screenPointToEqualEarthCoordinateAtZ(p);
    }

    screenPointToEqualEarthCoordinateAtZ(p: Point, equalEarthZ?: number): EqualEarthCoordinate {

        // calculate point-coordinate on flat earth
        const targetZ = equalEarthZ ? equalEarthZ : 0;
        // since we don't know the correct projected z value for the point,
        // unproject two points to get a line and then find the point on that
        // line with z=0

        const coord0 = [p.x, p.y, 0, 1] as vec4;
        const coord1 = [p.x, p.y, 1, 1] as vec4;

        vec4.transformMat4(coord0, coord0, this._pixelMatrixInverse);
        vec4.transformMat4(coord1, coord1, this._pixelMatrixInverse);

        const w0 = coord0[3];
        const w1 = coord1[3];
        const x0 = coord0[0] / w0;
        const x1 = coord1[0] / w1;
        const y0 = coord0[1] / w0;
        const y1 = coord1[1] / w1;
        const z0 = coord0[2] / w0;
        const z1 = coord1[2] / w1;

        const t = z0 === z1 ? 0 : (targetZ - z0) / (z1 - z0);

        return {
            x: interpolates.number(x0, x1, t) / this.worldSize,
            y: interpolates.number(y0, y1, t) / this.worldSize,
            z: targetZ
        };
    }

    /**
     * Given a coordinate, return the screen point that corresponds to it
     * @param coord - the coordinates
     * @param elevation - the elevation
     * @param pixelMatrix - the pixel matrix
     * @returns screen point
     */
    coordinatePoint(coord: EqualEarthCoordinate, elevation: number = 0, pixelMatrix: mat4 = this._pixelMatrix): Point {
        const p = [coord.x * this.worldSize, coord.y * this.worldSize, elevation, 1] as vec4;
        vec4.transformMat4(p, p, pixelMatrix);
        return new Point(p[0] / p[3], p[1] / p[3]);
    }

    getBounds(): LngLatBounds {
        const top = Math.max(0, this._helper._height / 2 - getMercatorHorizon(this));
        return new LngLatBounds()
            .extend(this.screenPointToLocation(new Point(0, top)))
            .extend(this.screenPointToLocation(new Point(this._helper._width, top)))
            .extend(this.screenPointToLocation(new Point(this._helper._width, this._helper._height)))
            .extend(this.screenPointToLocation(new Point(0, this._helper._height)));
    }

    isPointOnMapSurface(p: Point, terrain?: Terrain): boolean {
        if (terrain) {
            const coordinate = terrain.pointCoordinate(p);
            return coordinate != null;
        }
        return (p.y > this.height / 2 - getMercatorHorizon(this));
    }

    /**
     * Calculate the posMatrix that, given a tile coordinate, would be used to display the tile on a map.
     * This function is specific to the mercator projection.
     * @param tileID - the tile ID
     * @param aligned - whether to use a pixel-aligned matrix variant, intended for rendering raster tiles
     * @param useFloat32 - when true, returns a float32 matrix instead of float64. Use float32 for matrices that are passed to shaders, use float64 for everything else.
     */
    calculatePosMatrix(tileID: UnwrappedTileID | OverscaledTileID, aligned: boolean | undefined, useFloat32: true): Mat4f32;
    calculatePosMatrix(tileID: UnwrappedTileID | OverscaledTileID, aligned?: boolean, useFloat32?: false): Mat4f64;
    calculatePosMatrix(tileID: UnwrappedTileID | OverscaledTileID, aligned: boolean = false, useFloat32: boolean = false): Mat4f32 | Mat4f64 {
        const posMatrixKey = tileID.key ?? calculateTileKey(tileID.wrap, tileID.canonical.z, tileID.canonical.z, tileID.canonical.x, tileID.canonical.y);
        const cache = aligned ? this._alignedPosMatrixCache : this._posMatrixCache;
        if (cache.has(posMatrixKey)) {
            const matrices = cache.get(posMatrixKey);
            return useFloat32 ? matrices.f32 : matrices.f64;
        }

        const tileMatrix = calculateTileMatrix(tileID, this.worldSize);
        mat4.multiply(tileMatrix, aligned ? this._alignedProjMatrix : this._viewProjMatrix, tileMatrix);
        const matrices: {f64: Mat4f64; f32: Mat4f32} = {
            f64: tileMatrix,
            f32: new Float32Array(tileMatrix), // Must have a 32 bit float version for WebGL, otherwise WebGL calls in Chrome get very slow.
        };
        cache.set(posMatrixKey, matrices);
        // Make sure to return the correct precision
        return useFloat32 ? matrices.f32 : matrices.f64;
    }

    calculateFogMatrix(unwrappedTileID: UnwrappedTileID): mat4 {
        const posMatrixKey = unwrappedTileID.key;
        const cache = this._fogMatrixCacheF32;
        if (cache.has(posMatrixKey)) {
            return cache.get(posMatrixKey);
        }

        const fogMatrix = calculateTileMatrix(unwrappedTileID, this.worldSize);
        mat4.multiply(fogMatrix, this._fogMatrix, fogMatrix);

        cache.set(posMatrixKey, new Float32Array(fogMatrix)); // Must be 32 bit floats, otherwise WebGL calls in Chrome get very slow.
        return cache.get(posMatrixKey);
    }

    /**
     * Stage B step 8 (Mechanism 3 -- "zoom-dependent constraint" in the
     * design doc). Per-axis, both assuming bearing/pitch = 0 (both are 0
     * everywhere in this project so far -- a recorded limitation, not
     * solved here; see the design doc).
     *
     * Horizontal: lng passes through unchanged. lng IS lambda0, and the
     * lambda0-tracking design (center always at unit x 0.5, see the "Core
     * decision" in the design doc) makes east-west void structurally
     * impossible at any zoom -- the outline sits at a fixed screen distance
     * from center regardless of lambda0's value. No lngRange clamp, by
     * design.
     *
     * Vertical: content only occupies world-y in
     * [EQUAL_EARTH_WORLD_Y_NORTH_POLE, EQUAL_EARTH_WORLD_Y_SOUTH_POLE] (the
     * pole lines), not the full [0,1] mercator uses. The usable center-y
     * interval that keeps both edges void-free is
     * [Y_TOP*ws + h/2, Y_BOT*ws - h/2] (a world size for the REQUESTED zoom,
     * not the current one -- matches `MercatorTransform.defaultConstrain`'s
     * own pattern). If that interval is empty (world content shorter than
     * the viewport -- the low-zoom "full extent fits" regime), no single
     * center-y keeps both edges void-free at once: hard-lock lat to the
     * equator (vertical drag does nothing at this zoom; horizontal drag
     * still rotates the world through the fixed outline -- see the design
     * doc's owner-review flag on this point). Otherwise clamp center world-y
     * into the interval and invert via `latFromEqualEarthWorldY` -- poles
     * lock to the viewport edges, void never enters top/bottom.
     *
     * `setMaxBounds` remains a documented no-op for this projection
     * (unchanged from Stage A).
     */
    defaultConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        const constrainedZoom = clamp(+zoom, this.minZoom, this.maxZoom);
        // Equal Earth's forward function is well-defined exactly at the poles
        // (unlike mercator's asymptotic blowup), so clamp to the true range
        // here instead of carrying over mercator's tighter MAX_VALID_LATITUDE
        // (85.05 degrees), which would be wrong for this projection.
        let constrainedLat = clamp(lngLat.lat, -90, 90);

        const worldSize = this.tileSize * zoomScale(constrainedZoom);
        const screenHeight = this.size.y;
        const minCenterY = EQUAL_EARTH_WORLD_Y_NORTH_POLE * worldSize + screenHeight / 2;
        const maxCenterY = EQUAL_EARTH_WORLD_Y_SOUTH_POLE * worldSize - screenHeight / 2;
        if (minCenterY > maxCenterY) {
            constrainedLat = 0;
        } else {
            const centerY = equalEarthWorldFromLngLat(0, constrainedLat).y * worldSize;
            const clampedCenterY = clamp(centerY, minCenterY, maxCenterY);
            constrainedLat = latFromEqualEarthWorldY(clampedCenterY / worldSize);
        }

        return {
            center: new LngLat(lngLat.lng, constrainedLat),
            zoom: constrainedZoom
        };
    };

    applyConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        return this._helper.applyConstrain(lngLat, zoom);
    };

    calculateCenterFromCameraLngLatAlt(lnglat: LngLatLike, alt: number, bearing?: number, pitch?: number): {center: LngLat; elevation: number; zoom: number} {
        return this._helper.calculateCenterFromCameraLngLatAlt(lnglat, alt, bearing, pitch);
    }

    _calculateNearFarZIfNeeded(cameraToSeaLevelDistance: number, limitedPitchRadians: number, offset: Point): void {
        if (!this._helper.autoCalculateNearFarZ) {
            return;
        }
        // In case of negative minimum elevation (e.g. the dead see, under the sea maps) use a lower plane for calculation
        const minRenderDistanceBelowCameraInMeters = 100;
        const minElevation = Math.min(this.elevation, this.minElevationForCurrentTile, this.getCameraAltitude() - minRenderDistanceBelowCameraInMeters);
        const cameraToLowestPointDistance = cameraToSeaLevelDistance - minElevation * this._helper._pixelPerMeter / Math.cos(limitedPitchRadians);
        const lowestPlane = minElevation < 0 ? cameraToLowestPointDistance : cameraToSeaLevelDistance;

        // Find the distance from the center point [width/2 + offset.x, height/2 + offset.y] to the
        // center top point [width/2 + offset.x, 0] in Z units, using the law of sines.
        // 1 Z unit is equivalent to 1 horizontal px at the center of the map
        // (the distance between[width/2, height/2] and [width/2 + 1, height/2])
        const groundAngle = Math.PI / 2 + this.pitchInRadians;
        const zfov = degreesToRadians(this.fov) * (Math.abs(Math.cos(degreesToRadians(this.roll))) * this.height + Math.abs(Math.sin(degreesToRadians(this.roll))) * this.width) / this.height;
        const fovAboveCenter = zfov * (0.5 + offset.y / this.height);
        const topHalfSurfaceDistance = Math.sin(fovAboveCenter) * lowestPlane / Math.sin(clamp(Math.PI - groundAngle - fovAboveCenter, 0.01, Math.PI - 0.01));

        // Find the distance from the center point to the horizon
        const horizon = getMercatorHorizon(this);
        const horizonAngle = Math.atan(horizon / this._helper.cameraToCenterDistance);
        const minFovCenterToHorizonRadians = degreesToRadians(90 - maxMercatorHorizonAngle);
        const fovCenterToHorizon = horizonAngle > minFovCenterToHorizonRadians ? 2 * horizonAngle * (0.5 + offset.y / (horizon * 2)) : minFovCenterToHorizonRadians;
        const topHalfSurfaceDistanceHorizon = Math.sin(fovCenterToHorizon) * lowestPlane / Math.sin(clamp(Math.PI - groundAngle - fovCenterToHorizon, 0.01, Math.PI - 0.01));

        // Calculate z distance of the farthest fragment that should be rendered.
        // Add a bit extra to avoid precision problems when a fragment's distance is exactly `furthestDistance`
        const topHalfMinDistance = Math.min(topHalfSurfaceDistance, topHalfSurfaceDistanceHorizon);

        this._helper._farZ = (Math.cos(Math.PI / 2 - limitedPitchRadians) * topHalfMinDistance + lowestPlane) * 1.01;

        // The larger the value of nearZ is
        // - the more depth precision is available for features (good)
        // - clipping starts appearing sooner when the camera is close to 3d features (bad)
        //
        // Other values work for mapbox-gl-js but deck.gl was encountering precision issues
        // when rendering custom layers. This value was experimentally chosen and
        // seems to solve z-fighting issues in deck.gl while not clipping buildings too close to the camera.
        this._helper._nearZ = this._helper._height / 50;
    }

    _calcMatrices(): void {
        if (!this._helper._height) return;

        const offset = this.centerOffset;
        // lambda0 === center.lng means Delta-lambda is always exactly 0 here,
        // so point.x is always exactly 0.5 * worldSize -- the camera never
        // translates horizontally (see the design doc's "Core decision").
        // Passed explicitly anyway (rather than hardcoding 0.5) so this stays
        // correct if that invariant is ever revisited, and so the call site
        // documents its own lambda0 rather than relying on the reader
        // knowing the identity holds.
        const point = projectToEqualEarthWorldCoordinates(this.worldSize, this.center, this.center.lng);
        const x = point.x, y = point.y;
        this._helper._pixelPerMeter = mercatorZfromAltitude(1, this.center.lat) * this.worldSize;

        // Calculate the camera to sea-level distance in pixel in respect of terrain
        const limitedPitchRadians = degreesToRadians(Math.min(this.pitch, maxMercatorHorizonAngle));
        const cameraToSeaLevelDistance = Math.max(this._helper.cameraToCenterDistance / 2, this._helper.cameraToCenterDistance + this._helper._elevation * this._helper._pixelPerMeter / Math.cos(limitedPitchRadians));

        this._calculateNearFarZIfNeeded(cameraToSeaLevelDistance, limitedPitchRadians, offset);

        // matrix for conversion from location to clip space(-1 .. 1)
        let m: mat4;
        m = new Float64Array(16);
        mat4.perspective(m, this.fovInRadians, this._helper._width / this._helper._height, this._helper._nearZ, this._helper._farZ);
        this._invProjMatrix = new Float64Array(16);
        fastInvertProjMat4(this._invProjMatrix, m);

        // Apply center of perspective offset
        m[8] = -offset.x * 2 / this._helper._width;
        m[9] = offset.y * 2 / this._helper._height;
        this._projectionMatrix = mat4.clone(m);

        mat4.scale(m, m, [1, -1, 1]);
        mat4.translate(m, m, [0, 0, -this._helper.cameraToCenterDistance]);
        mat4.rotateZ(m, m, -this.rollInRadians);
        mat4.rotateX(m, m, this.pitchInRadians);
        mat4.rotateZ(m, m, -this.bearingInRadians);
        mat4.translate(m, m, [-x, -y, 0]);

        // Unlike MercatorTransform, no `mercatorMatrix` here: it is explicitly
        // documented as "not part of ITransform interface" on the mercator
        // class, has no external references (grepped `\.mercatorMatrix` across
        // src/ outside mercator_transform.ts), and its own doc comment
        // ("transform points from mercator coordinates ([0, 0] nw, [1, 1] se)
        // to clip space") describes a concept this projection doesn't have --
        // Equal Earth's own plane isn't a [0,1]x[0,1] square. Dropped rather
        // than kept-but-repurposed under a now-misleading name.

        // scale vertically to meters per pixel (inverse of ground resolution):
        mat4.scale(m, m, [1, 1, this._helper._pixelPerMeter]);

        // matrix for conversion from world space to screen coordinates in 2D
        this._pixelMatrix = mat4.multiply(new Float64Array(16), this.clipSpaceToPixelsMatrix, m);

        // matrix for conversion from world space to clip space (-1 .. 1)
        mat4.translate(m, m, [0, 0, -this.elevation]); // elevate camera over terrain
        this._viewProjMatrix = m;
        this._invViewProjMatrix = mat4.invert([], m);

        // The equalEarthMatrix transforms y-down *unit* Equal Earth coordinates
        // (the ones the equal-earth shader computes per-vertex) to clip space --
        // the same role mercator's `mercatorMatrix` plays for mercator [0..1]
        // coordinates. It is per-frame, not per-tile, so the f32 copy for the
        // shader uniform is derived once here rather than in getProjectionData.
        this._equalEarthMatrix = mat4.scale([], this._viewProjMatrix, [this.worldSize, this.worldSize, this.worldSize]);
        this._equalEarthMatrix32f = new Float32Array(this._equalEarthMatrix);

        const cameraPos: vec4 = [0, 0, -1, 1];
        vec4.transformMat4(cameraPos, cameraPos, this._invViewProjMatrix);
        this._cameraPosition = [
            cameraPos[0] / cameraPos[3],
            cameraPos[1] / cameraPos[3],
            cameraPos[2] / cameraPos[3]
        ];

        // create a fog matrix, same es proj-matrix but with near clipping-plane in mapcenter
        // needed to calculate a correct z-value for fog calculation, because projMatrix z value is not
        this._fogMatrix = new Float64Array(16);
        mat4.perspective(this._fogMatrix, this.fovInRadians, this.width / this.height, cameraToSeaLevelDistance, this._helper._farZ);
        this._fogMatrix[8] = -offset.x * 2 / this.width;
        this._fogMatrix[9] = offset.y * 2 / this.height;
        mat4.scale(this._fogMatrix, this._fogMatrix, [1, -1, 1]);
        mat4.translate(this._fogMatrix, this._fogMatrix, [0, 0, -this.cameraToCenterDistance]);
        mat4.rotateZ(this._fogMatrix, this._fogMatrix, -this.rollInRadians);
        mat4.rotateX(this._fogMatrix, this._fogMatrix, this.pitchInRadians);
        mat4.rotateZ(this._fogMatrix, this._fogMatrix, -this.bearingInRadians);
        mat4.translate(this._fogMatrix, this._fogMatrix, [-x, -y, 0]);
        mat4.scale(this._fogMatrix, this._fogMatrix, [1, 1, this._helper._pixelPerMeter]);
        mat4.translate(this._fogMatrix, this._fogMatrix, [0, 0, -this.elevation]); // elevate camera over terrain

        // matrix for conversion from world space to screen coordinates in 3D
        this._pixelMatrix3D = mat4.multiply(new Float64Array(16), this.clipSpaceToPixelsMatrix, m);

        // Make a second projection matrix that is aligned to a pixel grid for rendering raster tiles.
        // We're rounding the (floating point) x/y values to achieve to avoid rendering raster images to fractional
        // coordinates. Additionally, we adjust by half a pixel in either direction in case that viewport dimension
        // is an odd integer to preserve rendering to the pixel grid. We're rotating this shift based on the angle
        // of the transformation so that 0°, 90°, 180°, and 270° rasters are crisp, and adjust the shift so that
        // it is always <= 0.5 pixels.
        const xShift = (this._helper._width % 2) / 2, yShift = (this._helper._height % 2) / 2,
            angleCos = Math.cos(this.bearingInRadians), angleSin = Math.sin(-this.bearingInRadians),
            dx = x - Math.round(x) + angleCos * xShift + angleSin * yShift,
            dy = y - Math.round(y) + angleCos * yShift + angleSin * xShift;
        const alignedM = new Float64Array(m) as any as mat4;
        mat4.translate(alignedM, alignedM, [dx > 0.5 ? dx - 1 : dx, dy > 0.5 ? dy - 1 : dy, 0]);
        this._alignedProjMatrix = alignedM;

        // inverse matrix for conversion from screen coordinates to location
        m = mat4.invert(new Float64Array(16), this._pixelMatrix);
        if (!m) throw new Error('failed to invert matrix');
        this._pixelMatrixInverse = m;

        this._clearMatrixCaches();
    }

    private _clearMatrixCaches(): void {
        this._posMatrixCache.clear();
        this._alignedPosMatrixCache.clear();
        this._fogMatrixCacheF32.clear();
    }

    maxPitchScaleFactor(): number {
        // calcMatrices hasn't run yet
        if (!this._pixelMatrixInverse) return 1;

        const coord = this.screenPointToEqualEarthCoordinate(new Point(0, 0));
        const p = [coord.x * this.worldSize, coord.y * this.worldSize, 0, 1] as vec4;
        const topPoint = vec4.transformMat4(p, p, this._pixelMatrix);
        return topPoint[3] / this._helper.cameraToCenterDistance;
    }

    getCameraPoint(): Point {
        return this._helper.getCameraPoint();
    }

    getCameraAltitude(): number {
        return this._helper.getCameraAltitude();
    }

    getCameraLngLat(): LngLat {
        const pixelPerMeter = mercatorZfromAltitude(1, this.center.lat) * this.worldSize;
        const cameraToCenterDistanceMeters = this._helper.cameraToCenterDistance / pixelPerMeter;
        const camMercator = cameraMercatorCoordinateFromCenterAndRotation(this.center, this.elevation, this.pitch, this.bearing, cameraToCenterDistanceMeters);
        return camMercator.toLngLat();
    }

    lngLatToCameraDepth(lngLat: LngLat, elevation: number): number {
        const coord = equalEarthWorldFromLngLat(lngLat.lng, lngLat.lat, this.center.lng);
        const p = [coord.x * this.worldSize, coord.y * this.worldSize, elevation, 1] as vec4;
        vec4.transformMat4(p, p, this._viewProjMatrix);
        return (p[2] / p[3]);
    }

    getProjectionData(params: ProjectionDataParams): RendererProjectionData {
        const {overscaledTileID, aligned, applyTerrainMatrix, applyGlobeMatrix} = params;
        const mercatorTileCoordinates = this._helper.getMercatorTileCoordinates(overscaledTileID);
        if (overscaledTileID) {
            // Mechanism 2 (Stage B step 8): fold both world-copy wrap and the
            // live lambda0 into the shader's recovered lng in one seam,
            // entirely CPU-side -- zero GLSL changes, zero new uniforms (see
            // the design doc's "Mechanism 2"). Verified before relying on it
            // (grepped tileMercatorCoords' non-GLSL consumers): the only ones
            // are projection_program.ts's uniform-name mapping and
            // painter.ts's inert [0,0,1,1] placeholder object for tile-less
            // draws -- nothing reads these four numbers as anything but the
            // shader uniform, so this is a safe sole seam.
            // TransformHelper.getMercatorTileCoordinates is canonical-tile-only
            // (no wrap term); OverscaledTileID.wrap must be added here, or
            // wrapped world copies would render stacked on top of wrap 0.
            // Shader-side: lng = (this.x) * 2*PI - PI, so adding `wrap` (a
            // whole tile-grid turn) shifts lng by wrap*360 degrees, and
            // subtracting center.lng/360 shifts it by -center.lng degrees --
            // together giving exactly the unwrapped `lng - lambda0` the
            // vertex shader's Equal Earth polynomial expects.
            mercatorTileCoordinates[0] += overscaledTileID.wrap - this.center.lng / 360;
        }
        const tilePosMatrix = overscaledTileID ? this.calculatePosMatrix(overscaledTileID, aligned, true) : null;

        // Unlike mercator, an Equal Earth tile's on-screen footprint is not an
        // affine image of its mercator footprint -- the bending happens
        // per-vertex in the shader -- so mainMatrix is the whole-world
        // equalEarthMatrix consuming the shader's y-down unit EE coordinates,
        // not a per-tile matrix. The per-tile mercator pos matrix goes in
        // fallbackMatrix, which is its documented purpose (Stage C's
        // projection blend will mix toward it).
        let fallbackMatrix: Mat4f32;
        if (overscaledTileID?.terrainRttPosMatrix32f && applyTerrainMatrix) {
            fallbackMatrix = overscaledTileID.terrainRttPosMatrix32f;
        } else if (tilePosMatrix) {
            fallbackMatrix = tilePosMatrix; // This matrix should be float32
        } else {
            fallbackMatrix = createIdentityMat4f32();
        }
        return {
            mainMatrix: this._equalEarthMatrix32f,
            tileMercatorCoords: mercatorTileCoordinates,
            clippingPlane: [0, 0, 0, 0],
            // Mirrors vertical_perspective_transform.ts: 1 marks this renderer
            // state as fully "the projection", not mercator. The equal-earth
            // shader itself never reads u_projection_transition (no Stage-A
            // blend), and the other GLSL consumers are all #ifdef GLOBE, so
            // this only drives the TS-side sky/atmosphere blends.
            projectionTransition: applyGlobeMatrix ? 1 : 0,
            fallbackMatrix,
        };
    }

    isLocationOccluded(_: LngLat): boolean {
        return false;
    }

    getPixelScale(): number {
        return 1.0;
    }

    getCircleRadiusCorrection(): number {
        return 1.0;
    }

    getPitchedTextCorrection(_textAnchorX: number, _textAnchorY: number, _tileID: UnwrappedTileID): number {
        return 1.0;
    }

    transformLightDirection(dir: vec3): vec3 {
        return vec3.clone(dir);
    }

    getRayDirectionFromPixel(_p: Point): vec3 {
        throw new Error('Not implemented.'); // No need for this in equal earth transform
    }

    projectTileCoordinates(x: number, y: number, unwrappedTileID: UnwrappedTileID, getElevation: (x: number, y: number) => number): PointProjection {
        const matrix = this.calculatePosMatrix(unwrappedTileID);
        let pos;
        if (getElevation) { // slow because of handle z-index
            pos = [x, y, getElevation(x, y), 1] as vec4;
            vec4.transformMat4(pos, pos, matrix);
        } else { // fast because of ignore z-index
            pos = [x, y, 0, 1] as vec4;
            xyTransformMat4(pos, pos, matrix);
        }
        const w = pos[3];
        return {
            point: new Point(pos[0] / w, pos[1] / w),
            signedDistanceFromCamera: w,
            isOccluded: false
        };
    }

    populateCache(coords: OverscaledTileID[]): void {
        for (const coord of coords) {
            // Return value is thrown away, but this function will still
            // place the pos matrix into the transform's internal cache.
            this.calculatePosMatrix(coord);
        }
    }

    getProjectionDataForCustomLayer(applyGlobeMatrix: boolean = true): CustomLayerProjectionData {
        // Custom layers stay mercator-positioned in Stage A (both matrices are
        // overridden below with the mercator-scaled tile matrix): custom layers
        // run their own shaders on mercator [0..1] inputs and cannot consume
        // the Equal Earth mainMatrix, so misplacement relative to the EE base
        // map is a known, deliberate Stage-A defect -- same class as symbol
        // placement.
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
        const rendererProjectionData = this.getProjectionData({overscaledTileID: tileID, applyGlobeMatrix});
        const tileMatrix = calculateTileMatrix(tileID, this.worldSize);
        mat4.multiply(tileMatrix, this._viewProjMatrix, tileMatrix);

        // Even though we requested projection data for the mercator base tile which covers the entire mercator range,
        // the shader projection machinery still expects inputs to be in tile units range [0..EXTENT].
        // Since custom layers are expected to supply mercator coordinates [0..1], we need to rescale
        // both matrices by EXTENT. We also need to rescale Z.

        const scale: vec3 = [EXTENT, EXTENT, this.worldSize / this._helper.pixelsPerMeter];

        // We pass full-precision 64bit float matrices to custom layers to prevent precision loss in case the user wants to do further transformations.
        // Otherwise we get very visible precision-artifacts and twitching for objects that are bulding-scale.
        const projectionMatrixScaled = createMat4f64();
        mat4.scale(projectionMatrixScaled, tileMatrix, scale);

        return {
            ...rendererProjectionData,
            tileMercatorCoords: [0, 0, 1, 1],
            fallbackMatrix: projectionMatrixScaled,
            mainMatrix: projectionMatrixScaled,
        };
    }

    getFastPathSimpleProjectionMatrix(_tileID: OverscaledTileID): mat4 {
        // Offering the per-tile mercator matrix here would let symbol
        // placement (src/symbol/placement.ts) project anchors with a bare
        // matrix multiply, bypassing the Equal Earth shader positioning.
        // Follow VerticalPerspectiveTransform's precedent: no fast path.
        return undefined;
    }
}
