interface IncomingShareRequestBannerProps {
  notePath: string;
  noteTitle: string;
  role: "viewer" | "editor";
  displayName: string;
  onDecision: (approved: boolean) => void;
}

/**
 * Global "X wants to join as Editor" approval prompt for an owner's pending invite - rendered
 * regardless of which note/dialog is currently open, since invites now live up to 24h and the
 * owner won't have ShareDialog open the whole time (see App.tsx's owner-invite supervisor,
 * which is what actually surfaces this).
 */
export function IncomingShareRequestBanner({ noteTitle, role, displayName, onDecision }: IncomingShareRequestBannerProps) {
  return (
    <div className="glass-surface shadow-app-lg animate-fade-in absolute right-6 top-14 z-50 w-80 rounded-xl p-3.5">
      <p className="text-primary text-sm">
        <span className="font-semibold">{displayName}</span> wants to join &quot;{noteTitle}&quot; as{" "}
        <span className="font-semibold">{role}</span>.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => onDecision(false)} className="btn-ghost h-8 rounded-lg px-3 text-sm">
          Deny
        </button>
        <button
          type="button"
          onClick={() => onDecision(true)}
          autoFocus
          className="bg-accent-solid h-8 rounded-lg px-3 text-sm font-medium text-white transition-colors duration-150 hover:brightness-110"
        >
          Allow
        </button>
      </div>
    </div>
  );
}
