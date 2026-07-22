import {clamp} from '../../util/util.ts';
import {lngFromMercatorX, latFromMercatorY} from '../mercator_coordinate.ts';
import {
    equalEarthWorldFromLngLat,
    equalEarthXScaleAtLat,
    latFromEqualEarthWorldY,
    EQUAL_EARTH_WORLD_Y_NORTH_POLE,
    EQUAL_EARTH_WORLD_Y_SOUTH_POLE,
} from '../equal_earth_coordinate.ts';
import {IntersectionResult, type IBoundingVolume} from '../../util/primitives/bounding_volume.ts';
import type {vec4} from 'gl-matrix';
import type {Frustum} from '../../util/primitives/frustum.ts';
import type {MercatorCoordinate} from '../mercator_coordinate.ts';
import type {IReadonlyTransform} from '../transform_interface.ts';
import type {CoveringTilesOptionsInternal} from './covering_tiles.ts';
import type {CoveringTilesDetailsProvider} from './covering_tiles_details_provider.ts';

/**
 * Covering-tiles provider for Equal Earth (Stage A step 6, reworked v2 in
 * session 0013's follow-up). See
 * `docs/resources/2026-07-20-stage-a-step6-covering-tiles.md` in the outer
 * project (adaptive-equal-earth) for the original design rationale -- the
 * frustum-sidestep summarized below is unchanged from v1:
 *
 * The shared `coveringTiles()` traversal (`covering_tiles.ts`) culls tiles by
 * intersecting a per-tile `IBoundingVolume` against the transform's real 3D
 * camera frustum. For Equal Earth that comparison is fundamentally broken:
 * tiles are always mercator-square-addressed, but a mercator square is NOT
 * an affine image of its on-screen Equal Earth footprint (the bending
 * happens per-vertex in the shader), so testing a mercator AABB against a
 * frustum built for the EE-projected plane compares incommensurate shapes --
 * this is exactly what produced the blank strip below the south pole line in
 * Demo A.
 *
 * Rather than building real EE-warped bounding geometry (the "clever" fix,
 * deferred), this provider sidesteps the frustum entirely: `getTileBoundingVolume`
 * returns a synthetic `IBoundingVolume` whose intersection tests ignore
 * their frustum/plane arguments and instead return a verdict precomputed
 * from comparing the tile's own (mercator-derived) lat/lng rectangle against
 * a geographic window of the current viewport. KEEP this mechanism -- it is
 * still the only sound way to decide EE tile visibility without warped
 * bounding geometry.
 *
 * v1 -> v2 (session 0013, `docs/resources/2026-07-22-step8-high-zoom-defect-diagnosis.md`):
 * v1 built that geographic window by unprojecting 8 viewport samples through
 * the transform's own inverse, validated by a screen-space round trip, and
 * fell back to the full world whenever any sample's round trip exceeded 1px.
 * Three convicted mechanisms made that unusable at real zoom levels:
 *
 * 1. The round-trip check itself: at z>=12 the transform's inverse round
 *    trip error routinely exceeds the 1px tolerance, so `computeViewportGeoBBox`
 *    fell back to `fullWorldBBox` and the traversal enumerated the whole
 *    world (~16.7M leaves x 7 wraps) -- this is what wedged the page at z12+.
 * 2. `BBOX_PAD_DEGREES = 1` was a fixed-degree pad. At z11 the viewport
 *    spans only ~0.2 degrees, so a 1-degree pad on each side was ~10x the
 *    viewport itself (measured: 2205 tiles/source at z11).
 * 3. `getTileBoundingVolume` ignored its `wrap` argument, so every in-window
 *    tile was requested at ALL traversal-seeded wraps, not just the one(s)
 *    actually on screen (measured: 175 = 25x7 at z8).
 *
 * v2 replaces sampling with an analytic window computed directly from the
 * transform in `computeViewportWindow` (see its own doc comment) -- bounded
 * by construction at every zoom, so both `fullWorldBBox` and the round-trip
 * check are gone entirely (not merely relaxed). `getTileBoundingVolume` is
 * now wrap-aware (Mechanism 3's fix): a tile's absolute longitude interval
 * is shifted by `360 * wrap` before being compared to the window, so only
 * the wrap(s) actually overlapping the window pass.
 *
 * Assumptions carried over from v1, unchanged: bearing/pitch are 0
 * project-wide (recorded limitation, not solved here); lambda0 === center.lng
 * (the design's own center-tracking invariant, see `equal_earth_coordinate.ts`).
 * New in v2: the longitude half-span uses the MORE CONSERVATIVE (smaller) of
 * the two latitude extremes' x-scales, which slightly over-fetches near the
 * poles rather than under-fetching -- see `computeViewportWindow`.
 */

