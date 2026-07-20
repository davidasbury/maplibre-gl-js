import type {Context} from '../../webgl/context.ts';
import type {CanonicalTileID} from '../../tile/tile_id.ts';
import {type Mesh} from '../../render/mesh.ts';
import {SubdivisionGranularityExpression, SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import type {Projection, ProjectionGPUContext, TileMeshUsage} from './projection.ts';
import {type PreparedShader, shaders} from '../../shaders/shaders.ts';
import {createTileMeshWithBuffers, type CreateTileMeshOptions} from '../../util/create_tile_mesh.ts';

export const EqualEarthShaderDefine = '#define PROJECTION_EQUAL_EARTH';
export const EqualEarthShaderVariantKey = 'equal-earth';

// Starting point only: same granularity as vertical-perspective. The step 2
// implementation-surface doc expects Equal Earth can relax these later, since
// its curvature is milder than a sphere's, but that tuning is out of scope here.
const granularitySettingsEqualEarth: SubdivisionGranularitySetting = new SubdivisionGranularitySetting({
    fill: new SubdivisionGranularityExpression(128, 2),
    line: new SubdivisionGranularityExpression(512, 0),
    tile: new SubdivisionGranularityExpression(128, 32),
    stencil: new SubdivisionGranularityExpression(128, 1),
    circle: 3
});

/**
 * Stage A only: modeled on `VerticalPerspectiveProjection`, but without its GPU
 * atan-error-correction machinery (`_errorMeasurement` and friends). The step 2
 * implementation-surface doc already called this out as deferred-to-Stage-C
 * scope, not a finding that the correction is inapplicable — Equal Earth's own
 * shader (Phase 3) reuses the same mercator-tile inverse-atan trick globe's
 * does, so the same GPU precision question may resurface later. The trivial
 * no-op stubs below mirror `mercator_projection.ts`'s style instead.
 */
export class EqualEarthProjection implements Projection {
    private _tileMeshCache: {[_: string]: Mesh} = {};

    get name(): 'equal-earth' {
        return 'equal-earth';
    }

    get transitionState(): number {
        return 1;
    }

    get useSubdivision(): boolean {
        return true;
    }

    get shaderVariantName(): string {
        return EqualEarthShaderVariantKey;
    }

    get shaderDefine(): string {
        return EqualEarthShaderDefine;
    }

    get shaderPreludeCode(): PreparedShader {
        return shaders.projectionEqualEarth;
    }

    get vertexShaderPreludeCode(): string {
        return shaders.projectionEqualEarth.vertexSource;
    }

    get subdivisionGranularity(): SubdivisionGranularitySetting {
        return granularitySettingsEqualEarth;
    }

    get useGlobeControls(): boolean {
        return false;
    }

    get latitudeErrorCorrectionRadians(): number {
        return 0;
    }

    public destroy(): void {
        // Do nothing.
    }

    public updateGPUdependent(_: ProjectionGPUContext): void {
        // Do nothing.
    }

    private _getMeshKey(options: CreateTileMeshOptions): string {
        return `${options.granularity.toString(36)}_${options.generateBorders ? 'b' : ''}${options.extendToNorthPole ? 'n' : ''}${options.extendToSouthPole ? 's' : ''}`;
    }

    public getMeshFromTileID(context: Context, canonical: CanonicalTileID, hasBorder: boolean, allowPoles: boolean, usage: TileMeshUsage): Mesh {
        // Stencil granularity must match fill granularity
        const granularityConfig = usage === 'stencil' ? granularitySettingsEqualEarth.stencil : granularitySettingsEqualEarth.tile;
        const granularity = granularityConfig.getGranularityForZoomLevel(canonical.z);
        const north = (canonical.y === 0) && allowPoles;
        const south = (canonical.y === (1 << canonical.z) - 1) && allowPoles;
        return this._getMesh(context, {
            granularity,
            generateBorders: hasBorder,
            extendToNorthPole: north,
            extendToSouthPole: south,
        });
    }

    private _getMesh(context: Context, options: CreateTileMeshOptions): Mesh {
        const key = this._getMeshKey(options);

        if (key in this._tileMeshCache) {
            return this._tileMeshCache[key];
        }

        const mesh = createTileMeshWithBuffers(context, options);
        this._tileMeshCache[key] = mesh;
        return mesh;
    }

    public recalculate(): void {
        // Do nothing.
    }

    public hasTransition(): boolean {
        return false;
    }

    setErrorQueryLatitudeDegrees(_value: number): void {
        // Do nothing.
    }
}
