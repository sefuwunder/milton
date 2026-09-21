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
    explain: "Let's start simple: Milton reads your exec-crm straight from chat. Ask for anything — pipeline, deals, tasks — and I'll fetch it live. In the web chat, type `/` anytime for the same commands as a searchable palette: filter as you type, arrow keys to move, Enter or a tap to insert.",
    tryThis: "show my top deals",
    expectIntents: ["top_deals", "deals"], // "show my top deals" lands on deals; "what are my biggest deals" on top_deals — both teach reading
    hint: "Any phrasing works — typos and all. If a name matches more than one record, I'll ask which one.",
  },
  {
    id: "wizards",
    title: "Guided creating",
    explain: "A bare `new deal` — or contact, company, task — starts a guided wizard: one question at a time. Answer naturally, say `skip` for a default, `cancel` to bail with nothing created. Wander off mid-wizard and I'll answer your question, then bring you back.",
    tryThis: "new deal",
    expectIntents: ["wizard_start"],
    hint: "The wizard stays open after this step — say `cancel` to leave it and keep going with the tutorial.",
  },
  {
    id: "followups",
    title: "Follow-up questions",
    explain: "I remember what we're talking about. Ask `deal journey Acme Website` for a stage-history timeline — or follow up in plain words: `move it to proposal`, `what's her email?`, `what's blocking this task`, `show duplicates`, `deals from referrals`.",
    tryThis: "deal journey Acme Website",
    expectIntents: ["deal_journey"],
    hint: "Pronouns like it/her resolve to the last thing we discussed — but I never guess across types.",
  },
  {
    id: "writes",
    title: "Managing: notes",
    explain: "Milton writes back too. Notes stick to a deal and surface on every lookup. I'll always confirm before anything destructive.",
    tryThis: "note on Acme Website: called today",
    expectIntents: ["add_note"],
    hint: "The shape is `note on <deal>: <text>` — the colon matters.",
  },
  {
    id: "undo",
    title: "Undo",
    explain: "Changed your mind? `undo` takes back my last change in this chat — creates, stage moves, field updates, task toggles. One thing it can't do: un-merge. Merges are permanent, and I'll say so before doing one.",
    tryThis: "undo",
    expectIntents: ["undo"],
    hint: "Undo is per chat session — each named session has its own history.",
  },
  {
    id: "typos",
    title: "Typos welcome",
    explain: "Type like you text. I understand typos, paraphrases, and scrambled word order — and when you're close but not quite there, I offer tappable suggestions instead of guessing.",
    tryThis: "show my top daels",
    expectIntents: ["top_deals", "deals"], // fuzzy resolves the typo; exact falls back to deals
    hint: "Yes, that's really misspelled. Watch what happens.",
  },
  {
    id: "sessions",
    title: "Named chat sessions",
    explain: "Keep separate threads: `sessions` lists them, `new session Pipeline review` starts one, `switch session to <name>` jumps between them — plus rename and delete (delete asks first). Each session keeps its own history, workspace, and tutorial progress.",
    tryThis: "sessions",
    expectIntents: ["chat_session"],
    hint: "Read-only and safe — this just lists.",
  },
  {
    id: "fields",
    title: "Custom fields",
    explain: "Your CRM can grow new fields without leaving chat: `add custom field Renewal date to deals`, then `set Renewal date on Acme Website to 2026-12-01`. This lists what's already defined.",
    tryThis: "list custom fields for contacts",
    expectIntents: ["show_custom_fields"],
    hint: "Fields are per entity — deals, contacts, companies, tasks.",
  },
  {
    id: "meridian",
    title: "The outside world",
    explain: "I read Meridian's recon sprints too: `meridian recons`, then `meridian dossier <city>` or `meridian entities <city>`. Bringing contacts in? In the web chat, the contacts button stages a .vcf for import (nothing imports without your Yes), the camera button runs OCR on a photo — handwriting included — or just tell me `just met James from Vertex`.",
    tryThis: "meridian recons",
    expectIntents: ["list_recons"],
    hint: "If Meridian isn't reachable, I'll say so plainly — the step still counts.",
  },
  {
    id: "stages",
    title: "Shaping your CRM",
    explain: "The pipeline itself is editable from here: `add stage`, `rename stage`, `move stage`, `delete stage` (I'll ask where its deals go). And `workspaces` lists your workspaces — `switch to <name>` starts a fresh session inside one, since each session lives in exactly one workspace.",
    tryThis: "list stages",
    expectIntents: ["list_stages"],
    hint: "Deleting a stage with deals in it needs a destination — I won't strand them.",
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
    explain: "The advanced layer: bundle commands into routines (`save routine EOD: my tasks; kpis`), put them on a clock (`schedule EOD every weekday at 6pm`), or fire them on CRM events (`trigger help` lists them all). Destructive steps never auto-run — they always wait for you. For now, just list what's set up.",
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
  "Wizard started — one question at a time.",
  "Exactly — follow-ups resolve against context.",
  "Nice — that's a write, saved.",
  "Undone — that's the safety net.",
  "See? Typos are fine here.",
  "Sessions listed — each is its own world.",
  "Custom fields — your schema, extended.",
  "That's the outside world, wired in.",
  "The CRM itself, reshaped from chat.",
  "Right — analysis mode.",
  "Pinned.",
  "And that's the automation layer.",
];

export function graduationText(): string {
  return [
    "**Tutorial complete — here's your map:**",
    "",
    "- **Reading**: ask for anything — `top deals`, `show deal Acme`, `my tasks`, `kpis`. In the web chat, `/` opens the command palette.",
    "- **Creating**: bare `new deal` / `new contact` / `new company` / `new task` start guided wizards — `skip` for defaults, `cancel` to bail.",
    "- **Follow-ups**: `deal journey Acme` for timelines, pronouns like `move it to proposal` or `what's her email?`, `what's blocking <task>`, `show duplicates`, `deals from <source>`.",
    "- **Managing**: `note on Acme: …`, `add task …`, `move Acme deal to negotiation`. `undo` takes back my last change — merges excepted.",
    "- **Forgiving input**: typos, paraphrases, scrambled word order all work; near-misses get tappable suggestions.",
    "- **Sessions**: `sessions`, `new session <name>`, `switch session to <name>`, rename, delete — each keeps its own history, workspace, and tutorial.",
    "- **Structure**: custom fields (`add custom field …`), pipeline stages (`add/rename/move/delete stage`), workspaces (`switch to <name>`).",
    "- **Outside world**: `meridian recons` / `meridian dossier <city>` / `meridian entities <city>` / `meridian prospect <industry> in <location>` (territories stage into the Data Workshop Sandbox); VCF import, camera OCR + handwriting, or `just met …` capture.",
    "- **Analysis & widgets**: `campaign stats`, `closing soon`, `sales cycle`, `pipeline hygiene` — follow any of them with `pin this as a widget`.",
    "- **Automations**: `save routine …` chains commands, `schedule …` puts them on a clock, `when … run …` fires them on CRM events. Destructive steps never auto-run.",
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
