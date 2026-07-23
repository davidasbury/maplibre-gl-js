import type {mat2, mat4, vec3, vec4} from 'gl-matrix';
import {TransformHelper} from '../transform_helper.ts';
import {MercatorTransform} from './mercator_transform.ts';
import {EqualEarthTransform} from './equal_earth_transform.ts';
import {type LngLat, type LngLatLike} from '../lng_lat.ts';
import {lerp} from '../../util/util.ts';
import type {OverscaledTileID, UnwrappedTileID, CanonicalTileID} from '../../tile/tile_id.ts';

import type Point from '@mapbox/point-geometry';
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
     * True when the Equal Earth render path (shader variant, covering
     * tiles, constrain) should be used instead of plain mercator.
     */
    get isEqualEarthRendering(): boolean {
        return this._eeness > 0;
    }

    setTransitionState(eeness: number, _errorCorrectionValue: number): void {
        this._eeness = eeness ?? 1;
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
        clone.apply(this, false);
        return clone;
    }

    public apply(that: IReadonlyTransform, constrain: boolean): void {
        this._helper.apply(that, constrain);
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

    defaultConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        return this.currentTransform.defaultConstrain(lngLat, zoom);
    };

    applyConstrain: TransformConstrainFunction = (lngLat, zoom) => {
        return this._helper.applyConstrain(lngLat, zoom);
    };

    calculateCenterFromCameraLngLatAlt(lngLat: LngLatLike, alt: number, bearing?: number, pitch?: number): {center: LngLat; elevation: number; zoom: number} {
        return this._helper.calculateCenterFromCameraLngLatAlt(lngLat, alt, bearing, pitch);
    }

    setLocationAtPoint(lnglat: LngLat, point: Point): void {
        this.currentTransform.setLocationAtPoint(lnglat, point);
        this.apply(this.currentTransform, false);
    }

    locationToScreenPoint(lnglat: LngLat, terrain?: Terrain): Point {
        return this.currentTransform.locationToScreenPoint(lnglat, terrain);
    }

    screenPointToMercatorCoordinate(p: Point, terrain?: Terrain): MercatorCoordinate {
        return this.currentTransform.screenPointToMercatorCoordinate(p, terrain);
    }

    screenPointToLocation(p: Point, terrain?: Terrain): LngLat {
        return this.currentTransform.screenPointToLocation(p, terrain);
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
