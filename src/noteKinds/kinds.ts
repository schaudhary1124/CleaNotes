import type { NoteKind } from "../types";

/** Per-kind UI-capability facts, independent of which component actually renders a kind (see
 * registry.tsx for that) - lets call sites like App.tsx's Study-mode gating ask "does this kind
 * support X" without hardcoding a list of kinds themselves. */
export interface NoteKindDescriptor {
  id: NoteKind;
  label: string;
  /** Whether Study mode (flashcards/MCQs, see StudyView.tsx) applies to this kind at all - only
   * meaningful for kinds with prose content to quiz on. */
  supportsStudyMode: boolean;
}

export const NOTE_KINDS: Record<NoteKind, NoteKindDescriptor> = {
  default: { id: "default", label: "Note", supportsStudyMode: true },
  "fixed-size": { id: "fixed-size", label: "Fixed-size document", supportsStudyMode: true },
  code: { id: "code", label: "Code", supportsStudyMode: false },
  whiteboard: { id: "whiteboard", label: "Whiteboard", supportsStudyMode: false },
  spreadsheet: { id: "spreadsheet", label: "Spreadsheet", supportsStudyMode: false },
  calendar: { id: "calendar", label: "Calendar", supportsStudyMode: false },
};
