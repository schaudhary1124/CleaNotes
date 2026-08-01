import { useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, Pencil, UserX } from "lucide-react";
import { getAcl, getOrCreateAcl, grantCollaborator, revokeCollaborator } from "../collab/acl";
import { loadOrCreateIdentity, type DeviceIdentity } from "../collab/identity";
import { createInvite, serializeInvite, type InvitePayload } from "../collab/invite";
import { hostInvite, type HostHandle, type PairingDecision, type PairingRequest } from "../collab/signaling";
import type { CollabAcl, CollabRole } from "../types";

interface ShareDialogProps {
  notePath: string;
  noteTitle: string;
  onClose: () => void;
  /** Called after a grant or revoke succeeds, so the caller can re-check whether the note
   * should now be hosting (or stop hosting) a live session - see App.tsx's collabVersion. */
  onAclChanged?: () => void;
}

type IncomingRequest = PairingRequest & { resolve: (decision: PairingDecision) => void };

/**
 * Owner-side sharing UI for a single note - create a single-use invite, approve or deny each
 * redemption attempt inline, and manage/revoke people who already have access. See the collab
 * plan: this is Phase 1's "owner can see/approve/deny" surface, not yet wired to any live
 * document sync (that's Phase 2) - granting access here only sets up who's *allowed* to
 * collaborate once that exists.
 */