// Screen-space safety margin, in pixels, added to the viewport half-extent
// on every side before converting to unit-world/geographic terms --
// screen-proportional insurance for tile buffers/antialiasing at the edge of
// the viewport. Replaces v1's fixed-DEGREES pad entirely: a pixel pad scales
// correctly with zoom by construction, where a degree pad did not (see the
// module doc comment, Mechanism 2).
const PAD_PX = 64;

type GeoWindow = {
    latMin: number;
    latMax: number;
    /**
     * Longitude window in CONTINUOUS (unwrapped) numbering, centered on
     * `transform.center.lng` (already normalized by the transform -- see
     * the design's lambda0-tracking invariant). May legitimately span
     * outside [-180, 180] (e.g. lngHi = 214 means "34 degrees past the
     * antimeridian"); no modular arithmetic is applied here or in
     * `getTileBoundingVolume`.
     */
    lngLo: number;
    lngHi: number;
};

/**
 * Builds the current viewport's geographic window directly from the
 * transform's own state -- no unprojection sampling, no round-trip
 * validation, no full-world fallback. Bounded at every zoom by
 * construction: as zoom decreases the window widens smoothly toward the
 * whole world (correct behavior, not a fallback path).
 *
 * Relies on the project-wide bearing/pitch === 0 assumption (see the module
 * doc comment): under that assumption the viewport is an axis-aligned
 * rectangle in unit-world space centered on the transform's center point,
 * which is exactly what makes an analytic (rather than sampled) window
 * possible.
 */
function computeViewportWindow(transform: IReadonlyTransform): GeoWindow {
    const {width, height, worldSize, center} = transform;

    // Viewport half-extent, screen px -> unit-world, with the pixel pad
    // folded in before the division so it scales with zoom automatically.
    const xHalfUnit = (width / 2 + PAD_PX) / worldSize;
    const yHalfUnit = (height / 2 + PAD_PX) / worldSize;

    const centerY = equalEarthWorldFromLngLat(center.lng, center.lat).y;

    // Clamp the world-y interval into the world's valid y range (the pole
    // lines) -- derived, not hardcoded, from the same forward function used
    // everywhere else in this codebase (`equal_earth_transform.ts`'s own
    // vertical clamp uses the identical constants).
    const yLo = clamp(centerY - yHalfUnit, EQUAL_EARTH_WORLD_Y_NORTH_POLE, EQUAL_EARTH_WORLD_Y_SOUTH_POLE);
    const yHi = clamp(centerY + yHalfUnit, EQUAL_EARTH_WORLD_Y_NORTH_POLE, EQUAL_EARTH_WORLD_Y_SOUTH_POLE);

    // y-down: smaller y is farther north, i.e. higher latitude.
    const latMax = latFromEqualEarthWorldY(yLo);
    const latMin = latFromEqualEarthWorldY(yHi);

    // The x-per-degree scale shrinks toward the poles, so the min over the
    // two latitude extremes bounds the widest in-view longitude span
    // (evaluated at both ends -- deliberately not assumed monotonic).
    // Always > 0 including at +-90 (Equal Earth's poles are lines, not
    // points -- see `equalEarthXScaleAtLat`'s own doc comment), so this
    // division is always safe.
    const minScale = Math.min(equalEarthXScaleAtLat(latMin), equalEarthXScaleAtLat(latMax));
    const lngHalfSpan = Math.min(180, xHalfUnit / minScale);

    return {
        latMin,
        latMax,
        lngLo: center.lng - lngHalfSpan,
        lngHi: center.lng + lngHalfSpan,
    };
}

/**
 * `IBoundingVolume` whose intersection tests ignore the frustum/plane they
 * are given and return a precomputed verdict instead. See the module doc
 * comment for why: tile visibility here is decided entirely in geography
 * space (tile lat/lng rectangle vs. viewport geographic window), not by
 * testing real geometry against the camera frustum.
 */
class PrecomputedVerdictVolume implements IBoundingVolume {
    constructor(private readonly _verdict: IntersectionResult) {}
    intersectsFrustum(_frustum: Frustum): IntersectionResult {
        return this._verdict;
    }
    intersectsPlane(_plane: vec4): IntersectionResult {
        // Never actually invoked while EqualEarthTransform.getClippingPlane()
        // returns null (see isTileVisible in covering_tiles.ts), kept
        // consistent with intersectsFrustum for defensiveness.
        return this._verdict;
    }
}

// Never Full (see design note): a tile "overlaps" or it doesn't. Full would
// mark descendants already-visible and skip their own checks, which isn't
// worth the risk here.
const TILE_MAYBE_VISIBLE: IBoundingVolume = new PrecomputedVerdictVolume(IntersectionResult.Partial);
const TILE_NOT_VISIBLE: IBoundingVolume = new PrecomputedVerdictVolume(IntersectionResult.None);

export class EqualEarthCoveringTilesDetailsProvider implements CoveringTilesDetailsProvider {
    private _window: GeoWindow = {latMin: -90, latMax: 90, lngLo: -180, lngHi: 180};

