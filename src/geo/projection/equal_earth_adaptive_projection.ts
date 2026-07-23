import {ProjectionDefinition, type ProjectionSpecification} from '@maplibre/maplibre-gl-style-spec';
import {type PossiblyEvaluated, Transitionable, type Transitioning, type TransitionParameters} from '../../style/properties.ts';
import {getProperties, type ProjectionProps, type ProjectionPropsPossiblyEvaluated} from '../../style/projection_properties.g.ts';
import {Evented} from '../../util/evented.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {MercatorProjection} from './mercator_projection.ts';
import {EqualEarthProjection} from './equal_earth_projection.ts';
import {type Projection, type ProjectionGPUContext, type TileMeshUsage} from './projection.ts';
import {type PreparedShader} from '../../shaders/shaders.ts';
import {type SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import {type Context} from '../../webgl/context.ts';
import {type CanonicalTileID} from '../../tile/tile_id.ts';
import {type Mesh} from '../../render/mesh.ts';

/**
 * Stage C (plan step 11): the adaptive Equal Earth projection — Equal Earth
 * at low zoom, mercator at high zoom, blended between. Mirrors
 * `GlobeProjection`'s composite pattern exactly (globe = the same idea for
 * vertical-perspective↔mercator); the transition value is evaluated by the
 * v5 projection-expression machinery from a
 * `["interpolate", ["linear"], ["zoom"], z_a, "equal-earth", z_b, "mercator"]`
 * projection spec (the `"equal-earth-adaptive"` preset in the factory
 * supplies z_a=4, z_b=6 — Mapbox v2.6 shipped ~5–6; tuning is plan step 13).
 *
 * `transitionState` semantics match globe: 1 = fully Equal Earth,
 * 0 = fully mercator. The positional blend itself happens in the Equal
 * Earth shader chunk (`u_projection_transition` mixing toward
 * `u_projection_fallback_matrix`), driven by
 * `EqualEarthAdaptiveTransform.getProjectionData`.
 */
export class EqualEarthAdaptiveProjection extends Evented implements Projection {
    properties: PossiblyEvaluated<ProjectionProps, ProjectionPropsPossiblyEvaluated>;

    _transitionable: Transitionable<ProjectionProps>;
    _transitioning: Transitioning<ProjectionProps>;
    _mercatorProjection: MercatorProjection;
    _equalEarthProjection: EqualEarthProjection;

    constructor(projection?: ProjectionSpecification) {
        super();
        this._transitionable = new Transitionable(getProperties(), 'projection', undefined);
        this.setProjection(projection);
        this._transitioning = this._transitionable.untransitioned();
        this.recalculate(new EvaluationParameters(0));
        this._mercatorProjection = new MercatorProjection();
        this._equalEarthProjection = new EqualEarthProjection();
    }

    public get transitionState(): number {
        const currentProjectionSpecValue = this.properties.get('type');
        if (typeof currentProjectionSpecValue === 'string' && currentProjectionSpecValue === 'mercator') {
            return 0;
        }
        if (typeof currentProjectionSpecValue === 'string' && currentProjectionSpecValue === 'equal-earth') {
            return 1;
        }
        if (currentProjectionSpecValue instanceof ProjectionDefinition) {
            if (currentProjectionSpecValue.from === 'equal-earth' && currentProjectionSpecValue.to === 'mercator') {
                return 1 - currentProjectionSpecValue.transition;
            }
            if (currentProjectionSpecValue.from === 'mercator' && currentProjectionSpecValue.to === 'equal-earth') {
                return currentProjectionSpecValue.transition;
            }
        }
        return 1;
    }

    get useEqualEarthRendering(): boolean {
        return this.transitionState > 0;
    }

    // No globe-style GPU latitude error correction for a flat projection.
    get latitudeErrorCorrectionRadians(): number { return 0; }

    private get currentProjection(): Projection {
        return this.useEqualEarthRendering ? this._equalEarthProjection : this._mercatorProjection;
    }

    get name(): ProjectionSpecification['type'] {
        return 'equal-earth';
    }

    get useSubdivision(): boolean {
        return this.currentProjection.useSubdivision;
    }

    get shaderVariantName(): string {
        return this.currentProjection.shaderVariantName;
    }

    get shaderDefine(): string {
        return this.currentProjection.shaderDefine;
    }

    get shaderPreludeCode(): PreparedShader {
        return this.currentProjection.shaderPreludeCode;
    }

    get vertexShaderPreludeCode(): string {
        return this.currentProjection.vertexShaderPreludeCode;
    }

    get subdivisionGranularity(): SubdivisionGranularitySetting {
        return this.currentProjection.subdivisionGranularity;
    }

    get useGlobeControls(): boolean {
        return false; // both endpoints are planar
    }

    public destroy(): void {
        this._mercatorProjection.destroy();
        this._equalEarthProjection.destroy();
    }

    public updateGPUdependent(context: ProjectionGPUContext): void {
        this._mercatorProjection.updateGPUdependent(context);
        this._equalEarthProjection.updateGPUdependent(context);
    }

    public getMeshFromTileID(context: Context, tileID: CanonicalTileID, hasBorder: boolean, allowPoles: boolean, usage: TileMeshUsage): Mesh {
        return this.currentProjection.getMeshFromTileID(context, tileID, hasBorder, allowPoles, usage);
    }

    setProjection(projection?: ProjectionSpecification): void {
        this._transitionable.setValue('type', projection?.type || 'mercator');
    }

    updateTransitions(parameters: TransitionParameters): void {
        this._transitioning = this._transitionable.transitioned(parameters, this._transitioning);
    }

    hasTransition(): boolean {
        return this._transitioning.hasTransition() || this.currentProjection.hasTransition();
    }

    recalculate(parameters: EvaluationParameters): void {
        this.properties = this._transitioning.possiblyEvaluate(parameters);
    }

    setErrorQueryLatitudeDegrees(_value: number): void {
        // No error-measurement machinery on either endpoint.
    }
}
