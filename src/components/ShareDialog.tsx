import { useEffect, useState } from "react";
import { Check, Copy, Eye, Globe, Pencil, UserX } from "lucide-react";
import { clearBrowserPin, getAcl, getOrCreateAcl, grantCollaborator, revokeCollaborator, setBrowserPin } from "../collab/acl";
import { loadOrCreateIdentity, type DeviceIdentity } from "../collab/identity";
import { createInvite, serializeInvite, type InvitePayload } from "../collab/invite";
import { buildBrowserLink, generateBrowserPin } from "../collab/browserPairing";
import { upsertOwnerInvite, removeOwnerInvite } from "../collab/sharedNotesStore";
import type { CollabAcl, CollabRole, OwnerPendingInvite } from "../types";

interface ShareDialogProps {
  notePath: string;
  noteTitle: string;
  /** This device's own pending invite for this note, if any - lifted to App.tsx so the actual
   * pairing listener survives this dialog closing (see App.tsx's owner-invite supervisor). */
  pendingInvite: OwnerPendingInvite | null;
  onClose: () => void;
  /** Called after a grant/revoke, or creating/cancelling an invite, so the caller can re-derive
   * hosting/listening state - see App.tsx's collabVersion. */
  onAclChanged?: () => void;
}

/**
 * Owner-side sharing UI for a single note - create a single-use invite and manage/revoke people
 * who already have access. Approving or denying an incoming redemption attempt now happens via
 * the global IncomingShareRequestBanner (see App.tsx) rather than inline here, since an invite
 * can be redeemed up to 24h later, long after this dialog might be closed.
 */
