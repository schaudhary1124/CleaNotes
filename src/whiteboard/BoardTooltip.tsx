import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Immediate tooltips for the board toolbar.
 *
 * The native `title` attribute waits a second or two before appearing, which is too slow to be the
 * label for a bar of unlabelled icon buttons - and unlabelled is the point: the options panel drops
 * its own text so it stays compact, which only works if the explanation is instant.
 *
 * One tooltip node for the whole toolbar, driven by whichever control the pointer is over, rather
 * than a portal per button - only one of them can be showing at a time, so the rest would be dead
 * weight on every render of the bar. */

interface Tip {
  label: string;
  anchor: HTMLElement;
}

type ShowTip = (label: string | null, anchor: HTMLElement | null) => void;

const TipContext = createContext<ShowTip>(() => {});

export function BoardTooltipHost({ children }: { children: React.ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  // Mirrors `tip` so `show` can bail on a repeat without depending on it - the pointer-move handler
  // below fires constantly and must not re-render per sample.
  const currentRef = useRef<Tip | null>(null);

  const show = useCallback<ShowTip>((label, anchor) => {
    const next = label && anchor ? { label, anchor } : null;
    const current = currentRef.current;
    if (next?.label === current?.label && next?.anchor === current?.anchor) return;
    currentRef.current = next;
    setTip(next);
  }, []);

  // A click or a keystroke can remove the very button being hovered (arming a tool swaps the whole
  // options panel), and a removed element never fires pointerleave - so the tooltip would hang
  // around pointing at nothing. Both events dismiss it; the next pointer move over a control brings
  // it back.
  useEffect(() => {
    if (!tip) return;
    const dismiss = () => show(null, null);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", dismiss, true);
    };
  }, [tip, show]);

  return (
    <TipContext.Provider value={show}>
      {children}
      {tip && <TipLabel label={tip.label} anchor={tip.anchor} />}
    </TipContext.Provider>
  );
}

/** Handlers to spread onto anything that wants an instant tooltip, in place of `title`.
 *
 * Deliberately *only* handlers - no `aria-label`. A tooltip is presentation; the accessible name is
 * set explicitly by each control, which also means these handlers can go on a wrapper element (the
 * way to keep a tooltip on a `disabled` button, which receives no pointer events of its own) without
 * inventing a second accessible name next to the real one. */
export function useTip() {
  const show = useContext(TipContext);
  return useCallback(
    (label: string) => ({
      onPointerEnter: (e: React.PointerEvent<HTMLElement>) => show(label, e.currentTarget),
      // Re-arms the tooltip after a click dismissed it, and covers a control that appeared under an
      // already-stationary cursor. Cheap: `show` ignores a repeat of what's already displayed.
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => show(label, e.currentTarget),
      onPointerLeave: () => show(null, null),
      onFocus: (e: React.FocusEvent<HTMLElement>) => show(label, e.currentTarget),
      onBlur: () => show(null, null),
    }),
    [show],
  );
}

function TipLabel({ label, anchor }: Tip) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  // Placed from the anchor's live box in a layout effect, so the first painted frame is already in
  // position - a tooltip that visibly slides into place defeats the point of showing it instantly.
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const width = ref.current?.offsetWidth ?? 0;
    const left = Math.min(Math.max(6, box.left + box.width / 2 - width / 2), window.innerWidth - width - 6);
    setStyle({ left, top: box.bottom + 6 });
  }, [anchor, label]);

  return createPortal(
    <div ref={ref} className="board-tip" role="tooltip" style={style}>
      {label}
    </div>,
    document.body,
  );
}
