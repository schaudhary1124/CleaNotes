import { useState, type FormEvent } from "react";

interface PinEntryProps {
  /** Remembered from a previous visit, if any - see App.tsx's DISPLAY_NAME_KEY. */
  displayName: string;
  error: string | null;
  submitting: boolean;
  onSubmit: (pin: string, displayName: string) => void;
}

const PIN_LENGTH = 6;

/** The browser-guest build's only "sign-in" surface: a name and the PIN the note's owner shared
 * separately from the link (see browserPairing.ts's module comment for why the two are kept
 * apart). No account, no password - this is the entire access flow. */
export function PinEntry({ displayName: initialDisplayName, error, submitting, onSubmit }: PinEntryProps) {
  const [pin, setPin] = useState("");
  const [name, setName] = useState(initialDisplayName);

  const canSubmit = pin.length === PIN_LENGTH && name.trim().length > 0 && !submitting;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(pin, name);
  }

  return (
    <div className="flex h-full w-full items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="glass-surface shadow-app-lg w-full max-w-sm rounded-2xl p-6">
        <p className="text-primary text-lg font-semibold">Join this note</p>
        <p className="text-secondary mt-1.5 text-sm leading-relaxed">
          Enter your name and the PIN the note's owner shared with you. This note only syncs
          while the owner's CleaNotes app is open - you'll connect automatically once it is.
        </p>

        <label className="text-tertiary mt-4 block text-xs font-semibold uppercase tracking-wide" htmlFor="browser-guest-name">
          Your name
        </label>
        <input
          id="browser-guest-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoComplete="name"
          className="border-subtle bg-surface-hover text-primary mt-1 h-9 w-full rounded-lg border px-3 text-sm focus:outline-none"
        />

        <label className="text-tertiary mt-3 block text-xs font-semibold uppercase tracking-wide" htmlFor="browser-guest-pin">
          PIN
        </label>
        <input
          id="browser-guest-pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH))}
          placeholder="123456"
          inputMode="numeric"
          autoComplete="off"
          className="border-subtle bg-surface-hover text-primary mt-1 h-11 w-full rounded-lg border px-3 text-center font-mono text-xl tracking-[0.3em] focus:outline-none"
        />

        {error && <p className="mt-3 text-xs leading-relaxed text-red-500">{error}</p>}

        <button
          type="submit"
          disabled={!canSubmit}
          className="bg-accent-solid mt-4 h-9 w-full rounded-lg text-sm font-medium text-white transition-colors duration-150 hover:brightness-110 disabled:opacity-50"
        >
          {submitting ? "Joining…" : "Join"}
        </button>
      </form>
    </div>
  );
}
