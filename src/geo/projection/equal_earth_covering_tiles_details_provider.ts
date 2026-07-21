import Point from '@mapbox/point-geometry';
import {clamp} from '../../util/util.ts';
import {lngFromMercatorX, latFromMercatorY} from '../mercator_coordinate.ts';
import {IntersectionResult, type IBoundingVolume} from '../../util/primitives/bounding_volume.ts';
import type {vec4} from 'gl-matrix';
import type {Frustum} from '../../util/primitives/frustum.ts';
import type {MercatorCoordinate} from '../mercator_coordinate.ts';
import type {IReadonlyTransform} from '../transform_interface.ts';
import type {CoveringTilesOptionsInternal} from './covering_tiles.ts';
import type {CoveringTilesDetailsProvider} from './covering_tiles_details_provider.ts';

/**
 * Naive v1 covering-tiles provider for Equal Earth (Stage A step 6). See
 * `docs/resources/2026-07-20-stage-a-step6-covering-tiles.md` in the outer
 * project (adaptive-equal-earth) for the full design rationale -- summary:
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
 * a geographic bounding box of the current viewport. That bbox is built once
 * per `coveringTiles()` call (see `allowVariableZoom`, the seam) by
 * unprojecting the viewport corners and edge midpoints through the
 * transform's own inverse -- "naive v1: unproject viewport corners/edges,
 * then geographic bbox, then mercator tile enumeration" per the phase 3 plan.
 */

// Small fixed-degree safety margin on every side of the computed bbox: pure
// boundary-flapping insurance (an edge sample landing exactly on a tile
// edge), not a cartographic claim. Over-fetch is acceptable per the plan.
const BBOX_PAD_DEGREES = 1;

// A screen-space round trip (unproject then reproject) further than this
// counts as "outside the projection outline" -- see the design note for why
// this is a round-trip check rather than a longitude-magnitude check.
// Legitimate samples measured at ~0px; invalid ones at 50px+, so this has
// enormous headroom in either direction.
const ROUND_TRIP_TOLERANCE_PX = 1;

type GeoBBox = {
    latMin: number;
    latMax: number;
    /**
     * Longitude window in "whatever continuous numbering the 8 viewport
     * samples produced" -- deliberately NOT wrapped into [-180, 180]. May
     * legitimately span outside that range (e.g. lngHi = 214 means "34
     * degrees past the antimeridian"). `lngRef` (the window's own midpoint)
     * is what tile longitudes get normalized against in `getTileBoundingVolume`,
     * NOT `transform.center.lng` -- the window isn't necessarily centered there.
     */
    lngLo: number;
    lngHi: number;
    lngRef: number;
};

function fullWorldBBox(lngRef: number): GeoBBox {
    return {latMin: -90, latMax: 90, lngLo: lngRef - 180, lngHi: lngRef + 180, lngRef};
}

/**
 * Shifts `lng` by a multiple of 360 degrees so it lands within
 * `[lngRef - 180, lngRef + 180)` -- the standard shortest-signed-angular-
 * difference trick. Used only on the tile side (see design note): the
 * viewport samples themselves are used as their raw, unshifted values.
 */
function normalizeLngNear(lng: number, lngRef: number): number {
    const delta = lng - lngRef;
    const wrapped = ((delta + 180) % 360 + 360) % 360 - 180;
    return lngRef + wrapped;
}

/**
 * Unprojects the 4 viewport corners and 4 edge midpoints through the
 * transform's own inverse, validates each via a screen-space round trip, and
 * returns either a tight (but padded) bbox around the 8 samples, or the
 * full-world bbox if any sample looks like it came from outside the true
 * projection outline (or the samples still span the full globe regardless).
 */
function computeViewportGeoBBox(transform: IReadonlyTransform): GeoBBox {
    const {width, height} = transform;
    const lngRef = transform.center.lng;

    const samplePoints = [
        new Point(0, 0), new Point(width / 2, 0), new Point(width, 0),
        new Point(width, height / 2),
        new Point(width, height), new Point(width / 2, height), new Point(0, height),
        new Point(0, height / 2),
    ];

    const rawLngs: number[] = [];
    const rawLats: number[] = [];

    for (const point of samplePoints) {
        const location = transform.screenPointToLocation(point);
        const {lng, lat} = location;
        if (!isFinite(lng) || !isFinite(lat)) {
            return fullWorldBBox(lngRef);
        }
        // Round-trip validity check (see module doc comment / design note):
        // forward-project the SAME (unwrapped) lng/lat this came from and
        // compare to the original screen point. Do not wrap lng first -- x
        // is linear in the (unwrapped) longitude, not periodic, so wrapping
        // would compare the wrong point and falsely reject legitimate
        // antimeridian-crossing samples.
        const roundTrip = transform.locationToScreenPoint(location);
        const dx = roundTrip.x - point.x;
        const dy = roundTrip.y - point.y;
        if (Math.hypot(dx, dy) > ROUND_TRIP_TOLERANCE_PX) {
            return fullWorldBBox(lngRef);
        }
        rawLngs.push(lng);
        rawLats.push(lat);
    }

    const lngLo = Math.min(...rawLngs);
    const lngHi = Math.max(...rawLngs);
    if (lngHi - lngLo >= 360) {
        // Degenerate/whole-world span; use the canonical full-world form
        // rather than an oddly-wide-but-not-quite-360 interval. Shouldn't
        // happen once the round-trip check above has screened samples --
        // kept as cheap additional insurance.
        return fullWorldBBox(lngRef);
    }

    const latMin = Math.min(...rawLats);
    const latMax = Math.max(...rawLats);

    return {
        latMin: clamp(latMin - BBOX_PAD_DEGREES, -90, 90),
        latMax: clamp(latMax + BBOX_PAD_DEGREES, -90, 90),
        lngLo: lngLo - BBOX_PAD_DEGREES,
        lngHi: lngHi + BBOX_PAD_DEGREES,
        lngRef: (lngLo + lngHi) / 2,
    };
}

