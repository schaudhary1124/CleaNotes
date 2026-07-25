import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, Copy, Link, MapPin, Pencil, Trash2, Unlink } from "lucide-react";
import { ToolbarPopover } from "./ToolbarPopover";
import { NoteLinkQuickPicker, type NoteLinkChoice } from "./NoteLinkPicker";
import { buildNoteLinkHref } from "../milkdown/noteLinkHref";
import { getBacklinksForAnchor } from "../utils/backlinksIndex";
import type { EditorSelectionRange } from "../milkdown/setup";

const GAP_PX = 8;

function AddLinkPopover({
  anchorRef,
  notes,
  onConfirm,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  notes: NoteLinkChoice[];
  onConfirm: (href: string, markTitle: string) => void;
  onClose: () => void;
}) {
  return (
    <ToolbarPopover
      anchorRef={anchorRef}
      onClose={onClose}
      className="glass-panel shadow-app-lg border-subtle w-72 rounded-xl border p-3"
    >
      <NoteLinkQuickPicker notes={notes} onConfirm={onConfirm} onCancel={onClose} autoFocus />
    </ToolbarPopover>
  );
}

interface SelectionLinkToolbarProps {
  /** Null hides the toolbar entirely - only a genuine highlighted text range shows it (see
   * setup.ts's reportSelectionRange for what qualifies). */
  range: EditorSelectionRange | null;
  notes: NoteLinkChoice[];
  onCopyLinkToPoint: () => Promise<void>;
  onApplyLink: (href: string, markTitle: string) => void;
}

/** Floating toolbar shown right above (or, if there's no room, below) the current text
 * selection - the entry point for both of the selection-triggered linking actions: planting a
 * "Copy link to this point" pin (see notePin.ts), or "Add link" to search/paste one in (see
 * NoteLinkPicker.tsx's NoteLinkQuickPicker). Replaces the old toolbar "Link" button + centered
 * modal entirely.
 *
 * Positioned from the native selection's own bounding box (`window.getSelection()`) rather than
 * re-deriving it from ProseMirror's `coordsAtPos` - simpler, and the two agree exactly while the
 * editor is focused, since a ProseMirror TextSelection *is* the DOM selection. */
export function SelectionLinkToolbar({ range, notes, onCopyLinkToPoint, onApplyLink }: SelectionLinkToolbarProps) {
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed", visibility: "hidden" });
  const [copied, setCopied] = useState(false);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const addLinkAnchorRef = useRef<HTMLButtonElement>(null);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!range) {
      setAddLinkOpen(false);
      setStyle((prev) => (prev.visibility === "hidden" ? prev : { position: "fixed", visibility: "hidden" }));
      return;
    }
    function place() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const width = toolbarRef.current?.offsetWidth ?? 0;
      const height = toolbarRef.current?.offsetHeight ?? 0;
      const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8);
      const above = rect.top > height + GAP_PX + 8;
      const top = above ? rect.top - height - GAP_PX : rect.bottom + GAP_PX;
      setStyle({ position: "fixed", left, top, zIndex: 50 });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.from, range?.to]);

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  if (!range) return null;

  async function handleCopy() {
    await onCopyLinkToPoint();
    setCopied(true);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopied(false), 1600);
  }

  return createPortal(
    <div
      ref={toolbarRef}
      style={style}
      className="glass-panel shadow-app-lg border-subtle flex items-center gap-0.5 rounded-lg border p-1"
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleCopy}
        title="Copy link to this point"
        aria-label="Copy link to this point"
        className="btn-ghost flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs"
      >
        {copied ? <Check size={13} /> : <MapPin size={13} />}
        {copied ? "Copied" : "Copy link to this point"}
      </button>
      <div className="divider mx-0.5 h-5 w-px shrink-0" />
      <button
        ref={addLinkAnchorRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setAddLinkOpen((v) => !v)}
        title="Add link"
        aria-label="Add link"
        aria-expanded={addLinkOpen}
        className={`btn-ghost flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs ${addLinkOpen ? "bg-accent-soft text-accent" : ""}`}
      >
        <Link size={13} />
        Add link
      </button>
      {addLinkOpen && (
        <AddLinkPopover
          anchorRef={addLinkAnchorRef}
          notes={notes}
          onConfirm={(href, title) => {
            setAddLinkOpen(false);
            onApplyLink(href, title);
          }}
          onClose={() => setAddLinkOpen(false)}
        />
      )}
    </div>,
    document.body,
  );
}

