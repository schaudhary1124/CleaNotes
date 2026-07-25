const NOTE_LINK_SCHEME = "note://";

/** The two mutually-exclusive ways a link can point at a specific spot inside a note, beyond
 * just the note itself: an existing heading (predicted/live DOM id - see headingSlug.ts), or a
 * `notePin` node the user planted with "Copy link to this point" (see notePin.ts). Never both at
 * once - there's no UI that would produce that combination. */
export interface NoteLinkAnchor {
  headingId?: string;
  pinId?: string;
}

/** Builds an internal note-link href, encoded so it survives round-tripping through standard
 * Markdown `[text](url)` syntax. Per-segment `encodeURIComponent` (not a blanket `encodeURI`)
 * because `encodeURI` leaves `(`/`)` unescaped, which would prematurely close a Markdown link
 * if a note title contains parens. `/` is kept literal as the path separator. Heading anchors use
 * a `#fragment` (matching a real DOM id lookup), pin anchors use a `?pin=` query param instead -
 * kept as two different URL parts (rather than overloading one) so a stray `#`/`?` in whichever
 * one is unset never has to be reasoned about. */
export function buildNoteLinkHref(path: string, anchor?: NoteLinkAnchor): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const base = `${NOTE_LINK_SCHEME}${encodedPath}`;
  if (anchor?.pinId) return `${base}?pin=${encodeURIComponent(anchor.pinId)}`;
  if (anchor?.headingId) return `${base}#${encodeURIComponent(anchor.headingId)}`;
  return base;
}

export interface NoteLinkTarget {
  path: string;
  headingId?: string;
  pinId?: string;
}

/** Parses an href built by `buildNoteLinkHref`, or returns null if it isn't one of ours
 * (e.g. a plain external URL). `headingId`/`pinId` are decoded back to their raw form, since
 * that's what `document.getElementById` needs to match the target's actual (unencoded) DOM id -
 * a heading's live id, or `note-pin-<pinId>` for a pin (see notePinView.ts). */
export function parseNoteLinkHref(href: string): NoteLinkTarget | null {
  if (!href.startsWith(NOTE_LINK_SCHEME)) return null;
  const rest = href.slice(NOTE_LINK_SCHEME.length);
  const [pathAndQuery, rawHeadingId] = rest.split("#");
  const [rawPath, rawQuery] = pathAndQuery.split("?");
  if (!rawPath) return null;
  try {
    const path = rawPath.split("/").map(decodeURIComponent).join("/");
    const headingId = rawHeadingId ? decodeURIComponent(rawHeadingId) : undefined;
    const pinMatch = rawQuery ? /^pin=(.+)$/.exec(rawQuery) : null;
    const pinId = pinMatch ? decodeURIComponent(pinMatch[1]) : undefined;
    return { path, headingId, pinId };
  } catch {
    return null;
  }
}

/** Loose heuristic for "this typed/pasted text is clearly meant to be a URL" (a YouTube link, any
 * other external site, a bare domain, mailto:/tel:, ...) rather than a note-search query - lets
 * NoteLinkQuickPicker offer "Add link to <url>" instead of just (fruitlessly) searching note
 * titles for it. Deliberately permissive: false negatives just fall back to note search
 * (harmless), false positives are rare since real search queries tend to contain spaces. */
export function looksLikeExternalUrl(text: string): boolean {
  if (!text || /\s/.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(text);
}

/** Normalizes a `looksLikeExternalUrl` match into a real href - a bare domain/path with no scheme
 * defaults to `https://`, matching how browsers treat a domain typed into the address bar. */
export function normalizeExternalUrl(text: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
}

/** The tooltip/mark-title text for a resolved note-link target - shared between applying a real
 * `link` mark to a pasted href (see NoteLinkPicker.tsx's confirmPastedTarget) and labeling a
 * pasted-with-no-selection `noteLinkChip` glyph (see Editor.tsx's paste handling), so the two
 * paths describe the same target identically. */
export function describeNoteLinkTarget(target: NoteLinkTarget): string {
  if (target.pinId) return "pinned point · ⌘-click to open";
  if (target.headingId) return `${target.headingId.replace(/-/g, " ")} · ⌘-click to open`;
  return "⌘-click to open";
}