/**
 * `IBoundingVolume` whose intersection tests ignore the frustum/plane they
 * are given and return a precomputed verdict instead. See the module doc
 * comment for why: tile visibility here is decided entirely in geography
 * space (tile lat/lng rectangle vs. viewport geographic bbox), not by
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
// mark descendants already-visible and skip their own checks, which is only
// honest for the full-world bbox case, and getting that distinction right
// isn't worth the risk for a naive v1.
const TILE_MAYBE_VISIBLE: IBoundingVolume = new PrecomputedVerdictVolume(IntersectionResult.Partial);
const TILE_NOT_VISIBLE: IBoundingVolume = new PrecomputedVerdictVolume(IntersectionResult.None);

export class EqualEarthCoveringTilesDetailsProvider implements CoveringTilesDetailsProvider {
    private _bbox: GeoBBox = fullWorldBBox(0);

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
     * Stage A is single-world-copy (`getVisibleUnwrappedCoordinates` always
     * renders wrap 0); combined with `allowWorldCopies()` below, `parentWrap`
     * is always already 0 by the time this runs. East/west antimeridian
     * coverage is handled by the longitude-window arithmetic in
     * `getTileBoundingVolume`, not by Mercator's wrap +-1 convention (which
     * would request tiles Stage A can never actually draw).
     */
    getWrap(_centerCoord: MercatorCoordinate, _tileID: {x: number; y: number; z: number}, parentWrap: number): number {
        return parentWrap;
    }

    /**
     * The seam: the only provider method the shared traversal hands the live
     * `transform`, called exactly once per `coveringTiles()` before any tile
     * is visited. Repurposed as a "begin frame" hook to compute and cache
     * this call's geographic bbox. Always returns false: Stage A has no
     * pitch/tilt correctness (recorded in the step 5 notes), so there is no
     * LOD-by-distance concept to offer yet.
     */
    allowVariableZoom(transform: IReadonlyTransform, _options: CoveringTilesOptionsInternal): boolean {
        this._bbox = computeViewportGeoBBox(transform);
        return false;
    }

    /**
     * Matches Globe's choice: both are bounded, non-repeating world shapes,
     * unlike Mercator's infinite repeating plane. Consistent with
     * `getVisibleUnwrappedCoordinates` always rendering a single wrap-0
     * instance in Stage A.
     */
    allowWorldCopies(): boolean {
        return false;
    }

    getTileBoundingVolume(tileID: {x: number; y: number; z: number}, _wrap: number, _elevation: number, _options: CoveringTilesOptionsInternal): IBoundingVolume {
        const numTiles = 1 << tileID.z;
        const bbox = this._bbox;

        if (numTiles === 1) {
            // z=0: the single root tile spans all longitudes by definition,
            // and excluding it would prune the entire traversal. Also
            // sidesteps a real degenerate case: a tile whose own raw width
            // is a full 360 degrees has no single well-defined normalized
            // representative (both its edges are the same antimeridian,
            // approached from opposite sides).
            return TILE_MAYBE_VISIBLE;
        }

        const tileWidthDegrees = 360 / numTiles;
        const midLngRaw = lngFromMercatorX((tileID.x + 0.5) / numTiles);
        const midLngNorm = normalizeLngNear(midLngRaw, bbox.lngRef);
        const tileLo = midLngNorm - tileWidthDegrees / 2;
        const tileHi = midLngNorm + tileWidthDegrees / 2;
        const lngOverlap = tileHi >= bbox.lngLo && tileLo <= bbox.lngHi;

        const tileLatMax = latFromMercatorY(tileID.y / numTiles);
        const tileLatMin = latFromMercatorY((tileID.y + 1) / numTiles);
        const latOverlap = tileLatMax >= bbox.latMin && tileLatMin <= bbox.latMax;

        return (lngOverlap && latOverlap) ? TILE_MAYBE_VISIBLE : TILE_NOT_VISIBLE;
    }

    prepareNextFrame(): void {
        // No cross-frame cache to maintain (unlike Globe's BoundingVolumeCache):
        // the geographic bbox is recomputed fresh every coveringTiles() call.
    }
}
