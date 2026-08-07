import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { BrowserLinkError, type BrowserLinkPayload, parseBrowserLink, redeemBrowserPin } from "../collab/browserPairing";
import { loadOrCreateIdentity } from "../collab/browserIdentity";
import { maintainGuestSession, type ManagedGuestSession } from "../collab/guestSessionSupervisor";
import type { JoinedSession } from "../collab/yjsBridge";
import type { CollabRole } from "../types";
import { idbAssetStore } from "./idbAssetStore";
import { PinEntry } from "./PinEntry";
import { GUEST_KIND_VIEWS } from "./kindViews";

const DISPLAY_NAME_KEY = "cleanotes:browser-collab:display-name";

/** Whether this browser has already redeemed a PIN for this note, and what role it got - keyed
 * per noteId so returning to the same link later skips straight back to a live connection
 * instead of asking for the PIN again, exactly like a desktop collaborator's reconnect needs no
 * fresh invite. Self-correcting rather than a permanent trust flag: if the owner has since
 * revoked this device, the resulting SessionDeniedError (see guestSessionSupervisor's onDenied
 * below) clears this and falls back to the PIN screen - there's no way for a stale "yes I'm
 * paired" entry here to grant anything on its own, since the actual access check always happens
 * live on the owner's device. */
function rememberedRoleKey(noteId: string): string {
  return `cleanotes:browser-collab:role:${noteId}`;
}

function readRememberedRole(noteId: string): CollabRole | null {
  const value = localStorage.getItem(rememberedRoleKey(noteId));
  return value === "viewer" || value === "editor" ? value : null;
}

function parseLink(): { ok: true; payload: BrowserLinkPayload } | { ok: false; message: string } {
  try {
    return { ok: true, payload: parseBrowserLink(window.location.hash.slice(1)) };
  } catch (err) {
    return { ok: false, message: err instanceof BrowserLinkError ? err.message : "This link looks corrupted or incomplete." };
  }
}

/** The browser-guest build's entire app: parse the link, get (or ask for) access, then render
 * the live editor for exactly the one note the link points to. No vault, no note list, no
 * navigation - see the implementation plan's "scope it down hard" constraint. */
