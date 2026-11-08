import {PosArray, TriangleIndexArray} from '../data/array_types.g.ts';
import posAttributes from '../data/pos_attributes.ts';
import {SegmentVector} from '../data/segment.ts';
import {EXTENT} from '../data/extent.ts';
import {mercatorYfromLat} from '../geo/mercator_coordinate.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {DepthMode} from '../webgl/depth_mode.ts';
import {StencilMode} from '../webgl/stencil_mode.ts';
import {ColorMode} from '../webgl/color_mode.ts';
import {CullFaceMode} from '../webgl/cull_face_mode.ts';

import type {VertexBuffer} from '../webgl/vertex_buffer.ts';
import type {IndexBuffer} from '../webgl/index_buffer.ts';
import type {FrameRenderContext} from './frame_render_context.ts';

/**
 * The stencil bit the Equal Earth engine antimeridian clip reserves for
 * "beyond the projection outline". While the clip is active, tile and
 * overlap stencil IDs stay below it (see `FrameRenderContext`).
 */
export const SEAM_STENCIL_BIT = 0x80;

/**
 * @internal
 * GPU geometry for the Equal Earth engine antimeridian clip (seam-bit
 * stencil pre-pass; design: docs/resources/2026-07-22-stencil-seam-clip-design.md
 * in the outer repo). Owned by the painter so the buffers outlive a frame;
 * `FrameRenderContext` decides when to draw it.
 *
 * Marks every pixel beyond the lambda0 +/- 180 deg seam meridians with
 * stencil bit 0x80. In mercator/tile space the seams are the vertical lines
 * x = lambda0/360 and x = lambda0/360 + 1 (unwrapped), so the mask is two
 * plain rectangles in z0-tile coordinates; the Equal Earth vertex shader
 * bends their seam edges onto the exact curved projection outline. Content
 * draws need no changes: their stencil test (EQUAL, ref = tile ID with bit 7
 * clear, mask 0xFF) fails wherever the seam bit is set.
 */
export class SeamClipMask {
    private vertexBuffer: VertexBuffer;
    private indexBuffer: IndexBuffer;
    private segments: SegmentVector;

    draw(frameRenderContext: FrameRenderContext): void {
        const context = frameRenderContext.context;
        const gl = context.gl;
        const transform = frameRenderContext.transform;

        // Seam x in z0-tile coordinates. center.lng IS lambda0; each strip
        // extends one full world width beyond its seam (rendered world
        // copies never reach further at outline-fit zooms) and past the
        // pole lines vertically. The seam-side edge must be SUBDIVIDED:
        // the vertex shader bends vertices, not edges, and a single
        // pole-to-pole segment would rasterize as a straight line instead
        // of the curved outline (that exact failure was this pass's first
        // draft). PosArray is int16: max |coord| here is
        // 2.5 * EXTENT = 20480 < 32767.
        const seamWest = Math.round((transform.center.lng / 360) * EXTENT);
        const seamEast = seamWest + EXTENT;
        // Sample the seam edge uniformly in LATITUDE, not mercator y:
        // mercator-y-uniform sampling is densest at the poles and sparsest
        // at the equator (a step there spanned ~17 deg of latitude), so the
        // chords sagged inward and cut visible scallops out of content near
        // the equator (owner-reported). 158 uniform-latitude rows keep the
        // chord error sub-0.1 px; the +/-89.999 end rows close the strip
        // over the last sliver toward the pole lines. Row y values are
        // identical for both strips, so compute once.
        const SEAM_LAT_LIMIT = 89.95;
        const SEAM_STEPS = 158;
        const rowYs: number[] = [Math.round(mercatorYfromLat(89.999) * EXTENT)];
        for (let i = 0; i <= SEAM_STEPS; i++) {
            const lat = SEAM_LAT_LIMIT - (2 * SEAM_LAT_LIMIT) * i / SEAM_STEPS;
            rowYs.push(Math.round(mercatorYfromLat(lat) * EXTENT));
        }
        rowYs.push(Math.round(mercatorYfromLat(-89.999) * EXTENT));
        const seamArray = new PosArray();
        for (const [innerX, outerX] of [[seamWest, seamWest - EXTENT], [seamEast, seamEast + EXTENT]]) {
            for (const y of rowYs) {
                seamArray.emplaceBack(innerX, y);
                seamArray.emplaceBack(outerX, y);
            }
        }
        const vertsPerStrip = rowYs.length * 2;

        if (!this.vertexBuffer) {
            this.vertexBuffer = context.createVertexBuffer(seamArray, posAttributes.members, true);
            const seamIndices = new TriangleIndexArray();
            const rows = rowYs.length;
            for (let strip = 0; strip < 2; strip++) {
                const base = strip * vertsPerStrip;
                for (let i = 0; i < rows - 1; i++) {
                    const row = base + i * 2;
                    seamIndices.emplaceBack(row, row + 1, row + 2);
                    seamIndices.emplaceBack(row + 1, row + 3, row + 2);
                }
            }
            this.indexBuffer = context.createIndexBuffer(seamIndices);
            this.segments = SegmentVector.simpleSegment(0, 0, 2 * vertsPerStrip, 2 * (rows - 1) * 2);
        } else {
            this.vertexBuffer.updateData(seamArray);
        }

        // z0/wrap0 projection data: the polynomial shader path recovers
        // unwrapped lng from these tile coords (the lambda0 fold included),
        // bending the straight seam edges onto the curved outline.
        // applyGlobeMatrix MUST be true: false forces projectionTransition
        // to 0, which renders geometry at the mercator fallback position —
        // the mask is a pure-EE construct and must be projected by the full
        // EE path. No uniformBufferKey: it is drawn once per stencil epoch,
        // so it goes through the shared (unkeyed) projection buffer.
        const projectionData = transform.getProjectionData({overscaledTileID: new OverscaledTileID(0, 0, 0, 0, 0), applyGlobeMatrix: true});

        frameRenderContext.useProgram('clippingMask').draw(context, gl.TRIANGLES,
            DepthMode.disabled,
            // Write ONLY the seam bit, everywhere the quads cover.
            new StencilMode({func: gl.ALWAYS, mask: 0}, SEAM_STENCIL_BIT, SEAM_STENCIL_BIT, gl.KEEP, gl.KEEP, gl.REPLACE),
            ColorMode.disabled, CullFaceMode.disabled,
            null, null, projectionData,
            '$clipping', this.vertexBuffer,
            this.indexBuffer, this.segments);
    }

    destroy(): void {
        this.vertexBuffer?.destroy();
        this.indexBuffer?.destroy();
        this.segments?.destroy();
    }
}
