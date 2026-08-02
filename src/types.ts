export interface NoteSummary {
  /** Path relative to the notes root, including the .md extension, e.g. "Work/Todo.md" */
  path: string;
  /** Display title, derived from the file name without its extension */
  title: string;
  /** Path of the containing folder relative to the notes root, "" for the root */
  parentPath: string;
  /** Epoch ms when the note was created, if known */
  createdAt?: number;
  /** Epoch ms when the note was last modified, if known */
  modifiedAt?: number;
  /** Whether this note is in the user's Starred list - see fsNotes.ts's `starred` meta entry. */
  starred?: boolean;
  /** Whether this note has any flashcards/MCQs - see NoteEntry's field of the same name. */
  hasStudyItems?: boolean;
}

export interface FolderEntry {
  type: "folder";
  /** Path relative to the notes root, e.g. "Work" or "Work/Archive" */
  path: string;
  title: string;
  parentPath: string;
  children: TreeEntry[];
  /** Name of a preset color from FOLDER_COLORS, or undefined for the default color */
  color?: string;
  /** Epoch ms when the folder was created, if known */
  createdAt?: number;
  /** Epoch ms when the folder was last modified (a direct child added/removed/renamed), if known */
  modifiedAt?: number;
}

export interface NoteEntry {
  type: "note";
  path: string;
  title: string;
  parentPath: string;
  /** Epoch ms when the note was created, if known */
  createdAt?: number;
  /** Epoch ms when the note was last modified, if known */
  modifiedAt?: number;
  /** Whether this note is in the user's Starred list - see fsNotes.ts's `starred` meta entry. */
  starred?: boolean;
  /** Whether this note has any flashcards/MCQs - cheaply derived during buildTree
   * from the directory listing, not a count (see fsNotes.ts). */
  hasStudyItems?: boolean;
}

export type TreeEntry = FolderEntry | NoteEntry;

/** Which slice of the vault the sidebar's nav (All Notes/Starred/Recently Deleted/Shared Notes)
 * tells Home's middle content to show - see App.tsx's `browseFilter` state. */
export type BrowseFilter = "all" | "starred" | "trash" | "shared";

export type AppMode = "edit" | "study";

export interface Flashcard {
  kind: "flashcard";
  id: string;
  question: string;
  answer: string;
  /** Optional explanation shown alongside the answer, e.g. why it's correct. */
  reason?: string;
}

export interface MultipleChoice {
  kind: "mcq";
  id: string;
  question: string;
  options: string[];
  answer: string;
  /** Index of `answer` within `options` */
  answerIndex: number;
  /** Optional explanation shown after answering, e.g. why it's correct. */
  reason?: string;
}

export type StudyItem = Flashcard | MultipleChoice;

export type ThemeName = "light" | "midnight";
export type BackgroundStyle = "flat" | "soft" | "glass";

/** Per-note visual skin, independent of the note's content - see fsNotes.ts's
 * `noteLooks` meta entry for persistence. */
export type NoteLook = "plain" | "paper" | "grid" | "index-card";

/** Per-feature on/off switches - see SettingsPanel.tsx's "Features" section. Disabling a
 * feature hides the ways to create/reach it elsewhere in the app; it never touches content a
 * note already has (e.g. disabling codeBlock still lets existing code blocks render/edit). */
export interface FeatureFlags {
  calendar: boolean;
  sketch: boolean;
  studyMode: boolean;
  codeBlock: boolean;
  keepOnTop: boolean;
  voiceNotes: boolean;
}

export interface AppSettings {
  theme: ThemeName;
  accent: string;
  background: BackgroundStyle;
  toolbarCollapsed: boolean;
  sidebarCollapsed: boolean;
  /** Whether this window is pinned above other windows - see Header.tsx's Pin button, which
   * both reads and toggles this (lifted out of Header's own local state so it's also settable/
   * persisted from Settings). */
  alwaysOnTop: boolean;
  features: FeatureFlags;
}

export type SketchTool = "pen" | "highlighter" | "eraser";

/** A single ink point, in CSS pixels relative to the note content's top-left
 * corner (see SketchLayer) - not a coordinate space that scales with the
 * note's width. */
export interface SketchPoint {
  x: number;
  y: number;
}

export interface SketchStroke {
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  /** Line width in CSS pixels. */
  width: number;
  points: SketchPoint[];
}

export interface SketchData {
  version: 1;
  strokes: SketchStroke[];
}

/** Whether a collaborator can only view a shared note, or also edit it - enforced by the
 * owner's session code (see src/collab/), never trusted from a client's own claim. */
