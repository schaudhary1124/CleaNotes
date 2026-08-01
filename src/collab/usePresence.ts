import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";

export interface PresenceEntry {
  clientId: number;
  name: string;
  color: string;
}

/** Reactively lists everyone currently visible in `awareness`'s shared state - every connected
 * collaborator (owner included, from a guest's point of view), excluding this device's own
 * local entry. Used to render "who's here" avatars in Header.tsx/JoinSharedNoteDialog.tsx.
 * Returns [] whenever there's no active session (awareness undefined). */
export function usePresence(awareness: Awareness | undefined): PresenceEntry[] {
  const [entries, setEntries] = useState<PresenceEntry[]>([]);

  useEffect(() => {
    if (!awareness) {
      setEntries([]);
      return;
    }

    function readEntries() {
      const next: PresenceEntry[] = [];
      awareness!.getStates().forEach((state, clientId) => {
        if (clientId === awareness!.clientID) return; // this device's own entry - not "someone else present"
        const user = state.user as { name?: string; color?: string } | undefined;
        if (user?.name && user?.color) next.push({ clientId, name: user.name, color: user.color });
      });
      setEntries(next);
    }

    readEntries();
    awareness.on("change", readEntries);
    return () => {
      awareness.off("change", readEntries);
    };
  }, [awareness]);

  return entries;
}