interface NotePinPopoverProps {
  notePath: string;
  pinId: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onRemove: () => void;
  onClose: () => void;
}

/** Opened by clicking a pin glyph in the text (see notePinView.ts) - lets the user re-copy that
 * point's link, see which other notes already link to it (the "keep track of what notes are
 * linking to that specific point" ask), and remove the pin outright. */
export function NotePinPopover({ notePath, pinId, anchorRef, onRemove, onClose }: NotePinPopoverProps) {
  const [copied, setCopied] = useState(false);
  const backlinks = useMemo(() => getBacklinksForAnchor(notePath, pinId), [notePath, pinId]);

  function handleCopy() {
    navigator.clipboard.writeText(buildNoteLinkHref(notePath, { pinId })).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <ToolbarPopover
      anchorRef={anchorRef}
      onClose={onClose}
      className="glass-panel shadow-app-lg border-subtle w-auto rounded-xl border p-1"
    >
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy link"}
          aria-label={copied ? "Copied" : "Copy link"}
          className="btn-ghost flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          type="button"
          onClick={() => {
            onRemove();
            onClose();
          }}
          title="Remove"
          aria-label="Remove"
          className="hover:bg-danger-soft text-danger flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {backlinks.length > 0 && (
        <>
          <div className="border-subtle my-1 border-t" />
          <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto px-1 py-0.5">
            {backlinks.map((hit, i) => (
              <div key={`${hit.sourcePath}:${i}`} className="text-secondary truncate rounded-md px-1 py-0.5 text-xs">
                {hit.sourceTitle}
              </div>
            ))}
          </div>
        </>
      )}
    </ToolbarPopover>
  );
}

interface LinkPopoverProps {
  href: string;
  markTitle: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  notes: NoteLinkChoice[];
  onOpen: () => void;
  onApplyEdit: (href: string, markTitle: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

/** Opened by a plain click on a link - whether real link-marked text or a pasted `noteLinkChip`
 * glyph (see noteLinkClick.ts/noteLinkChipView.ts) - the Google-Docs-style "click a link, get a
 * small options card" entry point: open it, copy its href, repoint it at something else, or
 * unlink/remove it. Mirrors NotePinPopover's shell (same ToolbarPopover, same
 * copy-with-checkmark pattern) but for the opposite direction of relationship - a link pointing
 * *away* from here, not a point other notes point *at*. */
export function LinkPopover({ href, anchorRef, notes, onOpen, onApplyEdit, onRemove, onClose }: LinkPopoverProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  if (editing) {
    return (
      <ToolbarPopover
        anchorRef={anchorRef}
        onClose={onClose}
        className="glass-panel shadow-app-lg border-subtle w-72 rounded-xl border p-3"
      >
        <NoteLinkQuickPicker
          notes={notes}
          onConfirm={onApplyEdit}
          onCancel={() => setEditing(false)}
          initialQuery={href}
          autoFocus
        />
      </ToolbarPopover>
    );
  }

  return (
    <ToolbarPopover
      anchorRef={anchorRef}
      onClose={onClose}
      className="glass-panel shadow-app-lg border-subtle w-auto rounded-xl border p-1"
    >
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          title="Open link"
          aria-label="Open link"
          className="btn-ghost flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        >
          <ArrowUpRight size={14} />
        </button>
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? "Copied" : "Copy link"}
          aria-label={copied ? "Copied" : "Copy link"}
          className="btn-ghost flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Edit link"
          aria-label="Edit link"
          className="btn-ghost flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            onRemove();
            onClose();
          }}
          title="Remove link"
          aria-label="Remove link"
          className="hover:bg-danger-soft text-danger flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        >
          <Unlink size={14} />
        </button>
      </div>
    </ToolbarPopover>
  );
}
