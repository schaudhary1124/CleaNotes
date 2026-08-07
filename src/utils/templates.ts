import { BookOpen, CalendarCheck, FileStack, FileText, Target, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NoteKind, NoteLook } from "../types";
import { STARTER_CONTENT } from "./fsNotes";

export interface NoteTemplate {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Which view/editor a note created from this template opens with - see NoteKind. */
  kind: NoteKind;
  /** Suggested default look for notes created from this template - the user can change it later.
   * Only meaningful for Milkdown-backed kinds (default/fixed-size). */
  look: NoteLook;
  buildContent(): string;
}

function todayLabel(): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Start with an empty note",
    icon: FileText,
    kind: "default",
    look: "plain",
    buildContent: () => STARTER_CONTENT,
  },
  {
    id: "lecture",
    label: "Lecture notes",
    description: "Topic, key points, and a summary",
    icon: BookOpen,
    kind: "default",
    look: "paper",
    buildContent: () => `## Topic\n\n## Key points\n\n## Questions to review\n\n## Summary\n`,
  },
  {
    id: "meeting",
    label: "Meeting notes",
    description: "Attendees, agenda, and action items",
    icon: Users,
    kind: "default",
    look: "plain",
    buildContent: () =>
      `## Attendees\n\n## Agenda\n\n## Discussion\n\n## Action items\n- [ ] Add action items here\n\n## Decisions\n`,
  },
  {
    id: "project-brief",
    label: "Project brief",
    description: "Objective, scope, and timeline",
    icon: Target,
    kind: "default",
    look: "plain",
    buildContent: () =>
      `## Objective\n\n## Scope\n\n## Stakeholders\n\n## Timeline\n\n## Risks\n`,
  },
  {
    id: "daily-review",
    label: "Daily review",
    description: "Wins, challenges, and tomorrow",
    icon: CalendarCheck,
    kind: "default",
    look: "paper",
    buildContent: () => `## ${todayLabel()}\n\n## Wins\n\n## Challenges\n\n## Tomorrow\n`,
  },
  {
    id: "fixed-size",
    label: "Fixed-size document",
    description: "Paginated, print-ready page layout",
    icon: FileStack,
    kind: "fixed-size",
    look: "plain",
    buildContent: () => STARTER_CONTENT,
  },
];

export function getTemplate(id: string): NoteTemplate {
  return NOTE_TEMPLATES.find((t) => t.id === id) ?? NOTE_TEMPLATES[0];
}
