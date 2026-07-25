export interface HeadingSlug {
  level: number;
  /** Approximate rendered text (inline markdown stripped), for display in the picker. */
  text: string;
  /** Predicted DOM id this heading would render with in the live editor. */
  slug: string;
}

/** Strips the inline Markdown constructs that don't survive into a heading's rendered
 * `textContent` (bold/italic/strikethrough/inline-code/links), so the slug predicted below
 * matches what Milkdown's `headingIdGenerator` would actually compute from the live node. */
function approximateTextContent(rawText: string): string {
  return rawText
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/___(.+?)___/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+?)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .trim();
}

/** Mirrors `@milkdown/preset-commonmark`'s `defaultHeadingIdGenerator` exactly: lowercase, trim,
 * collapse whitespace runs to a single dash - no punctuation stripping. */
function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, "-");
}

const HEADING_LINE = /^(#{1,6})\s+(.*)$/;

/** Scans raw saved Markdown for headings and predicts the DOM id each would render with in the
 * live editor, including duplicate-slug dedup - re-implements `syncHeadingIdPlugin`'s exact
 * `idMap` walk (see node_modules/@milkdown/preset-commonmark/src/plugin/sync-heading-id-plugin.ts)
 * in document order, since that plugin is what actually assigns ids live. This is necessarily
 * best-effort against saved-on-disk text, not a live ProseMirror doc - a heading picked here might
 * drift from the live id if the note has unsaved edits elsewhere. Headings with no text (after
 * stripping) are skipped, matching that plugin's own skip of empty headings. */
export function predictHeadingSlugs(content: string): HeadingSlug[] {
  const headings: HeadingSlug[] = [];
  const idMap: Record<string, number> = {};

  for (const line of content.split("\n")) {
    const match = HEADING_LINE.exec(line);
    if (!match) continue;
    const text = approximateTextContent(match[2]);
    if (!text) continue;

    let slug = slugify(text);
    if (idMap[slug]) {
      idMap[slug] += 1;
      slug += `-#${idMap[slug]}`;
    } else {
      idMap[slug] = 1;
    }

    headings.push({ level: match[1].length, text, slug });
  }

  return headings;
}
