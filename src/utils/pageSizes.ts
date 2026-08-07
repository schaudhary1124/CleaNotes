import type { NoteLook, PageSetup } from "../types";

/** Physical page dimensions/conversion helpers for Fixed-Size notes - shared by Editor.tsx
 * (desktop) and browser-guest/BrowserEditor.tsx (guest) for both the live page-guide rendering
 * and print/export CSS sizing, so the two stay in lockstep. Deliberately has no Tauri
 * dependency, same reasoning as pageBreak.ts. */

const A4_MM = { width: 210, height: 297 };
const LETTER_MM = { width: 216, height: 279 };

// A custom dimension below this is almost certainly a not-yet-finished edit (e.g. the number
// input momentarily empty/"0" while the user is mid-keystroke replacing it - see
// PageSetupDropdown.tsx's onChange) rather than a deliberately tiny page - falling back to the
// A4 default for a moment is far less broken than briefly rendering a ~0-width page.
const MIN_CUSTOM_DIMENSION_MM = 20;

/** This page setup's physical width/height in mm, already accounting for orientation (for the
 * two presets - a custom size is used exactly as entered, orientation has no effect on it).
 * Deliberately `||`, not `??`: 0 is just as much a "not a real dimension yet" value as
 * null/undefined here, unlike most 0-is-valid numeric fields elsewhere in this codebase. */
export function pageDimensionsMm(setup: PageSetup): { widthMm: number; heightMm: number } {
  if (setup.size === "custom") {
    const width = setup.customWidthMm ?? 0;
    const height = setup.customHeightMm ?? 0;
    return {
      widthMm: width >= MIN_CUSTOM_DIMENSION_MM ? width : A4_MM.width,
      heightMm: height >= MIN_CUSTOM_DIMENSION_MM ? height : A4_MM.height,
    };
  }
  const base = setup.size === "letter" ? LETTER_MM : A4_MM;
  return setup.orientation === "landscape"
    ? { widthMm: base.height, heightMm: base.width }
    : { widthMm: base.width, heightMm: base.height };
}

// Fixed-Size notes' margin is no longer user-configurable (PageSetupDropdown.tsx dropped the
// control for simplicity) - every note uses this single value regardless of whatever `marginMm`
// happens to be persisted in its PageSetup (old notes saved before this change may still carry a
// different number there; it's simply ignored now).
export const FIXED_MARGIN_MM = 14;

/** The margin to actually use for `setup` - always FIXED_MARGIN_MM. Always call this instead of
 * reading `setup.marginMm` directly for anything that affects layout. */
export function clampedMarginMm(_setup: PageSetup): number {
  return FIXED_MARGIN_MM;
}

// Must match index.css's own `--rule` for each look exactly (`.note-look-paper`/`.note-look-
// index-card`) - there's no single source of truth shared between CSS and layout code elsewhere
// in this file either (mmToPx/PX_PER_MM below is the same kind of mirrored constant), so this
// keeps the same pattern rather than introducing a new one just for this.
const RULE_PX: Partial<Record<NoteLook, number>> = { paper: 27, "index-card": 34 };

// How many blank ruled lines sit above the first line of content and below the last, on every
// page, for a ruled look - i.e. content starts on line 3 and ends 2 lines short of the page's
// bottom edge, the same convention a physical ruled notebook page uses (a blank header/footer
// band, not text running edge-to-edge) rather than starting flush against the top margin the way
// Plain/Grid do.
const RULED_LOOK_BLANK_LINES = 2;

/** The *vertical* (top/bottom) margin to use for `setup`/`look` - `clampedMarginMm`'s physical mm
 * figure for Plain/Grid (unaffected by this), but for Paper/Index Card, whole multiples of that
 * look's own `--rule` instead, so content always starts on the same numbered ruled line and ends
 * the same number of lines short of the bottom, page after page, instead of the physical margin
 * (which isn't a multiple of either look's rule height) landing content mid-line. Horizontal
 * (left/right) margins are unaffected by look - callers should keep using `clampedMarginMm` for
 * those, and only substitute this for padding-top/padding-bottom and paginationLayout.ts's
 * marginTopPx/marginBottomPx. */
export function verticalMarginPx(setup: PageSetup, look: NoteLook): number {
  const rulePx = RULE_PX[look];
  return rulePx ? rulePx * RULED_LOOK_BLANK_LINES : mmToPx(clampedMarginMm(setup));
}

// CSS reference pixel density (96dpi) - the standard "1px = 1/96in" conversion every browser
// uses for physical CSS units, so this matches how `mm`-specified CSS would itself render.
const PX_PER_MM = 96 / 25.4;

// Rounded to a whole CSS px: these values are only ever used for on-screen sizing (width,
// height, padding) on an element that also has CSS `zoom` applied (Editor.tsx/BrowserEditor.tsx) -
// print uses the exact `mm` figures directly in an `@page` rule, never this function. A fractional
// base value (e.g. 20mm -> 75.590551...px) compounds with `zoom`'s own used-value scaling in a way
// that made the page's margins visibly shift by a stray pixel between zoom levels even though
// nothing about the page itself changed - starting from a whole px removes that extra source of
// drift (see paginationLayout.ts's `recompute` for the equivalent fix on its own measurements).
export function mmToPx(mm: number): number {
  return Math.round(mm * PX_PER_MM);
}
