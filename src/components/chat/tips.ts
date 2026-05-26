/**
 * Rotating placeholder tips for the input box.
 *
 * Each tip is a short imperative sentence that hints at a capability the user
 * may not know about. Picked at random on mount and rotated every N seconds
 * so the same tip doesn't pin to one tab forever.
 *
 * Tips deliberately avoid technical jargon and slash-command syntax in the
 * sentence itself — the key hint goes after the `·` separator so the user
 * sees the action first, the keybind second.
 */

export interface Tip {
  /** Sentence shown in the placeholder slot. */
  text: string;
  /** Optional trailing hint ("Ctrl+K", "/help"). Rendered dim. */
  hint?: string;
}

export const TIPS: readonly Tip[] = [
  { text: "speak to the forge..." },
  { text: "ask anything — code, debug, refactor, explain", hint: "Enter to send" },
  { text: "open the command palette", hint: "Ctrl+K" },
  { text: "switch model on the fly", hint: "Ctrl+L" },
  { text: "new tab for a parallel task", hint: "Ctrl+T" },
  { text: "browse session history", hint: "Ctrl+P" },
  { text: "stash this draft for later", hint: "Alt+S" },
  { text: "pop your last stashed draft", hint: "Alt+P" },
  { text: "type / to search slash commands" },
  { text: "press up arrow to recall a previous prompt" },
  { text: "git menu at your fingertips", hint: "Ctrl+G" },
  { text: "drop into the editor", hint: "Ctrl+E" },
  { text: "browse checkpoints prev/next", hint: "Ctrl+B / Ctrl+F" },
  { text: "cycle modes (plan, architect, auto)", hint: "Ctrl+D" },
  { text: "stop a runaway response", hint: "Ctrl+X" },
  { text: "verbose render shows raw stream", hint: "/verbose-tab" },
  { text: "route cheap + strong models per task", hint: "/router" },
  { text: "pair your phone for remote approvals", hint: "/hearth" },
  { text: "expand all tool details", hint: "Ctrl+O" },
  { text: "steer mid-run by sending another message" },
  { text: "paste an image — Forge sees pictures" },
  { text: "drop a file path with @ to attach it" },
];

/**
 * Pick a tip for display, rotating through TIPS based on epoch + period.
 *
 * `seed` lets the caller pin the rotation to a tab id so two tabs don't show
 * the same tip at the same second. `periodMs` controls how often the tip
 * advances within a tab.
 */
export function pickTip(now: number = Date.now(), periodMs = 12_000, seed = 0): Tip {
  const idx = (Math.floor(now / periodMs) + seed) % TIPS.length;
  // TIPS is non-empty and idx is bounded by modulo — assert for type narrowing.
  return TIPS[idx] as Tip;
}