    /**
     * Only consumed when `allowVariableZoom` returns true (never, for Stage
     * A -- see below), so this is inert today. Implemented properly rather
     * than stubbed, mirroring `MercatorCoveringTilesDetailsProvider`'s own
     * clamped point-to-rect distance, in mercator-fraction space, without
     * needing an `Aabb` instance.
     */
    distanceToTile2d(pointX: number, pointY: number, tileID: {x: number; y: number; z: number}, _boundingVolume: IBoundingVolume): number {
        const numTiles = 1 << tileID.z;
        const minX = tileID.x / numTiles;
        const maxX = (tileID.x + 1) / numTiles;
        const minY = tileID.y / numTiles;
        const maxY = (tileID.y + 1) / numTiles;
        const dx = Math.max(minX - pointX, 0, pointX - maxX);
        const dy = Math.max(minY - pointY, 0, pointY - maxY);
        return Math.hypot(dx, dy);
    }

    /**
     * Stage B step 8: `allowWorldCopies()` below returns true, so
     * `parentWrap` is not always 0 -- this matches
     * `MercatorCoveringTilesDetailsProvider.getWrap` exactly (both just pass
     * `parentWrap` through unchanged; the shared traversal in
     * `covering_tiles.ts` is what seeds the initial +-1..+-3 wrap values via
     * `renderWorldCopies && allowWorldCopies()`). Which of those seeded
     * wraps actually survive to the result is now decided by the
     * wrap-aware longitude comparison in `getTileBoundingVolume` (v2).
     */
    getWrap(_centerCoord: MercatorCoordinate, _tileID: {x: number; y: number; z: number}, parentWrap: number): number {
        return parentWrap;
    }

    /**
     * The seam: the only provider method the shared traversal hands the live
     * `transform`, called exactly once per `coveringTiles()` before any tile
     * is visited. Repurposed as a "begin frame" hook to compute and cache
     * this call's geographic window (v2: `computeViewportWindow`, an
     * analytic construction -- no unprojection sampling). Always returns
     * false: Stage A has no pitch/tilt correctness (recorded in the step 5
     * notes), so there is no LOD-by-distance concept to offer yet.
     */
    allowVariableZoom(transform: IReadonlyTransform, _options: CoveringTilesOptionsInternal): boolean {
        this._window = computeViewportWindow(transform);
        return false;
    }

    /**
     * Stage B step 8 (Mechanism 2): true, matching Mercator -- Equal
     * Earth's plane genuinely tiles with repeated world copies (the "banana
     * tiling" fact in the design doc: shifting lambda by 360 degrees shifts
     * x by exactly 360*k(phi) at every latitude, so neighboring copies
     * partition the plane with no overlap or gap). Combined with
     * `getVisibleUnwrappedCoordinates`'s real wrap enumeration, this lets
     * `renderWorldCopies` actually render copies either side of the seam,
     * which G1/G2 (fixed outline, seam continuity) depend on.
     *
     * v2: `getTileBoundingVolume` below now considers `wrap` (Mechanism 3's
     * fix, see the module doc comment) -- a tile is only requested at the
     * wrap(s) whose shifted longitude interval actually overlaps the
     * viewport window, not at every traversal-seeded wrap unconditionally.
     */
    allowWorldCopies(): boolean {
        return true;
    }

    getTileBoundingVolume(tileID: {x: number; y: number; z: number}, wrap: number, _elevation: number, _options: CoveringTilesOptionsInternal): IBoundingVolume {
        const numTiles = 1 << tileID.z;
        const window = this._window;

        // With continuous (unwrapped) longitude numbering there is no
        // modular ambiguity, so the z=0 root tile needs no special case:
        // lngFromMercatorX(0) / lngFromMercatorX(1) already evaluate to
        // exactly -180 / 180, so the root's shifted interval is
        // [-180, 180] + 360*wrap, tested like any other tile. When the
        // window spans the whole world (low zoom / world-fits case) this
        // still passes, so the traversal still descends -- not a fallback,
        // just the general case degenerating correctly.
        const tileLngLo = lngFromMercatorX(tileID.x / numTiles) + 360 * wrap;
        const tileLngHi = lngFromMercatorX((tileID.x + 1) / numTiles) + 360 * wrap;
        const lngOverlap = tileLngHi >= window.lngLo && tileLngLo <= window.lngHi;

        const tileLatMax = latFromMercatorY(tileID.y / numTiles);
        const tileLatMin = latFromMercatorY((tileID.y + 1) / numTiles);
        const latOverlap = tileLatMax >= window.latMin && tileLatMin <= window.latMax;

        return (lngOverlap && latOverlap) ? TILE_MAYBE_VISIBLE : TILE_NOT_VISIBLE;
    }

    prepareNextFrame(): void {
        // No cross-frame cache to maintain (unlike Globe's BoundingVolumeCache):
        // the geographic window is recomputed fresh every coveringTiles() call.
    }
}
