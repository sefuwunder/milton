// tutorial.ts — interactive tutorial mode: progressive lessons defined as data.
//
// The lesson engine is pure: it takes a TutorialState and returns reply text.
// brain.ts wires it into dispatch; session persistence keeps progress across
// reconnects. All tryThis commands are real commands — tests/tutorial.test.ts
// audits each one against the actual parser (exact + fuzzy).

import type { IntentName } from "./intents";

export interface TutorialStep {
  id: string;
  title: string;
  explain: string;       // 1-3 short sentences
  tryThis: string;       // a real, working command
  expectIntents: IntentName[]; // any of these intents satisfies the step (fuzzy counts)
  hint: string;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "reads",
    title: "Reading the pipeline",
    explain: "Let's start simple: Milton reads your exec-crm straight from chat. Ask for anything — pipeline, deals, tasks — and I'll fetch it live.",
    tryThis: "show my top deals",
    expectIntents: ["top_deals", "deals"], // "show my top deals" lands on deals; "what are my biggest deals" on top_deals — both teach reading
    hint: "Any phrasing works — typos and all. Try `what are my biggest deals` if you like.",
  },
  {
    id: "detail",
    title: "Looking closer",
    explain: "Now drill into one record. A deal's detail view shows its stage, value, contacts, and any notes I've saved on it.",
    tryThis: "show deal Acme",
    expectIntents: ["deal_detail"],
    hint: "Use any deal name from the list above — or your own. I'll ask if a name matches more than one.",
  },
  {
    id: "writes",
    title: "Managing: notes",
    explain: "Milton writes back too. Notes stick to a deal and surface on every lookup. I'll always confirm before anything destructive.",
    tryThis: "note on Acme: called today, wants the proposal",
    expectIntents: ["add_note"],
    hint: "The shape is `note on <deal>: <text>` — the colon matters.",
  },
  {
    id: "analysis",
    title: "Analysis",
    explain: "Beyond lookups, I analyze: campaign performance, closing forecasts, pipeline hygiene. Anything structured can become a widget in the next step.",
    tryThis: "campaign stats",
    expectIntents: ["campaign_stats", "closing_soon"],
    hint: "`closing soon` works here too.",
  },
  {
    id: "widgets",
    title: "Widgets",
    explain: "Structured answers can be pinned to the Milton tab in exec-crm as widgets. You just ran an analysis, so there's something to pin.",
    tryThis: "pin this as a widget",
    expectIntents: ["pin_widget"],
    hint: "If exec-crm isn't reachable, I'll say so plainly — the step still counts.",
  },
  {
    id: "automations",
    title: "Automations",
    explain: "The advanced layer: bundle commands into routines (`save routine EOD: my tasks; kpis`), put them on a clock (`schedule EOD every weekday at 6pm`), or fire them on CRM events (`trigger help` lists them all). For now, just list what's set up.",
    tryThis: "list routines",
    expectIntents: ["list_routines"],
    hint: "Read-only and safe — nothing changes.",
  },
];

// Serializable; lives on Session.tutorial and in the SQLite session row.
export interface TutorialState {
  active: boolean;
  step: number; // index into TUTORIAL_STEPS; step >= len means finished
  done?: boolean;
}

export type TutorialAction = "start" | "restart" | "status" | "skip" | "back" | "exit";

export function renderStep(i: number): string {
  const s = TUTORIAL_STEPS[i];
  return `**Tutorial — step ${i + 1} of ${TUTORIAL_STEPS.length}: ${s.title}**\n\n${s.explain}\n\nTry it: \`${s.tryThis}\`\n\n${s.hint}\n\n_Say \`skip\` to move on, \`back\` to repeat, or \`exit tutorial\` to leave anytime._`;
}

// Deterministic acknowledgments, rotated by step index — no randomness.
const ACKS = [
  "Got it — that's the read layer working.",
  "Exactly — the detail view.",
  "Nice — that's a write, saved.",
  "Right — analysis mode.",
  "Pinned.",
  "And that's the automation layer.",
];

export function graduationText(): string {
  return [
    "**Tutorial complete — here's your map:**",
    "",
    "- **Reading**: ask for anything — `top deals`, `show deal Acme`, `my tasks`, `kpis`.",
    "- **Managing**: `note on Acme: …`, `add task …`, `move Acme deal to negotiation`.",
    "- **Analysis**: `campaign stats`, `closing soon`, `sales cycle`, `pipeline hygiene`.",
    "- **Widgets**: follow any analysis with `pin this as a widget` — it lands on the Milton tab in exec-crm.",
    "- **Automations**: `save routine …` chains commands, `schedule …` puts them on a clock, `when … run …` fires them on CRM events.",
    "",
    "I'll confirm before anything destructive and ask when a name matches more than one record.",
    "Say `tutorial` anytime to revisit a step, or `restart tutorial` to run the whole thing again.",
  ].join("\n");
}

export interface ControlResult {
  text: string;
  chips: string[];
}

