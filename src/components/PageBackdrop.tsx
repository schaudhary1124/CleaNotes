import type { CSSProperties } from "react";
import type { NoteLook } from "../types";

/** One page's position/size, in the paginated content wrapper's own local coordinate space
 * (i.e. relative to `sketchWrapperRef` in Editor.tsx, the same `position: relative` ancestor
 * SketchLayer already composites against) - `top`/`height` in px. */
export interface PageRect {
  top: number;
  height: number;
}

/** One `.page-surface` div per page - both the visible "sheet of paper" (border + shadow,
 * physically separating each page from the next across the real blank gap paginationLayout.ts's
 * PluginView already reserves there via `marginTop` on the block that follows) and, for any look
 * other than Plain, that page's own independent copy of the tint/ruled-line/grid-dot background -
 * index.css's `.page-surface.note-look-*` rules. Deliberately N separate elements rather than one
 * continuous background painted across the whole multi-page canvas (an earlier version worked
 * that way): a single repeating background has no way to know a page boundary exists partway
 * through it, so its pattern just kept counting pixels straight through the margin/gap dead zone
 * between pages - correctly lined up with the text on page 1 (which starts at the same y=0 the
 * pattern does), and increasingly out of sync on every page after, since each page's own text
 * restarts at its own top margin while the pattern doesn't. Giving each page its own div lets
 * each one's background-position restart at that page's own top margin instead, the same way its
 * text does. Rendered behind the live text (`-z-10` on the wrapper below), one absolutely-
 * positioned box per page rather than per-gap divider lines - a page's own border/shadow already
 * reads as a physical sheet boundary, so there's nothing left for a separate divider to add. */
export function PageBackdrop({
  pages,
  width,
  marginPx,
  verticalMarginPx,
  look,
}: {
  pages: PageRect[];
  width: number;
  marginPx: number;
  /** Top/bottom margin - see utils/pageSizes.ts's `verticalMarginPx`, which for Paper/Index Card
   * is a whole multiple of that look's own `--rule` rather than `marginPx`'s physical mm figure,
   * so the ruled background (index.css) can mask out the blank header/footer band above/below
   * content instead of tiling ruled lines straight through it. */
  verticalMarginPx: number;
  look: NoteLook;
}) {
  const ruled = look === "paper" || look === "index-card";
  return (
    <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
      {pages.map((page, i) => (
        <div
          key={i}
          className={`page-surface absolute left-0 ${look !== "plain" ? `note-look-${look}` : ""}`}
          style={
            {
              top: page.top,
              width,
              height: page.height,
              "--page-margin": `${marginPx}px`,
              "--page-margin-top": `${verticalMarginPx}px`,
            } as CSSProperties
          }
        >
          {/* Separate element, not another `.page-surface` background layer - see index.css's
           * `.page-rule-lines` for why the mask that keeps this out of the blank header/footer
           * band needs a genuine `mask-image` rather than another background layer.
           * `--page-margin-top` inherits from the parent `.page-surface` div above, already set
           * there - no need to redeclare it here. */}
          {ruled && <div className="page-rule-lines" />}
        </div>
      ))}
    </div>
  );
}
