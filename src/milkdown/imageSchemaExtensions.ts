import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { imageAttr, imageSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";

/** Mirrors Word's text-wrapping modes, trimmed to the ones that make sense
 * for a single atomic image node: "wrap"/"break" float the image (Square /
 * Top-and-Bottom in Word terms), "above" renders it out-of-flow, stacked
 * over the surrounding text (In Front of Text) - and, unlike the other
 * modes, is freely drag-repositionable (see the `x`/`y` attrs below and
 * imageView.ts's position-drag handling). No "behind text" counterpart:
 * with text stacked on top, the image sits under its own hit-testing box
 * and can never be clicked again to change its mode back - a dead end
 * rather than a real layout option. */
export type ImageWrap = "inline" | "wrap" | "break" | "above";

/** Loose shape for the mdast nodes remark hands us - mirrors the same escape
 * hatch used in tableSchemaExtensions.ts/alignmentSchemaExtensions.ts. */
interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  title?: string;
  data?: Record<string, unknown>;
  children?: MdastNode[];
  [key: string]: unknown;
}

// The `;key=value` tail is a generic, order-independent extension point (only
// `width` existed before crop/height did) - old notes with just
// `<!--plainotes-image:inline-->` or `<!--plainotes-image:inline;width=320-->`
// still match, with whichever keys they lack left undefined below.
const SIDECAR_PATTERN = /^<!--plainotes-image:(inline|wrap|break|above)((?:;[a-z]+=[^;]+)*)-->$/;

function wrapOf(node: { attrs: { wrap?: unknown } }): ImageWrap {
  return (node.attrs.wrap as ImageWrap | undefined) ?? "inline";
}

function widthOf(node: { attrs: { width?: unknown } }): number | null {
  const width = node.attrs.width;
  return typeof width === "number" && Number.isFinite(width) ? width : null;
}

function heightOf(node: { attrs: { height?: unknown } }): number | null {
  const height = node.attrs.height;
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

/** The image bytes' MIME type - only meaningful when `src` is a content-addressed asset key
 * (see assetStore.ts) rather than a legacy relative attachment path or an external/data URL,
 * since only that form needs it to reconstruct a displayable Blob from raw bytes with no
 * extension to infer it from (see imageView.ts's resolveSrc). Null for every other src form. */
function mimeOf(node: { attrs: { mime?: unknown } }): string | null {
  const mime = node.attrs.mime;
  return typeof mime === "string" && mime.length > 0 ? mime : null;
}

/** Free-position offsets (CSS px, relative to the note's positioned
 * ancestor) for `wrap: "above"` images once dragged - see imageView.ts's
 * position-drag handling. Null until the image has ever been dragged, so it
 * renders at its typed ("static") position until then, the same
 * null-means-untouched shape `width`/`height` already use. */
function xOf(node: { attrs: { x?: unknown } }): number | null {
  const x = node.attrs.x;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function yOf(node: { attrs: { y?: unknown } }): number | null {
  const y = node.attrs.y;
  return typeof y === "number" && Number.isFinite(y) ? y : null;
}

/** Crop insets as fractions (0-1) of the image's own full width/height -
 * scale-invariant on purpose, so a crop stays put if the image is later
 * resized. All zero means "uncropped". */
export interface ImageCrop {
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
}

function cropOf(node: { attrs: Record<string, unknown> }): ImageCrop {
  return {
    cropLeft: (node.attrs.cropLeft as number) || 0,
    cropTop: (node.attrs.cropTop as number) || 0,
    cropRight: (node.attrs.cropRight as number) || 0,
    cropBottom: (node.attrs.cropBottom as number) || 0,
  };
}

function isCropped(crop: ImageCrop): boolean {
  return crop.cropLeft > 0 || crop.cropTop > 0 || crop.cropRight > 0 || crop.cropBottom > 0;
}

/** Parses the sidecar's `;key=value;key=value` tail into a plain object,
 * ignoring keys it doesn't recognize (forward-compat with older sidecars,
 * and a soft landing if a future version adds more). */
function parseExtras(tail: string): { width?: number; height?: number; crop?: number[]; x?: number; y?: number; mime?: string } {
  const extras: { width?: number; height?: number; crop?: number[]; x?: number; y?: number; mime?: string } = {};
  for (const part of tail.split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "width") extras.width = Number(value);
    else if (key === "height") extras.height = Number(value);
    else if (key === "x") extras.x = Number(value);
    else if (key === "y") extras.y = Number(value);
    else if (key === "mime") extras.mime = value;
    else if (key === "crop") {
      const parts = value.split(",").map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) extras.crop = parts;
    }
  }
  return extras;
}

/** Adds `wrap`/`width`/`height`/crop/`x`/`y` attrs to commonmark's existing
 * `image` node schema via `imageSchema.extendSchema(...)` - safe to `.use()`
 * under the same node id (unlike paragraph/heading in
 * alignmentSchemaExtensions.ts, `image` is never ProseMirror's default
 * "fill" node for generic content, so the re-registration reordering that
 * pattern's comment warns about doesn't apply here). All of them round-trip
 * through a single
 * `<!--plainotes-image:wrap;width=N;height=N;x=N;y=N;crop=l,t,r,b-->`
 * sidecar comment placed immediately after the image markdown - since
 * `image` is an inline atom, this lands as an inline sibling within the same
 * paragraph rather than a block-level sibling (contrast with the
 * table/align sidecars, which sit on their own line). `width`/`height` are
 * the display frame size in CSS pixels set by dragging a resize handle in
 * imageView.ts; the crop fractions are set by the crop tool in the same
 * file and describe how much of the image is trimmed from each edge before
 * that frame is filled; `x`/`y` are the free-position offset set by
 * dragging a `wrap: "above"` image around, also in imageView.ts. */