/** Handle a tutorial control command. Mutates state in place. */
export function tutorialControl(state: TutorialState | undefined, action: TutorialAction): ControlResult {
  const st: TutorialState = state ?? { active: false, step: 0 };
  switch (action) {
    case "start": {
      if (st.done) {
        return { text: "You've already finished the tutorial — nice work. Say `restart tutorial` to run it again, or ask me anything.", chips: ["Restart tutorial", "Help"] };
      }
      // Resume whenever there's unfinished progress — including after
      // `exit tutorial` (which deactivates but keeps the step).
      if (st.step > 0 && st.step < TUTORIAL_STEPS.length) {
        st.active = true;
        return { text: `Welcome back — picking up where you left off.\n\n${renderStep(st.step)}`, chips: [TUTORIAL_STEPS[st.step].tryThis, "Skip"] };
      }
      st.active = true; st.step = 0; st.done = false;
      return {
        text: `Welcome to the Milton tutorial — ${TUTORIAL_STEPS.length} short steps from basics to automations. Type commands naturally; typos and paraphrases are fine.\n\n${renderStep(0)}`,
        chips: [TUTORIAL_STEPS[0].tryThis, "Skip"],
      };
    }
    case "restart": {
      st.active = true; st.step = 0; st.done = false;
      return { text: `Starting over.\n\n${renderStep(0)}`, chips: [TUTORIAL_STEPS[0].tryThis, "Skip"] };
    }
    case "status": {
      if (st.done) return { text: "Tutorial: complete. Say `restart tutorial` to run it again.", chips: ["Restart tutorial", "Help"] };
      if (!st.active) return { text: "You're not in the tutorial right now. Say `tutorial` to start it.", chips: ["Tutorial"] };
      const done = TUTORIAL_STEPS.slice(0, st.step).map((s) => s.title).join(", ") || "none yet";
      const remaining = TUTORIAL_STEPS.slice(st.step).map((s) => s.title).join(", ");
      return {
        text: `Tutorial: step ${st.step + 1} of ${TUTORIAL_STEPS.length} — **${TUTORIAL_STEPS[st.step].title}**\n\nDone: ${done}\nRemaining: ${remaining}`,
        chips: [TUTORIAL_STEPS[st.step].tryThis, "Skip", "Exit tutorial"],
      };
    }
    case "skip": {
      if (!st.active) return { text: "There's no tutorial running — say `tutorial` to start one.", chips: ["Tutorial"] };
      st.step++;
      if (st.step >= TUTORIAL_STEPS.length) {
        st.active = false; st.done = true;
        return { text: graduationText(), chips: ["Restart tutorial", "Help"] };
      }
      return { text: `Skipped ahead.\n\n${renderStep(st.step)}`, chips: [TUTORIAL_STEPS[st.step].tryThis, "Skip"] };
    }
    case "back": {
      if (!st.active) return { text: "There's no tutorial running — say `tutorial` to start one.", chips: ["Tutorial"] };
      st.step = Math.max(0, st.step - 1);
      return { text: `Back one.\n\n${renderStep(st.step)}`, chips: [TUTORIAL_STEPS[st.step].tryThis, "Skip"] };
    }
    case "exit": {
      if (!st.active) return { text: "There's no tutorial running — say `tutorial` to start one.", chips: ["Tutorial"] };
      st.active = false;
      return { text: `Paused the tutorial at step ${st.step + 1} — your progress is kept. Say \`tutorial\` to pick up where you left off.`, chips: ["Tutorial", "Help"] };
    }
  }
}

export interface FollowupResult {
  text: string;
  chips?: string[];
}

/**
 * Called after a non-control message is dispatched while tutorial mode is
 * active. Advances on a satisfying intent; otherwise the reply is returned
 * untouched apart from a one-line gentle re-offer. Mutates state in place.
 */
export function tutorialFollowup(state: TutorialState, intentName: IntentName, text: string, chips?: string[]): FollowupResult {
  if (!state.active) return { text, chips };
  const step = TUTORIAL_STEPS[state.step];
  if (!step) { state.active = false; return { text, chips }; }
  if (step.expectIntents.includes(intentName)) {
    state.step++;
    if (state.step >= TUTORIAL_STEPS.length) {
      state.active = false; state.done = true;
      return { text: `${text}\n\n—\n${ACKS[(state.step - 1) % ACKS.length]}\n\n${graduationText()}`, chips: ["Restart tutorial", "Help"] };
    }
    const next = TUTORIAL_STEPS[state.step];
    return {
      text: `${text}\n\n—\n${ACKS[(state.step - 1) % ACKS.length]}\n\n${renderStep(state.step)}`,
      chips: [next.tryThis, "Skip"],
    };
  }
  // Off-script: the reply stands on its own; just re-offer the current step.
  return {
    text: `${text}\n\n—\n_Still on tutorial step ${state.step + 1} of ${TUTORIAL_STEPS.length} (${step.title}) — try \`${step.tryThis}\`, or say \`skip\` / \`exit tutorial\`._`,
    chips: chips && chips.length ? chips : [step.tryThis, "Skip"],
  };
}