export function ShareDialog({ notePath, noteTitle, onClose, onAclChanged }: ShareDialogProps) {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [acl, setAcl] = useState<CollabAcl | null>(null);
  const [role, setRole] = useState<CollabRole>("viewer");
  const [pendingInvite, setPendingInvite] = useState<InvitePayload | null>(null);
  const [copied, setCopied] = useState(false);
  const [incomingRequest, setIncomingRequest] = useState<IncomingRequest | null>(null);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const hostHandleRef = useRef<HostHandle | null>(null);

  useEffect(() => {
    void loadOrCreateIdentity().then(setIdentity);
  }, []);

  useEffect(() => {
    // getAcl (not getOrCreateAcl) - just opening the dialog to look shouldn't create a
    // `.collab.json` sidecar for a note nobody has actually shared yet.
    let cancelled = false;
    void getAcl(notePath).then((result) => {
      if (!cancelled) setAcl(result);
    });
    return () => {
      cancelled = true;
    };
  }, [notePath]);

  useEffect(() => {
    return () => {
      hostHandleRef.current?.close();
    };
  }, []);

  async function handleCreateInvite() {
    if (!identity || creatingInvite) return;
    setCreatingInvite(true);
    try {
      const currentAcl = await getOrCreateAcl(notePath, identity.publicKeyHex);
      setAcl(currentAcl);
      setLastOutcome(null);

      const invite = createInvite(currentAcl.noteId, role, identity.publicKeyHex);
      setPendingInvite(invite);

      const handle = await hostInvite(invite, identity, (request) => {
        return new Promise<PairingDecision>((resolve) => {
          setIncomingRequest({ ...request, resolve });
        });
      });
      hostHandleRef.current = handle;
    } finally {
      setCreatingInvite(false);
    }
  }

  function handleCancelInvite() {
    hostHandleRef.current?.close();
    hostHandleRef.current = null;
    setPendingInvite(null);
  }

  async function handleDecision(approved: boolean) {
    if (!incomingRequest || !pendingInvite || !identity) return;
    const request = incomingRequest;
    setIncomingRequest(null);

    if (approved) {
      const next = await grantCollaborator(notePath, identity.publicKeyHex, {
        pubKey: request.guestPubKey,
        displayName: request.displayName,
        role: pendingInvite.role,
      });
      setAcl(next);
      setLastOutcome(`${request.displayName} now has ${pendingInvite.role} access.`);
      onAclChanged?.();
      request.resolve({ approved: true });
    } else {
      setLastOutcome(`Declined ${request.displayName}'s request.`);
      request.resolve({ approved: false, reason: "The owner declined this request." });
    }

    hostHandleRef.current = null;
    setPendingInvite(null);
  }

  async function handleRevoke(pubKey: string) {
    const next = await revokeCollaborator(notePath, pubKey);
    if (next) setAcl(next);
    onAclChanged?.();
  }

  async function handleRoleChange(pubKey: string, displayName: string, role: CollabRole) {
    if (!identity) return;
    const next = await grantCollaborator(notePath, identity.publicKeyHex, { pubKey, displayName, role });
    setAcl(next);
    onAclChanged?.();
  }

  async function handleCopy() {
    if (!pendingInvite) return;
    await navigator.clipboard.writeText(serializeInvite(pendingInvite));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const activeCollaborators = acl?.collaborators.filter((c) => c.status === "active") ?? [];

  return (
    <div
      className="animate-fade-in absolute inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/30 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass-surface shadow-app-lg w-full max-w-md rounded-2xl p-5 @max-sm:p-4">
        <p className="text-primary text-base font-semibold">Share &quot;{noteTitle}&quot;</p>
        <p className="text-secondary mt-1.5 text-sm leading-relaxed">
          Invite someone to view or edit this note. They'll only ever get access to this one note -
          nothing else in your vault.
        </p>

        {incomingRequest ? (
          <div className="border-subtle bg-surface-hover mt-4 rounded-xl border p-3.5">
            <p className="text-primary text-sm">
              <span className="font-semibold">{incomingRequest.displayName}</span> wants to join as{" "}
              <span className="font-semibold">{pendingInvite?.role}</span>.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleDecision(false)}
                className="btn-ghost h-8 rounded-lg px-3 text-sm"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => void handleDecision(true)}
                autoFocus
                className="bg-accent-solid h-8 rounded-lg px-3 text-sm font-medium text-white transition-colors duration-150 hover:brightness-110"
              >
                Allow
              </button>
            </div>
          </div>
        ) : pendingInvite ? (
          <div className="border-subtle bg-surface-hover mt-4 rounded-xl border p-3.5">
            <p className="text-secondary text-xs">
              Waiting for someone to open this link · expires {new Date(pendingInvite.expiresAt).toLocaleTimeString()}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={serializeInvite(pendingInvite)}
                onFocus={(e) => e.currentTarget.select()}
                className="border-subtle bg-surface text-secondary h-8 w-full truncate rounded-lg border px-2.5 text-xs"
              />
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="btn-ghost h-8 w-8 shrink-0"
                title="Copy invite link"
                aria-label="Copy invite link"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <button type="button" onClick={handleCancelInvite} className="text-tertiary mt-2 text-xs hover:underline">
              Cancel this invite
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <div className="flex gap-2">
              <RoleOption current={role} value="viewer" icon={<Eye size={13} />} label="Can view" onSelect={setRole} />
              <RoleOption current={role} value="editor" icon={<Pencil size={13} />} label="Can edit" onSelect={setRole} />
            </div>
            <button
              type="button"
              onClick={() => void handleCreateInvite()}
              disabled={!identity || creatingInvite}
              className="bg-accent-solid mt-3 h-9 w-full rounded-lg text-sm font-medium text-white transition-colors duration-150 hover:brightness-110 disabled:opacity-50"
            >
              {creatingInvite ? "Creating…" : "Create invite link"}
            </button>
          </div>
        )}

        {lastOutcome && <p className="text-secondary mt-3 text-xs">{lastOutcome}</p>}

        {activeCollaborators.length > 0 && (
          <div className="mt-5">
            <p className="text-tertiary text-xs font-semibold uppercase tracking-wide">Who has access</p>
            <div className="mt-2 flex flex-col gap-1">
              {activeCollaborators.map((c) => (
                <div key={c.pubKey} className="flex items-center gap-2 rounded-lg px-1 py-1">
                  <span className="text-primary flex-1 truncate text-sm">{c.displayName}</span>
                  <div className="border-subtle flex shrink-0 overflow-hidden rounded-lg border text-xs">
                    <button
                      type="button"
                      onClick={() => void handleRoleChange(c.pubKey, c.displayName, "viewer")}
                      aria-pressed={c.role === "viewer"}
                      title={`Give ${c.displayName} view-only access`}
                      className={`px-2 py-1 ${c.role === "viewer" ? "bg-accent-soft text-accent" : "text-secondary hover:bg-surface-hover"}`}
                    >
                      Viewer
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRoleChange(c.pubKey, c.displayName, "editor")}
                      aria-pressed={c.role === "editor"}
                      title={`Give ${c.displayName} edit access`}
                      className={`px-2 py-1 ${c.role === "editor" ? "bg-accent-soft text-accent" : "text-secondary hover:bg-surface-hover"}`}
                    >
                      Editor
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRevoke(c.pubKey)}
                    className="btn-ghost h-7 w-7 shrink-0 hover:bg-red-500/20 hover:text-red-500"
                    title={`Revoke ${c.displayName}'s access`}
                    aria-label={`Revoke ${c.displayName}'s access`}
                  >
                    <UserX size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="btn-ghost h-9 rounded-lg px-4 text-sm">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleOption({
  current,
  value,
  icon,
  label,
  onSelect,
}: {
  current: CollabRole;
  value: CollabRole;
  icon: React.ReactNode;
  label: string;
  onSelect: (role: CollabRole) => void;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={selected}
      className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-sm transition-colors duration-150 ${
        selected ? "border-accent bg-accent-soft text-accent" : "border-subtle text-secondary hover:bg-surface-hover"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
