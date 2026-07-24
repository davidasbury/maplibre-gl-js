import type {mat2, mat4, vec3, vec4} from 'gl-matrix';
import {TransformHelper} from '../transform_helper.ts';
import {MercatorTransform} from './mercator_transform.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';
import {LngLat, type LngLatLike} from '../lng_lat.ts';
import {clamp, degreesToRadians, lerp, zoomScale} from '../../util/util.ts';
import {mercatorXfromLng, mercatorYfromLat} from '../mercator_coordinate.ts';
import {equalEarthWorldFromLngLat, equalEarthXScaleAtLat, EQUAL_EARTH_WORLD_Y_NORTH_POLE, EQUAL_EARTH_WORLD_Y_SOUTH_POLE} from '../equal_earth_coordinate.ts';
import type {OverscaledTileID, UnwrappedTileID, CanonicalTileID} from '../../tile/tile_id.ts';

import Point from '@mapbox/point-geometry';
import type {MercatorCoordinate} from '../mercator_coordinate.ts';
import type {LngLatBounds} from '../lng_lat_bounds.ts';
import type {Frustum} from '../../util/primitives/frustum.ts';
import type {Terrain} from '../../render/terrain.ts';
import type {PointProjection} from '../../symbol/projection.ts';
import type {IReadonlyTransform, ITransform, TransformConstrainFunction} from '../transform_interface.ts';
import type {TransformOptions} from '../transform_helper.ts';
import type {PaddingOptions} from '../edge_insets.ts';
import type {CustomLayerProjectionData, ProjectionDataParams, RendererProjectionData} from './projection_data.ts';
import type {CoveringTilesDetailsProvider} from './covering_tiles_details_provider.ts';

/**
 * Stage C (plan step 11): the composite transform for the adaptive Equal
 * Earth projection, mirroring `GlobeTransform`'s pattern — an
 * `EqualEarthTransform` and a `MercatorTransform` sharing one
 * `TransformHelper`'s camera state, with a transition value (1 = Equal
 * Earth, 0 = mercator, driven by the projection's zoom expression via
 * `setTransitionState`).
 *
 * The positional morph is a clip-space `mix()` in the Equal Earth shader
 * chunk: `getProjectionData` merges the EE data (mainMatrix, tile coords,
 * linearized-path fields) with the mercator transform's per-tile matrix as
 * `fallbackMatrix` and the transition as `projectionTransition`. Because
 * both endpoints render the same helper center at the screen center, the
 * point under the viewport center stays put through the morph
 * (center-anchored, per the plan). EE↔mercator is a flat↔flat blend —
 * simpler than globe's: no clipping plane, no pole fade, no latitude error
 * correction.
 *
 * CPU-side point queries and symbol placement delegate to whichever
 * endpoint dominates (`transition > 0` → EE), the same approximation globe
 * makes mid-blend; refining blend-phase feel is plan step 13.
 */
export class EqualEarthAdaptiveTransform implements ITransform {
    private _helper: TransformHelper;

    //
    // Implementation of transform getters and setters — delegated to the
    // shared helper, verbatim from the GlobeTransform template.
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
    /**
     * Camera-angle ease-to-flat (step 13/14 opener, owner design): unlike
     * static EqualEarthTransform, which hard-clamps bearing/pitch/roll to
     * 0 always (Equal Earth's geometry — clip stencil, covering-tiles —
     * assumes an unrotated top-down view), the adaptive composite
     * supports full 3D camera angles in pure mercator and eases them to 0
     * as the blend enters Equal Earth territory, mirroring how Google
     * Maps eases tilt to flat as you zoom out past its 3D threshold — no
     * hard snap. `_requestedX` is what the caller asked for (what
     * `setBearing`/`setPitch`/`setRoll` remember); the value actually
     * pushed into `_helper` (and therefore `this.bearing`/`.pitch`/
     * `.roll`, and everything downstream — camera matrices, symbol
     * placement) is `_requestedX * (1 - eeness)`: full value at eeness=0
     * (pure mercator), continuously decaying to exactly 0 at eeness=1
     * (pure Equal Earth), tied to the same transition value driving the
     * projection morph rather than a separate threshold — re-tilting
     * while zooming back toward mercator eases back up the same way.
     */
    private _requestedBearing: number = 0;
    private _requestedPitch: number = 0;
    private _requestedRoll: number = 0;

