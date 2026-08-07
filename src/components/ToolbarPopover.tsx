import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Closes a popover when the user clicks anywhere outside all of `refs`. */
function useClickOutside(refs: React.RefObject<HTMLElement | null>[], onOutside: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    function handle(e: MouseEvent) {
      const target = e.target as Node;
      if (refs.some((r) => r.current?.contains(target))) return;
      onOutside();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [refs, onOutside, active]);
}

/** Toolbar popovers can't be plain `absolute` children of the toolbar: the
 * toolbar scrolls horizontally (`overflow-x-auto`), and per the CSS overflow
 * spec setting only one axis to `auto` forces the other to `auto` too - so
 * the toolbar clips anything positioned below its own height, leaving the
 * popover in the DOM (clickable via coordinates) but invisible. Portaling to
 * `document.body` with `position: fixed` escapes that clipping box.
 *
 * Shared by Editor.tsx's own toolbar dropdowns and SelectionLinkToolbar.tsx's Add Link/pin
 * popovers - anything anchored to a real DOM element (a button ref, or a ProseMirror NodeView's
 * own node - see notePinView.ts) rather than to arbitrary coordinates. */
export function ToolbarPopover({
  anchorRef,
  onClose,
  className,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed", visibility: "hidden" });

  useEffect(() => {
    function place() {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = menuRef.current?.offsetWidth ?? 0;
      const height = menuRef.current?.offsetHeight ?? 0;
      const left = Math.min(Math.max(rect.left, 8), window.innerWidth - width - 8);
      const fitsBelow = rect.bottom + 4 + height <= window.innerHeight - 8;
      const top = fitsBelow ? rect.bottom + 4 : Math.max(rect.top - height - 4, 8);
      setStyle({ position: "fixed", top, left, zIndex: 50 });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // The panel's own content can grow after first placement without any window resize/scroll -
    // e.g. VoiceNotePopover's "..." menu opening beneath the row it's anchored to - and `place()`
    // above only reacts to those two events. Without also re-running it when the panel's own
    // rendered height changes, `fitsBelow`'s flip-above-if-needed check stays stuck on the
    // pre-menu-opened height, so the popover doesn't notice it now overflows the viewport bottom
    // and the extra content renders off-screen.
    const resizeObserver = new ResizeObserver(place);
    if (menuRef.current) resizeObserver.observe(menuRef.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      resizeObserver.disconnect();
    };
  }, [anchorRef]);

  useClickOutside([anchorRef, menuRef], onClose, true);

  return createPortal(
    <div ref={menuRef} style={style} className={className}>
      {children}
    </div>,
    document.body,
  );
}