export function ShareDialog({ notePath, noteTitle, pendingInvite, onClose, onAclChanged }: ShareDialogProps) {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [acl, setAcl] = useState<CollabAcl | null>(null);
  const [role, setRole] = useState<CollabRole>("viewer");
  const [copied, setCopied] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  // Separate from the invite link's `role` above - browser access is a weaker gate (a short PIN,
  // not a device-bound secret), defaulted to the lower-privilege option rather than mirroring
  // whatever the invite role happens to be set to.
  const [browserRole, setBrowserRole] = useState<CollabRole>("viewer");
  const [pinCopied, setPinCopied] = useState(false);
  const [browserLinkCopied, setBrowserLinkCopied] = useState(false);
  const [updatingBrowserAccess, setUpdatingBrowserAccess] = useState(false);

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
  }, [notePath, pendingInvite]);

  async function handleCreateInvite() {
    if (!identity || creatingInvite) return;
    setCreatingInvite(true);
    try {
      const currentAcl = await getOrCreateAcl(notePath, identity.publicKeyHex);
      setAcl(currentAcl);

      const invite = createInvite(currentAcl.noteId, role, identity.publicKeyHex);
      upsertOwnerInvite({
        notePath,
        noteId: invite.noteId,
        role: invite.role,
        secret: invite.secret,
        createdAt: Date.now(),
        expiresAt: invite.expiresAt,
      });
      onAclChanged?.();
    } finally {
      setCreatingInvite(false);
    }
  }

  function handleCancelInvite() {
    if (!pendingInvite) return;
    removeOwnerInvite(pendingInvite.secret);
    onAclChanged?.();
  }

  const invitePayload: InvitePayload | null =
    pendingInvite && identity
      ? {
          v: 1,
          noteId: pendingInvite.noteId,
          role: pendingInvite.role,
          secret: pendingInvite.secret,
          ownerPubKey: identity.publicKeyHex,
          expiresAt: pendingInvite.expiresAt,
        }
      : null;

  const browserLink =
    acl?.browserPin && identity ? buildBrowserLink({ noteId: acl.noteId, ownerPubKey: identity.publicKeyHex }) : null;

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
    if (!invitePayload) return;
    await navigator.clipboard.writeText(serializeInvite(invitePayload));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleEnableBrowserAccess() {
    if (!identity || updatingBrowserAccess) return;
    setUpdatingBrowserAccess(true);
    try {
      const next = await setBrowserPin(notePath, identity.publicKeyHex, generateBrowserPin(), browserRole);
      setAcl(next);
      onAclChanged?.();
    } finally {
      setUpdatingBrowserAccess(false);
    }
  }

  async function handleRegenerateBrowserPin() {
    if (!identity || !acl?.browserPin || updatingBrowserAccess) return;
    setUpdatingBrowserAccess(true);
    try {
      const next = await setBrowserPin(notePath, identity.publicKeyHex, generateBrowserPin(), acl.browserPin.role);
      setAcl(next);
      onAclChanged?.();
    } finally {
      setUpdatingBrowserAccess(false);
    }
  }

  async function handleBrowserRoleChange(nextRole: CollabRole) {
    if (!identity || !acl?.browserPin || updatingBrowserAccess) return;
    setUpdatingBrowserAccess(true);
    try {
      const next = await setBrowserPin(notePath, identity.publicKeyHex, acl.browserPin.pin, nextRole);
      setAcl(next);
      onAclChanged?.();
    } finally {
      setUpdatingBrowserAccess(false);
    }
  }

  async function handleDisableBrowserAccess() {
    const next = await clearBrowserPin(notePath);
    if (next) setAcl(next);
    onAclChanged?.();
  }

  async function handleCopyPin() {
    if (!acl?.browserPin) return;
    await navigator.clipboard.writeText(acl.browserPin.pin);
    setPinCopied(true);
    setTimeout(() => setPinCopied(false), 2000);
  }

  async function handleCopyBrowserLink() {
    if (!browserLink) return;
    await navigator.clipboard.writeText(browserLink);
    setBrowserLinkCopied(true);
    setTimeout(() => setBrowserLinkCopied(false), 2000);
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

        {pendingInvite && invitePayload ? (
          <div className="border-subtle bg-surface-hover mt-4 rounded-xl border p-3.5">
            <p className="text-secondary text-xs">
              Waiting for someone to open this link · expires{" "}
              {new Date(pendingInvite.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={serializeInvite(invitePayload)}
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

        <div className="border-subtle mt-5 border-t pt-4">
          <p className="text-primary text-sm font-semibold">Browser access</p>
          <p className="text-secondary mt-1.5 text-xs leading-relaxed">
            Anyone with the link and this PIN can join from their browser - no install needed.
            They'll only ever get access to this one note.
          </p>

          {!acl?.browserPin ? (
            <div className="mt-3">
              <div className="flex gap-2">
                <RoleOption current={browserRole} value="viewer" icon={<Eye size={13} />} label="Can view" onSelect={setBrowserRole} />
                <RoleOption current={browserRole} value="editor" icon={<Pencil size={13} />} label="Can edit" onSelect={setBrowserRole} />
              </div>
              <button
                type="button"
                onClick={() => void handleEnableBrowserAccess()}
                disabled={!identity || updatingBrowserAccess}
                className="border-subtle text-secondary mt-3 h-9 w-full rounded-lg border text-sm font-medium transition-colors duration-150 hover:bg-surface-hover disabled:opacity-50"
              >
                {updatingBrowserAccess ? "Enabling…" : "Enable browser access"}
              </button>
            </div>
          ) : (
            <div className="border-subtle bg-surface-hover mt-3 rounded-xl border p-3.5">
              <p className="text-tertiary text-center text-[10px] font-semibold uppercase tracking-wide">PIN</p>
              <div className="mt-1 flex items-center justify-center gap-2">
                <p className="text-primary font-mono text-2xl font-bold tracking-[0.2em]">
                  {acl.browserPin.pin.slice(0, 3)} {acl.browserPin.pin.slice(3)}
                </p>
                <button
                  type="button"
                  onClick={() => void handleCopyPin()}
                  className="btn-ghost h-7 w-7 shrink-0"
                  title="Copy PIN"
                  aria-label="Copy PIN"
                >
                  {pinCopied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <input
                  readOnly
                  value={browserLink ?? ""}
                  onFocus={(e) => e.currentTarget.select()}
                  className="border-subtle bg-surface text-secondary h-8 w-full truncate rounded-lg border px-2.5 text-xs"
                />
                <button
                  type="button"
                  onClick={() => void handleCopyBrowserLink()}
                  className="btn-ghost h-8 w-8 shrink-0"
                  title="Copy link"
                  aria-label="Copy link"
                >
                  {browserLinkCopied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>

              <div className="mt-3 flex gap-2">
                <RoleOption
                  current={acl.browserPin.role}
                  value="viewer"
                  icon={<Eye size={13} />}
                  label="Can view"
                  onSelect={(r) => void handleBrowserRoleChange(r)}
                />
                <RoleOption
                  current={acl.browserPin.role}
                  value="editor"
                  icon={<Pencil size={13} />}
                  label="Can edit"
                  onSelect={(r) => void handleBrowserRoleChange(r)}
                />
              </div>

              <p className="text-tertiary mt-3 text-xs leading-relaxed">
                This device has to be online for a browser guest to sync, same as any other
                collaborator. Regenerating stops new sign-ins with the old PIN without affecting
                anyone already connected.
              </p>

              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleRegenerateBrowserPin()}
                  disabled={updatingBrowserAccess}
                  className="text-tertiary text-xs hover:underline disabled:opacity-50"
                >
                  Regenerate PIN
                </button>
                <button type="button" onClick={() => void handleDisableBrowserAccess()} className="text-tertiary text-xs hover:underline">
                  Turn off browser access
                </button>
              </div>
            </div>
          )}
        </div>

        {activeCollaborators.length > 0 && (
          <div className="mt-5">
            <p className="text-tertiary text-xs font-semibold uppercase tracking-wide">Who has access</p>
            <div className="mt-2 flex flex-col gap-1">
              {activeCollaborators.map((c) => (
                <div key={c.pubKey} className="flex items-center gap-2 rounded-lg px-1 py-1">
                  <span className="text-primary flex-1 truncate text-sm">{c.displayName}</span>
                  {c.origin === "browser-pin" && (
                    <Globe size={12} className="text-tertiary shrink-0" aria-label="Joined from a browser" />
                  )}
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