    private _applyDecayedCameraAngles(): void {
        const k = 1 - this._eeness;
        this._helper.setBearing(this._requestedBearing * k);
        this._helper.setPitch(this._requestedPitch * k);
        this._helper.setRoll(this._requestedRoll * k);
    }

    setBearing(bearing: number): void {
        this._requestedBearing = bearing;
        this._helper.setBearing(bearing * (1 - this._eeness));
    }
    setPitch(pitch: number): void {
        this._requestedPitch = pitch;
        this._helper.setPitch(pitch * (1 - this._eeness));
    }
    setRoll(roll: number): void {
        this._requestedRoll = roll;
        this._helper.setRoll(roll * (1 - this._eeness));
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
    resize(width: number, height: number, constrainTransform: boolean = true): void {
        this._helper.resize(width, height, constrainTransform);
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

    //
    // Implementation of the adaptive Equal Earth transform
    //

    /**
     * Blend factor: 1 = Equal Earth, 0 = mercator, between = positional
     * interpolation (the shader-side mix). Same orientation as globe's
     * `_globeness`.
     */
    private _eeness: number = 1.0;
    private _mercatorTransform: MercatorTransform;
    private _equalEarthTransform: EqualEarthTransform;

    /**
     * Step 13 lambda0 freeze: the central meridian used for drag while
     * mid-blend or pure mercator, pinned at whatever `center.lng` was the
     * instant the blend first left pure Equal Earth (null = unfrozen,
     * pure-EE regime, lambda0 tracks `center.lng` live per Stage B).
     * Dragging no longer rotates this value once frozen — it translates in
     * blended-world-x instead ("drag degrades to planar pan").
     */
    private _frozenLambda0: number | null = null;

    /**
     * True when the Equal Earth render path (shader variant, covering
     * tiles, constrain) should be used instead of plain mercator.
     */
    get isEqualEarthRendering(): boolean {
        return this._eeness > 0;
    }

    setTransitionState(eeness: number, _errorCorrectionValue: number): void {
        this._eeness = eeness ?? 1;
        if (this._eeness >= 1) {
            this._frozenLambda0 = null;
        } else if (this._frozenLambda0 === null) {
            this._frozenLambda0 = this.center.lng;
        }
        // Re-derive the decayed camera angles for the new eeness — this
        // is what actually eases pitch/bearing/roll toward 0 as a zoom
        // (not just an explicit setPitch/setBearing call) carries the
        // blend from pure mercator into Equal Earth territory.
        this._applyDecayedCameraAngles();
        this._calcMatrices();
        this._equalEarthTransform.getCoveringTilesDetailsProvider().prepareNextFrame();
        this._mercatorTransform.getCoveringTilesDetailsProvider().prepareNextFrame();
    }

    private get currentTransform(): ITransform {
        return this.isEqualEarthRendering ? this._equalEarthTransform : this._mercatorTransform;
    }

    public constructor(options?: TransformOptions) {
        this._helper = new TransformHelper({
            calcMatrices: () => this._calcMatrices(),
            defaultConstrain: (center, zoom) => { return this.defaultConstrain(center, zoom); }
        }, options);
        this._eeness = 1; // Symbol-placement clones never see _updateAnimation; match GlobeTransform's convention.
        this._mercatorTransform = new MercatorTransform();
        this._equalEarthTransform = new EqualEarthTransform();
    }

    clone(): ITransform {
        const clone = new EqualEarthAdaptiveTransform();
        clone._eeness = this._eeness;
        clone._frozenLambda0 = this._frozenLambda0;
        clone._requestedBearing = this._requestedBearing;
        clone._requestedPitch = this._requestedPitch;
        clone._requestedRoll = this._requestedRoll;
        clone.apply(this, false);
        return clone;
    }

    public apply(that: IReadonlyTransform, constrain: boolean): void {
        this._helper.apply(that, constrain);
        if (!(that instanceof EqualEarthAdaptiveTransform)) {
            // Entering this projection from a different transform type
            // (e.g. a plain mercator/globe map switching to
            // equal-earth-adaptive): its bearing/pitch/roll become the
            // new request, then get re-decayed for this transform's own
            // eeness below. Same-type sources (clone()) already copied
            // the request explicitly above; `that.bearing` there would
            // only expose the already-decayed value, so skip re-deriving.
            this._requestedBearing = that.bearing;
            this._requestedPitch = that.pitch;
            this._requestedRoll = that.roll;
        }
        this._applyDecayedCameraAngles();
        this._mercatorTransform.apply(this, false);
        this._equalEarthTransform.apply(this, false);
    }

    public get projectionMatrix(): mat4 { return this.currentTransform.projectionMatrix; }

    public get modelViewProjectionMatrix(): mat4 { return this.currentTransform.modelViewProjectionMatrix; }

    public get inverseProjectionMatrix(): mat4 { return this.currentTransform.inverseProjectionMatrix; }

    public get cameraPosition(): vec3 { return this.currentTransform.cameraPosition; }

    getProjectionData(params: ProjectionDataParams): RendererProjectionData {
        const eeProjectionData = this._equalEarthTransform.getProjectionData(params);
        if (!this.isEqualEarthRendering) {
            // Pure mercator regime: render exactly what MercatorTransform
            // would (mercator shader variant is active — see the adaptive
            // projection's shaderVariantName delegation).
            return this._mercatorTransform.getProjectionData(params);
        }
        const mercatorProjectionData = this._mercatorTransform.getProjectionData(params);
        return {
            // The EE shader consumes the EE mainMatrix and tile coords
            // (including the linearized-path sentinel fields) and mixes its
            // clip position toward fallbackMatrix * posInTile by
            // projectionTransition — so the fallback must be the MERCATOR
            // transform's per-tile matrix for the blend to land exactly on
            // the pure-mercator rendering at transition 0.
            mainMatrix: eeProjectionData.mainMatrix,
            tileMercatorCoords: eeProjectionData.tileMercatorCoords,
            clippingPlane: eeProjectionData.clippingPlane,
            projectionTransition: params.applyGlobeMatrix ? this._eeness : 0,
            fallbackMatrix: mercatorProjectionData.fallbackMatrix,
            equalEarthQuadUV: eeProjectionData.equalEarthQuadUV,
            equalEarthQuadVV: eeProjectionData.equalEarthQuadVV,
        };
    }

    public isLocationOccluded(location: LngLat): boolean {
        return this.currentTransform.isLocationOccluded(location);
    }

    public transformLightDirection(dir: vec3): vec3 {
        return this.currentTransform.transformLightDirection(dir);
    }

    public getPixelScale(): number {
        return lerp(this._mercatorTransform.getPixelScale(), this._equalEarthTransform.getPixelScale(), this._eeness);
    }

    public getCircleRadiusCorrection(): number {
        return lerp(this._mercatorTransform.getCircleRadiusCorrection(), this._equalEarthTransform.getCircleRadiusCorrection(), this._eeness);
    }

    public getPitchedTextCorrection(textAnchorX: number, textAnchorY: number, tileID: UnwrappedTileID): number {
        const mercatorCorrection = this._mercatorTransform.getPitchedTextCorrection(textAnchorX, textAnchorY, tileID);
        const eeCorrection = this._equalEarthTransform.getPitchedTextCorrection(textAnchorX, textAnchorY, tileID);
        return lerp(mercatorCorrection, eeCorrection, this._eeness);
    }

    public projectTileCoordinates(x: number, y: number, unwrappedTileID: UnwrappedTileID, getElevation: (x: number, y: number) => number): PointProjection {
        return this.currentTransform.projectTileCoordinates(x, y, unwrappedTileID, getElevation);
    }

    private _calcMatrices(): void {
        if (!this._helper._width || !this._helper._height) {
            return;
        }
        // Same Z-sync choreography as GlobeTransform._calcMatrices, with
        // Equal Earth in vertical-perspective's role: apply the EE child
        // first and adopt its Z values, then apply mercator — forcing it to
        // adopt our (EE's) Z range while EE rendering is active — and sync
        // again. The order matters: the mercator apply with forceOverrideZ
        // reads the helper's Z values, which must be valid by then.
        this._equalEarthTransform.apply(this, false);
        this._helper._nearZ = this._equalEarthTransform.nearZ;
        this._helper._farZ = this._equalEarthTransform.farZ;
        this._mercatorTransform.apply(this, true, this.isEqualEarthRendering);
        this._helper._nearZ = this._mercatorTransform.nearZ;
        this._helper._farZ = this._mercatorTransform.farZ;
    }

    calculateFogMatrix(unwrappedTileID: UnwrappedTileID): mat4 {
        return this.currentTransform.calculateFogMatrix(unwrappedTileID);
    }

    getVisibleUnwrappedCoordinates(tileID: CanonicalTileID): UnwrappedTileID[] {
        return this.currentTransform.getVisibleUnwrappedCoordinates(tileID);
    }

    getCameraFrustum(): Frustum {
        return this.currentTransform.getCameraFrustum();
    }
    getClippingPlane(): vec4 | null {
        return this.currentTransform.getClippingPlane();
    }
    getCoveringTilesDetailsProvider(): CoveringTilesDetailsProvider {
        return this.currentTransform.getCoveringTilesDetailsProvider();
    }

    recalculateZoomAndCenter(terrain?: Terrain): void {
        this.currentTransform.recalculateZoomAndCenter(terrain);
    }

    maxPitchScaleFactor(): number {
        return this._mercatorTransform.maxPitchScaleFactor();
    }

    getCameraPoint(): Point {
        return this._helper.getCameraPoint();
    }

    getCameraAltitude(): number {
        return this._helper.getCameraAltitude();
    }

    getCameraLngLat(): LngLat {
        return this._helper.getCameraLngLat();
    }

    lngLatToCameraDepth(lngLat: LngLat, elevation: number): number {
        return this.currentTransform.lngLatToCameraDepth(lngLat, elevation);
    }

    populateCache(coords: OverscaledTileID[]): void {
        this._mercatorTransform.populateCache(coords);
        this._equalEarthTransform.populateCache(coords);
    }

    getBounds(): LngLatBounds {
        return this.currentTransform.getBounds();
    }

    /**
     * Blended rendered world-y of a latitude: exactly the shader's
     * positional mix applied to the vertical axis (mercator unit-world y,
     * clamped to [0,1] beyond ±85.05°, mixed toward Equal Earth unit-world
     * y by eeness). Monotonically decreasing in latitude at every eeness.
     */
    private _blendedWorldY(lat: number): number {
        const mercY = clamp(mercatorYfromLat(lat), 0, 1);
        if (this._eeness >= 1) return equalEarthWorldFromLngLat(0, lat).y;
        if (this._eeness <= 0) return mercY;
        return lerp(mercY, equalEarthWorldFromLngLat(0, lat).y, this._eeness);
    }

    private _latFromBlendedWorldY(y: number): number {
        // Bisection over the monotonic _blendedWorldY (y-down: lat 90 is
        // the smallest y). 50 iterations ≈ 1e-13 degrees.
        let lo = -90, hi = 90;
        for (let i = 0; i < 50; i++) {
            const mid = (lo + hi) / 2;
            if (this._blendedWorldY(mid) > y) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    /**
     * Blended rendered world-x of a point, lambda0-frozen counterpart to
     * _blendedWorldY (step 13). Mercator's x (`lng/360 + 0.5`) and Equal
     * Earth's x (`0.5 + (lng - lambda0) * scale(lat)`) are both affine in
     * lng at fixed lat — pseudocylindrical, per the banana-tiling fact in
     * the step-8 design doc — so the mix is affine too; `lambda0` here is
     * the FROZEN meridian, not the live center, which is exactly what
     * makes this "planar pan" instead of the rotating pure-EE model.
     */
    private _blendedWorldX(lng: number, lat: number, lambda0: number): number {
        const mercX = mercatorXfromLng(lng);
        if (this._eeness <= 0) return mercX;
        const eeX = equalEarthWorldFromLngLat(lng, lat, lambda0).x;
        if (this._eeness >= 1) return eeX;
        return lerp(mercX, eeX, this._eeness);
    }

    /** d(_blendedWorldX)/d(lng) at fixed lat — exact, both terms affine. */
    private _blendedXCoeffAtLat(lat: number): number {
        return lerp(1 / 360, equalEarthXScaleAtLat(lat), this._eeness);
    }

    /**
     * Blend-aware constrain (owner design, ghost/pole-clamp round,
     * 2026-07-23): the vertical clamp and the pole-fit zoom floor must
     * track the RENDERED world, not the dominant endpoint's geometry.
     * Delegating to the EE child's constrain mid-blend held the EE pole
     * docked at the viewport edge while the rendered high latitudes had
     * stretched most of the way to their mercator positions — an entire
     * high-latitude band (Svalbard, in the owner's repro) became
     * unreachable at 0<t<1, recovering only at t=0. This constrain uses
     * the blended world-y everywhere, so the content edge that docks at
     * the viewport top slides continuously from the Equal Earth pole line
     * (t=1) to mercator's ±85.05° cut-off (t=0). It also computes from
     * this transform's OWN size, which fixes a second bug the delegation
     * had: on the very first constrain (during construction) the child
     * transforms were not yet sized, their zoom floor silently no-opped,
     * and a below-floor URL zoom stuck with voids top and bottom.
     */
    /**
     * Pitch/void interaction fix (owner repro, 2026-07-24): the vertical
     * clamp above is flat-camera math (screen pixels <-> world-Y via a
     * straight ratio) — under a nonzero pitch (still nonzero mid-blend
     * during the ease-to-flat decay above, or intentionally left nonzero
     * in pure mercator), a pitched camera reveals MORE world extent
     * toward the horizon (up-screen) than that flat math assumes,
     * exposing real void beyond the correctly-for-pitch-0 content edge —
     * reproduced at Svalbard: identical center/zoom mid-blend, pitch=60
     * shows a hard void band above y≈327/700, pitch=0 fills edge-to-edge.
     * Approximated (not full frustum math, which needs the real
     * projection/camera matrix) by comparing the ground distance a ray
     * at the TOP of the screen reaches at this pitch vs. at pitch 0:
     * that ray leaves the camera at `pitch + halfFov` from nadir (not
     * just `pitch` — a naive `1/cos(pitch)` term undershoots badly,
     * since the top-of-screen ray is already `halfFov` past the pitch
     * angle itself, and ground distance grows with `tan`, not `cos`, as
     * that angle approaches the horizon), so the ratio is
     * `tan(pitch + halfFov) / tan(halfFov)`. Clamped so a pitch
     * approaching (90 - halfFov) — looking at the literal horizon —
     * can't blow the floor up unboundedly. Exact identity (factor 1) at
     * pitch=0, so this is a zero-behavior-change no-op for every
     * existing pitch=0 gate.
     */
    private static readonly MAX_PITCH_SAFETY_MARGIN_DEGREES = 8;
    private _pitchSafetyFactor(): number {
        if (this.pitch <= 0) return 1;
        const halfFov = this.fovInRadians / 2;
        const maxPitchRad = degreesToRadians(90 - EqualEarthAdaptiveTransform.MAX_PITCH_SAFETY_MARGIN_DEGREES) - halfFov;
        const pitchRad = clamp(degreesToRadians(this.pitch), 0, Math.max(0, maxPitchRad));
        return Math.tan(pitchRad + halfFov) / Math.tan(halfFov);
    }

    defaultConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        const screenHeight = this.size.y;
        const effectiveScreenHeight = screenHeight * this._pitchSafetyFactor();
        // Blended content extent: lat ±90 renders at mix(mercator-edge 0/1,
        // EE pole line) — i.e. the pole lines slide outward toward the
        // mercator world edges as eeness falls.
        const yTop = this._eeness * EQUAL_EARTH_WORLD_Y_NORTH_POLE;
        const yBottom = 1 - this._eeness * (1 - EQUAL_EARTH_WORLD_Y_SOUTH_POLE);
        const contentHeightUnit = yBottom - yTop;
        let minZoomForFit = this.minZoom;
        if (screenHeight > 0) {
            minZoomForFit = Math.max(this.minZoom, Math.log2(effectiveScreenHeight / (contentHeightUnit * this.tileSize)));
        }
        const constrainedZoom = clamp(+zoom, minZoomForFit, this.maxZoom);
        let constrainedLat = clamp(lngLat.lat, -90, 90);

        const worldSize = this.tileSize * zoomScale(constrainedZoom);
        const minCenterY = yTop * worldSize + effectiveScreenHeight / 2;
        const maxCenterY = yBottom * worldSize - effectiveScreenHeight / 2;
        if (minCenterY > maxCenterY) {
            constrainedLat = 0;
        } else {
            const centerY = this._blendedWorldY(constrainedLat) * worldSize;
            const clampedCenterY = clamp(centerY, minCenterY, maxCenterY);
            constrainedLat = this._latFromBlendedWorldY(clampedCenterY / worldSize);
        }

        return {
            center: new LngLat(lngLat.lng, constrainedLat),
            zoom: constrainedZoom
        };
    };

    applyConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        return this._helper.applyConstrain(lngLat, zoom);
    };

    calculateCenterFromCameraLngLatAlt(lngLat: LngLatLike, alt: number, bearing?: number, pitch?: number): {center: LngLat; elevation: number; zoom: number} {
        return this._helper.calculateCenterFromCameraLngLatAlt(lngLat, alt, bearing, pitch);
    }

    /**
     * Step 13 lambda0 freeze. Pure regimes (t=1 or t=0) delegate to the
     * child transform's own exact closed-form solve, unchanged. Mid-blend,
     * dragging no longer rotates lambda0 (the pure-EE model, still used by
     * `EqualEarthTransform.setLocationAtPoint`) — it translates in
     * blended-world-x/-y at the frozen lambda0, matching the shader's
     * center-anchored positional blend and eliminating the discontinuity
     * that used to sit at the t=0 handoff (step13-lambda0-gate.cjs L1).
     * Pixel->world-unit conversion is the exact identity for a
     * center-anchored, unrotated, unpitched view (`d/worldSize`, no
     * perspective correction) — bearing/pitch=0 is already this whole
     * transform's standing assumption (constrain, covering tiles).
     */
    setLocationAtPoint(lnglat: LngLat, point: Point): void {
        if (this._eeness <= 0 || this._eeness >= 1) {
            this.currentTransform.setLocationAtPoint(lnglat, point);
            this.apply(this.currentTransform, false);
            return;
        }
        const lambda0 = this._frozenLambda0 ?? this.center.lng;
        const ws = this.worldSize;
        const dxUnit = (point.x - this.centerPoint.x) / ws;
        const dyUnit = (point.y - this.centerPoint.y) / ws;

        const targetY = clamp(this._blendedWorldY(lnglat.lat) - dyUnit, 0, 1);
        const newCenterLat = this._latFromBlendedWorldY(targetY);

        const targetX = this._blendedWorldX(lnglat.lng, lnglat.lat, lambda0) - dxUnit;
        const refX = this._blendedWorldX(lnglat.lng, newCenterLat, lambda0);
        const newCenterLng = lnglat.lng + (targetX - refX) / this._blendedXCoeffAtLat(newCenterLat);

        this.setCenter(new LngLat(newCenterLng, newCenterLat));
        if (this._helper._renderWorldCopies) {
            this.setCenter(this.center.wrap());
        }
    }

    /**
     * Step 13 CPU-query blend. Pure regimes and terrain (adaptive+terrain
     * is untested/unsupported, per the static-EE precedent) delegate to
     * the dominant child exactly as before. Mid-blend, this now answers
     * from the same _blendedWorldX/-Y model setLocationAtPoint solves in
     * (frozen lambda0, center-anchored) instead of the dominant-endpoint
     * approximation the whole adaptive transform used previously
     * (`transitionAt`/`meridianBowDegrees`-style callers, symbol
     * placement, hit-testing, `map.project`/`unproject` all go through
     * this). Known residual: the EE shader render itself always
     * self-centers on the LIVE `center.lng` (Stage B's "lambda0 ≡
     * center.lng" is baked into EqualEarthTransform's own tile math, not
     * something this transform can override per-point), so for points far
     * in latitude from the center, after a long sustained mid-blend drag
     * has moved `center.lng` well away from the frozen value, this CPU
     * answer and the true GPU pixel can drift apart — a second-order
     * effect (product of drag distance since freeze and latitude spread
     * from center), same category as the previously-accepted
     * dominant-endpoint approximation it replaces, not chased further
     * here.
     */
    locationToScreenPoint(lnglat: LngLat, terrain?: Terrain): Point {
        if (terrain || this._eeness <= 0 || this._eeness >= 1) {
            return this.currentTransform.locationToScreenPoint(lnglat, terrain);
        }
        const lambda0 = this._frozenLambda0 ?? this.center.lng;
        const ws = this.worldSize;
        const dx = (this._blendedWorldX(lnglat.lng, lnglat.lat, lambda0) - this._blendedWorldX(this.center.lng, this.center.lat, lambda0)) * ws;
        const dy = (this._blendedWorldY(lnglat.lat) - this._blendedWorldY(this.center.lat)) * ws;
        return new Point(this.centerPoint.x + dx, this.centerPoint.y + dy);
    }

    screenPointToMercatorCoordinate(p: Point, terrain?: Terrain): MercatorCoordinate {
        return this.currentTransform.screenPointToMercatorCoordinate(p, terrain);
    }

    /** Inverse of locationToScreenPoint — see its doc comment. */
    screenPointToLocation(p: Point, terrain?: Terrain): LngLat {
        if (terrain || this._eeness <= 0 || this._eeness >= 1) {
            return this.currentTransform.screenPointToLocation(p, terrain);
        }
        const lambda0 = this._frozenLambda0 ?? this.center.lng;
        const ws = this.worldSize;
        const dxUnit = (p.x - this.centerPoint.x) / ws;
        const dyUnit = (p.y - this.centerPoint.y) / ws;

        const targetY = clamp(this._blendedWorldY(this.center.lat) + dyUnit, 0, 1);
        const lat = this._latFromBlendedWorldY(targetY);

        const targetX = this._blendedWorldX(this.center.lng, this.center.lat, lambda0) + dxUnit;
        const refX = this._blendedWorldX(this.center.lng, lat, lambda0);
        const lng = this.center.lng + (targetX - refX) / this._blendedXCoeffAtLat(lat);

        return new LngLat(lng, lat);
    }

    isPointOnMapSurface(p: Point, terrain?: Terrain): boolean {
        return this.currentTransform.isPointOnMapSurface(p, terrain);
    }

    getRayDirectionFromPixel(p: Point): vec3 {
        return this.currentTransform.getRayDirectionFromPixel(p);
    }

    getProjectionDataForCustomLayer(applyGlobeMatrix: boolean = true): CustomLayerProjectionData {
        // Same contract as static Equal Earth (§5.1 of the design
        // proposal): custom layers are mercator-positioned under EE, so
        // the mercator data is correct in every regime.
        return this._mercatorTransform.getProjectionDataForCustomLayer(applyGlobeMatrix);
    }

    getFastPathSimpleProjectionMatrix(tileID: OverscaledTileID): mat4 {
        return this.currentTransform.getFastPathSimpleProjectionMatrix(tileID);
    }
}
