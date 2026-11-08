import {PosArray, TriangleIndexArray} from '../data/array_types.g.ts';
import posAttributes from '../data/pos_attributes.ts';
import {SegmentVector} from '../data/segment.ts';
import {EXTENT} from '../data/extent.ts';
import {mercatorYfromLat} from '../geo/mercator_coordinate.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {NORTH_POLE_Y, SOUTH_POLE_Y} from './subdivision.ts';
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
 * Marks every pixel outside the projection outline with stencil bit 0x80:
 * beyond the lambda0 +/- 180 deg seam meridians, and beyond the flat pole
 * lines, where world-copy and high-latitude labels would otherwise reach.
 * The pass sets the bit across the whole framebuffer with a stencil clear
 * restricted to that bit (tile clipping IDs in bits 0-6 survive it), then
 * clears it again over the outline's interior. In mercator/tile space the
 * interior is one plain rectangle in z0-tile coordinates, between the seam
 * lines x = lambda0/360 and x = lambda0/360 + 1 (unwrapped), whose top and
 * bottom rows are the pole sentinels `NORTH_POLE_Y`/`SOUTH_POLE_Y` that the
 * vertex shader places on the pole lines; the Equal Earth vertex shader bends
 * its seam edges onto the exact curved projection outline. Content draws need
 * no changes: their stencil test (EQUAL, ref = tile ID with bit 7 clear,
 * mask 0xFF) fails wherever the seam bit is set.
 */
export class SeamClipMask {
    private vertexBuffer: VertexBuffer;
    private indexBuffer: IndexBuffer;
    private segments: SegmentVector;

    draw(frameRenderContext: FrameRenderContext): void {
        const context = frameRenderContext.context;
        const gl = context.gl;
        const transform = frameRenderContext.transform;

        // Seam x in z0-tile coordinates; center.lng IS lambda0. The seam
        // edges must be SUBDIVIDED: the vertex shader bends vertices, not
        // edges, so a single pole-to-pole segment would rasterize as a
        // straight chord instead of the curved outline.
        const seamWest = Math.round((transform.center.lng / 360) * EXTENT);
        const seamEast = seamWest + EXTENT;
        // Rows are uniform in LATITUDE, not mercator y: mercator-y-uniform
        // rows are sparsest at the equator, where their chords sag inward
        // and cut scallops out of content. 158 rows keep the chord error
        // sub-0.1 px; the +/-89.999 rows and the pole sentinel rows close
        // the strip onto the pole lines.
        const SEAM_LAT_LIMIT = 89.95;
        const SEAM_STEPS = 158;
        const rowYs: number[] = [NORTH_POLE_Y, Math.round(mercatorYfromLat(89.999) * EXTENT)];
        for (let i = 0; i <= SEAM_STEPS; i++) {
            const lat = SEAM_LAT_LIMIT - (2 * SEAM_LAT_LIMIT) * i / SEAM_STEPS;
            rowYs.push(Math.round(mercatorYfromLat(lat) * EXTENT));
        }
        rowYs.push(Math.round(mercatorYfromLat(-89.999) * EXTENT), SOUTH_POLE_Y);
        const interiorArray = new PosArray();
        for (const y of rowYs) {
            interiorArray.emplaceBack(seamWest, y);
            interiorArray.emplaceBack(seamEast, y);
        }

        if (!this.vertexBuffer) {
            this.vertexBuffer = context.createVertexBuffer(interiorArray, posAttributes.members, true);
            const interiorIndices = new TriangleIndexArray();
            const rows = rowYs.length;
            for (let i = 0; i < rows - 1; i++) {
                const row = i * 2;
                interiorIndices.emplaceBack(row, row + 1, row + 2);
                interiorIndices.emplaceBack(row + 1, row + 3, row + 2);
            }
            this.indexBuffer = context.createIndexBuffer(interiorIndices);
            this.segments = SegmentVector.simpleSegment(0, 0, 2 * rows, 2 * (rows - 1));
        } else {
            this.vertexBuffer.updateData(interiorArray);
        }

        context.stencilMask.set(SEAM_STENCIL_BIT);
        context.clearStencil.set(SEAM_STENCIL_BIT);
        gl.clear(gl.STENCIL_BUFFER_BIT);

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
            // Clear ONLY the seam bit, everywhere the interior strip covers.
            new StencilMode({func: gl.ALWAYS, mask: 0}, 0, SEAM_STENCIL_BIT, gl.KEEP, gl.KEEP, gl.REPLACE),
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
