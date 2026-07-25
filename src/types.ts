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

/** Which slice of the vault the sidebar's nav (All Notes/Starred/Recently Deleted) tells
 * Home's middle content to show - see App.tsx's `browseFilter` state. */
export type BrowseFilter = "all" | "starred" | "trash";

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

export interface AppSettings {
  theme: ThemeName;
  accent: string;
  background: BackgroundStyle;
  toolbarCollapsed: boolean;
  sidebarCollapsed: boolean;
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