export type CollabRole = "viewer" | "editor";

/** One person the owner has granted access to a note - see fsNotes.ts's `.collab.json`
 * sidecar and CollabAcl below. */
export interface Collaborator {
  /** Hex-encoded Ed25519 public key identifying this collaborator's device - see
   * src/collab/identity.ts. The actual root of trust; displayName is cosmetic only. */
  pubKey: string;
  displayName: string;
  role: CollabRole;
  /** Epoch ms when the owner approved this collaborator's first pairing request. */
  grantedAt: number;
  /** Epoch ms this collaborator was last connected, if ever. */
  lastSeenAt?: number;
  /** Revoked entries are kept (not deleted) so the owner has a durable audit trail of who
   * has ever had access - see fsNotes.ts's readCollabAcl/writeCollabAcl. */
  status: "active" | "revoked";
  /** How this collaborator was granted - informational only (mirrors the "client-side UX
   * only" pattern used elsewhere in this file), so ShareDialog can label browser guests
   * distinctly. Undefined for entries granted before this field existed - treat as "invite". */
  origin?: "invite" | "browser-pin";
}

/** A note's standing browser-access PIN - see src/collab/browserPairing.ts. Unlike an invite
 * (single-use, one specific device vetted by the owner), this is a re-enterable entry gate:
 * every browser identity that submits the correct PIN is auto-granted `role` as its own
 * Collaborator entry (see acl.ts's setBrowserPin/grantCollaborator). The PIN itself is not the
 * security boundary on its own - see browserPairing.ts's room-derivation comment - and is not
 * the collaborator's identity either: the owner can still revoke one browser guest individually
 * without this PIN needing to change. */
export interface BrowserPinState {
  /** Current PIN. Regenerating replaces this value, which changes the pairing room it derives
   * (see browserPairing.ts) - already-granted collaborators are unaffected, only future
   * redemptions of the *old* PIN stop working. */
  pin: string;
  /** Role granted to anyone who redeems this PIN. */
  role: CollabRole;
  createdAt: number;
}

/** A note's sharing state - see fsNotes.ts's `.collab.json` sidecar, parallel to SketchData's
 * `.sketch.json`. Only exists for notes that have been shared at least once. */
export interface CollabAcl {
  version: 1;
  /** Stable id for this note's collaboration session/CRDT document, independent of its
   * current filesystem path. The sidecar file itself still travels with the note on
   * rename/move like SketchData's does (see fsNotes.ts's relocateCollab), so this doesn't
   * need to be re-derived on every rename - it just avoids ever tying session/room identity
   * directly to a mutable path string. */
  noteId: string;
  /** Hex-encoded Ed25519 public key of this note's owner, i.e. this device - ownership is
   * intrinsic (whoever's vault the note lives in), never assigned by a server. */
  ownerPubKey: string;
  /** When true, every collaborator is temporarily read-only regardless of role - the
   * "instant lock" security feature, reversible, independent of revoking anyone. */
  locked: boolean;
  collaborators: Collaborator[];
  /** Standing browser-access PIN, if the owner has enabled it for this note - null/undefined
   * means browser access is off. See BrowserPinState and src/collab/browserPairing.ts. */
  browserPin?: BrowserPinState | null;
}

/** An invite this device (as owner) has created and is waiting on someone to redeem - see
 * src/collab/sharedNotesStore.ts. Persisted (unlike the invite's own in-memory InvitePayload)
 * so the pairing listener can survive the Share dialog closing, the owner switching notes, or
 * even the app restarting, for the invite's full lifetime. */
export interface OwnerPendingInvite {
  notePath: string;
  noteId: string;
  role: CollabRole;
  secret: string;
  createdAt: number;
  expiresAt: number;
}

/** Status of a note this device (as guest) has tried to join - see GuestJoinedNote. */
export type GuestNoteStatus = "pending" | "active" | "denied" | "expired";

/** One note this device (as guest) has redeemed an invite for, tracked from the moment the
 * invite link is submitted (not just after the owner grants access) so a pending request
 * survives closing the Join dialog - see src/collab/sharedNotesStore.ts. */
export interface GuestJoinedNote {
  noteId: string;
  ownerPubKey: string;
  role: CollabRole;
  secret: string;
  displayName: string;
  status: GuestNoteStatus;
  /** Filled in once the first live sync reveals the note's actual title - the invite itself
   * deliberately never carries it (see invite.ts's structural-isolation principle). */
  title?: string;
  createdAt: number;
  expiresAt: number;
  deniedReason?: string;
}