export const imageSchemaExt = imageSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: {
      ...base.attrs,
      wrap: { default: "inline" },
      width: { default: null },
      height: { default: null },
      x: { default: null },
      y: { default: null },
      cropLeft: { default: 0 },
      cropTop: { default: 0 },
      cropRight: { default: 0 },
      cropBottom: { default: 0 },
      mime: { default: null },
    },
    // Spelled out (rather than the base's `...node.attrs` spread) so the
    // custom attrs don't leak onto the rendered <img> as literal HTML
    // attributes - the custom NodeView in imageView.ts is what actually
    // renders the editor, this only matters for clipboard/HTML-export
    // serialization. Crop isn't reflected here since expressing it in plain
    // exported HTML would need the same clip-and-offset wrapper the NodeView
    // uses - an acceptable gap for a copy-out-of-the-app edge case.
    toDOM: (node: ProseNode) => [
      "img",
      {
        ...ctx.get(imageAttr.key)(node),
        src: node.attrs.src,
        alt: node.attrs.alt,
        title: node.attrs.title,
        ...(widthOf(node) ? { width: String(widthOf(node)) } : {}),
        ...(heightOf(node) ? { height: String(heightOf(node)) } : {}),
      },
    ],
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const mdastNode = node as MdastNode;
        const data = mdastNode.data ?? {};
        state.addNode(type, {
          src: mdastNode.url ?? "",
          alt: mdastNode.alt ?? "",
          title: mdastNode.title ?? "",
          wrap: (data.wrap as ImageWrap | undefined) ?? "inline",
          width: (data.width as number | undefined) ?? null,
          height: (data.height as number | undefined) ?? null,
          x: (data.x as number | undefined) ?? null,
          y: (data.y as number | undefined) ?? null,
          cropLeft: (data.cropLeft as number | undefined) ?? 0,
          cropTop: (data.cropTop as number | undefined) ?? 0,
          cropRight: (data.cropRight as number | undefined) ?? 0,
          cropBottom: (data.cropBottom as number | undefined) ?? 0,
          mime: (data.mime as string | undefined) ?? null,
        });
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        base.toMarkdown.runner(state, node);
        const wrap = wrapOf(node);
        const width = widthOf(node);
        const height = heightOf(node);
        const x = xOf(node);
        const y = yOf(node);
        const crop = cropOf(node);
        const mime = mimeOf(node);
        if (wrap === "inline" && width === null && height === null && x === null && y === null && !isCropped(crop) && !mime)
          return;
        let extras = "";
        if (width !== null) extras += `;width=${Math.round(width)}`;
        if (height !== null) extras += `;height=${Math.round(height)}`;
        if (x !== null) extras += `;x=${Math.round(x)}`;
        if (y !== null) extras += `;y=${Math.round(y)}`;
        if (mime) extras += `;mime=${mime}`;
        if (isCropped(crop)) {
          extras += `;crop=${[crop.cropLeft, crop.cropTop, crop.cropRight, crop.cropBottom]
            .map((n) => n.toFixed(4))
            .join(",")}`;
        }
        state.addNode("html", undefined, `<!--plainotes-image:${wrap}${extras}-->`);
      },
    },
  };
});

/** Recursively finds `image` nodes immediately followed by a
 * `<!--plainotes-image:...-->` sidecar (as an inline sibling in the same
 * phrasing-content array) and stamps the value(s) onto `data`, the same
 * hand-rolled sibling-scan shape as tableSchemaExtensions.ts's
 * processChildren/alignmentSchemaExtensions.ts's processAlignSidecars.
 * Unlike those two, no "flattened into paragraph > html" case to handle:
 * commonmark's remarkHtmlTransformer only promotes *top-level* stray html
 * nodes that way, and this sidecar is never top-level - it's parsed as
 * inline raw HTML directly inside the paragraph that already contains its
 * image, since it's written immediately after it with no line break. */
function processImageWrapSidecars(children: MdastNode[] | undefined) {
  if (!children) return;
  for (let i = children.length - 1; i >= 0; i--) {
    const prev = children[i - 1];
    const node = children[i];
    const isSidecar = i > 0 && prev.type === "image" && node.type === "html" && typeof node.value === "string";
    const match = isSidecar ? SIDECAR_PATTERN.exec((node.value as string).trim()) : null;
    if (match) {
      const extras = parseExtras(match[2] ?? "");
      prev.data = {
        ...(prev.data ?? {}),
        wrap: match[1] as ImageWrap,
        ...(extras.width !== undefined ? { width: extras.width } : {}),
        ...(extras.height !== undefined ? { height: extras.height } : {}),
        ...(extras.x !== undefined ? { x: extras.x } : {}),
        ...(extras.y !== undefined ? { y: extras.y } : {}),
        ...(extras.mime !== undefined ? { mime: extras.mime } : {}),
        ...(extras.crop
          ? {
              cropLeft: extras.crop[0],
              cropTop: extras.crop[1],
              cropRight: extras.crop[2],
              cropBottom: extras.crop[3],
            }
          : {}),
      };
      children.splice(i, 1);
      continue;
    }
    processImageWrapSidecars(node.children);
  }
}

/** Must be `.use()`d after commonmark (and, if the image sits right after a
 * table, after gfm too) so their remark plugins have already settled the
 * tree shape - same ordering requirement as tableSidecarRemark/
 * alignmentSidecarRemark. */
export const imageWrapSidecarRemark = $remark("plainotesImageWrapFormatting", () => () => (tree) => {
  processImageWrapSidecars((tree as unknown as MdastNode).children);
});
