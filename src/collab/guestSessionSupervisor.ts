import { joinSession, SessionDeniedError, type JoinedSession } from "./yjsBridge";
import type { DeviceIdentity } from "./identity";
import type { CollabRole } from "../types";

/**
 * Owns exactly one guest-side `joinSession` connection for a note, plus its reconnect-on-drop
 * lifecycle - extracted out of App.tsx so it can be driven identically by a supervisor that
 * keeps every active guest note connected in the background (App.tsx's reconcileGuestSessions,
 * mirroring the owner side's reconcileHostedSessions/hostedSharedSessionsRef) and by the
 * browser-guest build, which only ever has one note and mounts this exactly once for the page's
 * lifetime. Framework-agnostic on purpose - no React here - so neither caller can accidentally
 * re-derive a connection's lifecycle from render-scoped state the way App.tsx's guest session
 * used to (tied to `view`, tearing down and fully renegotiating - fresh TURN allocation, fresh
 * ICE, fresh DTLS, a full-doc resync - every time the note view closed and reopened).
 */

const BASE_RETRY_MS = 10_000;
const MAX_RETRY_MS = 120_000;

export interface ManagedGuestSessionParams {
  noteId: string;
  ownerPubKey: string;
  role: CollabRole;
  identity: DeviceIdentity;
  displayName: string;
}

export interface ManagedGuestSessionCallbacks {
  onStatusChange: (status: "connecting" | "connected" | "offline") => void;
  onSessionChange: (session: JoinedSession | null) => void;
  onCanEditChange: (canEdit: boolean) => void;
  /** The owner explicitly ended access (revoked, or this device was never actually granted) -
   * final, not retried. The caller should stop supervising this note (see SessionDeniedError's
   * own doc comment in yjsBridge.ts). */
  onDenied: (reason?: string) => void;
  /** The owner's real, filename-derived title arrived (or changed) - see JoinedSession.title's
   * own comment. Callers that persist a title (e.g. the guest notes store) can react to this;
   * the supervisor itself doesn't know or care whether it's actually new. */
  onTitleResolved?: (title: string) => void;
}

export interface ManagedGuestSession {
  /** Disconnects and stops all future reconnect attempts - call when the note is no longer an
   * active guest note (revoked, left) or the owning component unmounts. */
  stop(): void;
}

/** Guest side: connects to a note's live session and keeps reconnecting (exponential backoff,
 * 10s up to a 2min cap) across drops that aren't a deliberate revoke - "the owner isn't
 * currently hosting" (they closed the note/quit the app) is exactly as retryable as a transient
 * signaling hiccup, since they may resume hosting at any time. */
export function maintainGuestSession(
  params: ManagedGuestSessionParams,
  callbacks: ManagedGuestSessionCallbacks,
): ManagedGuestSession {
  let stopped = false;
  let session: JoinedSession | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  function scheduleRetry() {
    if (stopped) return;
    callbacks.onStatusChange("offline");
    const delay = Math.min(BASE_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    callbacks.onStatusChange("connecting");
    joinSession(params.noteId, params.ownerPubKey, params.role, params.identity, params.displayName, {
      onCanEditChanged: callbacks.onCanEditChange,
      onEnded: (reason) => {
        session = null;
        callbacks.onSessionChange(null);
        if (reason === "revoked") {
          callbacks.onDenied();
        } else {
          scheduleRetry();
        }
      },
    })
      .then((started) => {
        if (stopped) {
          started.close();
          return;
        }
        attempt = 0;
        session = started;
        callbacks.onSessionChange(started);
        callbacks.onStatusChange("connected");
        callbacks.onCanEditChange(started.canEdit);
        if (started.title) callbacks.onTitleResolved?.(started.title);
      })
      .catch((err: unknown) => {
        if (stopped) return;
        if (err instanceof SessionDeniedError) {
          callbacks.onDenied(err.message);
          return;
        }
        scheduleRetry();
      });
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      session?.close();
      session = null;
    },
  };
}