export function BrowserGuestApp() {
  const [link, setLink] = useState(parseLink);
  const [identity] = useState(loadOrCreateIdentity);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(DISPLAY_NAME_KEY) ?? "");

  // null = not yet granted (or no longer granted) - show PinEntry. Non-null drives the live
  // session effect below, mirroring how App.tsx's guestSessionsRef only ever supervises notes
  // with a real grant.
  const [role, setRole] = useState<CollabRole | null>(() => (link.ok ? readRememberedRole(link.payload.noteId) : null));
  const [pinError, setPinError] = useState<string | null>(null);
  const [submittingPin, setSubmittingPin] = useState(false);

  const [session, setSession] = useState<JoinedSession | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "offline">("connecting");
  const [canEdit, setCanEdit] = useState(true);
  const managedRef = useRef<ManagedGuestSession | null>(null);
  // Whether this role/link has ever actually reached "connected" - reset at the top of the
  // session effect below every time it starts a fresh attempt. Lets onStatusChange (in that same
  // effect) tell "this is the very first connect attempt failing" apart from "a live session
  // just dropped and is quietly retrying in the background" - only the former auto-falls-back to
  // PinEntry (see handleReenterPin's own comment for why a remembered role's first attempt so
  // often needs a fresh PIN redemption to actually re-grant access, not just a network retry).
  const hasConnectedRef = useRef(false);

  // Browsers don't reload the page (or re-run this component's mount-time state) for a
  // fragment-only navigation - the link's noteId/ownerPubKey live entirely in that fragment, so
  // without this, following a second browser-guest link in a tab that already has this page open
  // would silently keep showing the *first* note. Re-derives everything downstream of `link` the
  // same way the initial useState calls above did.
  useEffect(() => {
    function handleHashChange() {
      const next = parseLink();
      setLink(next);
      setRole(next.ok ? readRememberedRole(next.payload.noteId) : null);
      setPinError(null);
      setSession(null);
      setStatus("connecting");
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // One guest session for the page's lifetime, mounted the moment there's a role to connect
  // with (fresh grant or a remembered one) and torn down only on an actual denial or unmount -
  // never on some internal view change, since this page has none. This is exactly the lifecycle
  // App.tsx's own guestSessionSupervisor-based reconcile loop gives desktop guests too; sharing
  // maintainGuestSession is what makes that automatic here rather than something to re-derive.
  useEffect(() => {
    if (!link.ok || role === null) return;
    hasConnectedRef.current = false;
    setSession(null);
    setStatus("connecting");
    const managed = maintainGuestSession(
      { noteId: link.payload.noteId, ownerPubKey: link.payload.ownerPubKey, role, identity, displayName, assetStore: idbAssetStore },
      {
        onStatusChange: (next) => {
          if (next === "connected") {
            hasConnectedRef.current = true;
          } else if (next === "offline" && !hasConnectedRef.current) {
            // The very first attempt (remembered role, no PIN re-entered) failed outright,
            // rather than a live session dropping and retrying - in practice this almost always
            // means the remembered grant itself needs refreshing (see handleReenterPin's own
            // comment), not a transient network hiccup that a silent background retry would
            // eventually recover from on its own. Skip the "waiting for owner" screen and its
            // manual escape hatch entirely; go straight back to PinEntry.
            handleReenterPin("Couldn't reconnect automatically - enter the PIN again.");
            return;
          }
          setStatus(next);
        },
        onSessionChange: setSession,
        onCanEditChange: setCanEdit,
        onDenied: () => handleReenterPin("Your access was removed. Enter the PIN again to reconnect."),
      },
    );
    managedRef.current = managed;
    return () => {
      managed.stop();
      managedRef.current = null;
    };
    // identity/displayName are fixed for the page's lifetime by the time role can ever become
    // non-null (displayName is only set once, right before the redeem that produces the role
    // that triggers this effect). role and link are the real triggers: role flips pin-entry ->
    // granted or granted -> pin-entry (on denial), and link only ever changes via the
    // hashchange handler above (which also resets role), so together they still only ever
    // re-run this for an actual note/grant change, never flapping mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, link]);

  // Escape hatch for a guest stuck retrying forever: a remembered role only ever gets cleared
  // automatically on an explicit "denied" from the owner's device (see onDenied above) - but if
  // this note currently has no active collaborators at all (e.g. access lapsed, or the PIN was
  // regenerated since this device last redeemed it), nothing is hosting a session to deny
  // anything, so joinSession just times out silently forever with no way back to PinEntry on its
  // own. Also fired automatically (see the session effect's onStatusChange above) the moment a
  // remembered role's very first connect attempt fails, rather than waiting for a manual click -
  // in practice that first-attempt failure almost always means this device's grant itself needs
  // refreshing (redeeming the PIN again is what actually re-adds it as an active collaborator on
  // the owner's side - see acl.ts's grantCollaborator), not something a silent retry would fix.
  function handleReenterPin(message?: string) {
    if (link.ok) localStorage.removeItem(rememberedRoleKey(link.payload.noteId));
    setSession(null);
    setPinError(message ?? null);
    setRole(null);
  }

  async function handleSubmitPin(pin: string, name: string) {
    if (!link.ok || submittingPin) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setPinError("Enter a name so the note's owner can see who's connected.");
      return;
    }
    localStorage.setItem(DISPLAY_NAME_KEY, trimmedName);
    setDisplayName(trimmedName);
    setSubmittingPin(true);
    setPinError(null);
    try {
      const result = await redeemBrowserPin(link.payload.noteId, link.payload.ownerPubKey, pin, identity, trimmedName);
      if (result.status === "granted") {
        localStorage.setItem(rememberedRoleKey(link.payload.noteId), result.role);
        setRole(result.role);
      } else if (result.status === "denied") {
        setPinError(result.reason ?? "That PIN was declined.");
      } else {
        setPinError("That PIN doesn't look right, or the owner isn't online right now - try again.");
      }
    } finally {
      setSubmittingPin(false);
    }
  }

  return (
    <div className="h-screen w-screen">
      <div className="app-shell @container flex h-full w-full flex-col overflow-hidden">
        {!link.ok ? (
          <CenteredMessage title="This link looks broken" body={link.message} />
        ) : role === null ? (
          <PinEntry
            displayName={displayName}
            error={pinError}
            submitting={submittingPin}
            onSubmit={(pin, name) => void handleSubmitPin(pin, name)}
          />
        ) : status === "connected" && session ? (
          (() => {
            const KindView = GUEST_KIND_VIEWS[session.kind];
            if (!KindView) {
              return (
                <CenteredMessage
                  title="Not supported here yet"
                  body="This note type isn't supported in the browser yet - open it in the CleaNotes desktop app instead."
                />
              );
            }
            // Keyed on session.generation so a resync (owner restarted hosting without this
            // connection ever dropping - see yjsBridge.ts's JoinedSession.generation) remounts
            // the view bound to the fresh shared/awareness, instead of an already-mounted
            // instance going stale against objects that no longer receive updates.
            return <KindView key={session.generation} session={session} canEdit={canEdit} noteId={link.payload.noteId} />;
          })()
        ) : (
          <CenteredMessage
            title={status === "connecting" ? "Connecting…" : "Waiting for the owner to be online"}
            body={
              status === "connecting"
                ? "Reaching this note's owner."
                : "This note only syncs while its owner's CleaNotes app is open. You'll connect automatically the moment they're back online."
            }
            spinner={status === "connecting"}
            onReenterPin={status === "offline" ? () => handleReenterPin() : undefined}
          />
        )}
      </div>
    </div>
  );
}

function CenteredMessage({
  title,
  body,
  spinner,
  onReenterPin,
}: {
  title: string;
  body: string;
  spinner?: boolean;
  /** Shown as a small secondary action beneath `body` when set - see handleReenterPin's own
   * comment for why this only ever appears once a connection attempt has actually gone
   * "offline", not on the very first "connecting" pass. */
  onReenterPin?: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      {spinner && <Loader2 size={22} className="text-tertiary animate-spin" />}
      <p className="text-primary text-base font-semibold">{title}</p>
      <p className="text-secondary max-w-xs text-sm leading-relaxed">{body}</p>
      {onReenterPin && (
        <button type="button" onClick={onReenterPin} className="btn-ghost mt-1 h-8 rounded-lg px-3 text-xs">
          Not connecting? Enter the PIN again
        </button>
      )}
    </div>
  );
}
