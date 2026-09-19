// vcard.ts — deterministic vCard 3.0/4.0 parser, zero dependencies.
// Extracts identity fields only: FN/N, TEL, EMAIL, ORG, TITLE, URL, NOTE.
// PHOTO blobs are deliberately ignored (never stored). Handles folded lines
// (continuation lines starting with a space/tab) and multiple contacts per file.

export interface VCardPhone { type: string; number: string }
export interface VCardEmail { type: string; email: string }

export interface ParsedVCard {
  name: string;
  firstName: string;
  lastName: string;
  phones: VCardPhone[];
  emails: VCardEmail[];
  org: string;
  title: string;
  url: string;
  note: string;
}

/** Unescape vCard value escapes: \; \, \n \N \\. */
function unescapeValue(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\;/g, ";")
    .replace(/\\,/g, ",")
    .replace(/\\\\/g, "\\");
}

/** Pull a coarse type label out of TEL/EMAIL params, vCard 3.0 (";WORK;VOICE:")
 *  and 4.0 (";TYPE=WORK,VOICE:") styles both. */
function typeLabel(params: string, kinds: string[]): string {
  for (const k of kinds) if (params.includes(k)) return k.toLowerCase();
  return "other";
}

function blank(): ParsedVCard {
  return { name: "", firstName: "", lastName: "", phones: [], emails: [], org: "", title: "", url: "", note: "" };
}

/**
 * Parse vCard text into contacts. Throws a descriptive Error when the input
 * isn't a vCard file at all (no BEGIN:VCARD). A BEGIN without a matching END
 * still yields the card (lenient), and cards without any name are kept with
 * name "" so the caller can skip them.
 */
export function parseVcards(text: string): ParsedVCard[] {
  const unfolded: string[] = [];
  for (const rawLine of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (/^[ \t]/.test(rawLine) && unfolded.length) {
      // folded line: continuation (drop the single leading space/tab)
      unfolded[unfolded.length - 1] += rawLine.slice(1);
    } else {
      unfolded.push(rawLine);
    }
  }

  const cards: ParsedVCard[] = [];
  let cur: ParsedVCard | null = null;
  let sawBegin = false;

  for (const line of unfolded) {
    if (/^BEGIN:VCARD/i.test(line)) {
      sawBegin = true;
      cur = blank();
      continue;
    }
    if (/^END:VCARD/i.test(line)) {
      if (cur) cards.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^([^:;]+)((?:;[^:]*)*):(.*)$/);
    if (!m) continue; // not a property line; ignore
    const prop = m[1].toUpperCase();
    const params = m[2].toUpperCase();
    const value = unescapeValue(m[3]).trim();
    if (!value && prop !== "NOTE") continue;
    switch (prop) {
      case "FN":
        if (!cur.name) cur.name = value;
        break;
      case "N": {
        const parts = value.split(";");
        cur.lastName = parts[0] || "";
        cur.firstName = parts[1] || "";
        if (!cur.name) cur.name = [cur.firstName, cur.lastName].filter(Boolean).join(" ");
        break;
      }
      case "TEL":
        cur.phones.push({ type: typeLabel(params, ["CELL", "IPHONE", "WORK", "VOICE", "HOME", "FAX", "PAGER"]), number: value });
        break;
      case "EMAIL":
        cur.emails.push({ type: typeLabel(params, ["WORK", "HOME"]), email: value });
        break;
      case "ORG":
        if (!cur.org) cur.org = value.split(";")[0].trim();
        break;
      case "TITLE":
        if (!cur.title) cur.title = value;
        break;
      case "URL":
        if (!cur.url) cur.url = value;
        break;
      case "NOTE":
        cur.note = cur.note ? cur.note + "\n" + value : value;
        break;
      case "PHOTO":
        break; // deliberately ignored: never stored
      default:
        break; // ADR, BDAY, VERSION, etc.: not needed for import
    }
  }
  // lenient: a card never closed with END:VCARD still counts
  if (cur) cards.push(cur);

  if (!sawBegin) throw new Error("no BEGIN:VCARD found — this doesn't look like a vCard file");
  return cards;
}

const PHONE_RANK = ["cell", "iphone", "work", "voice", "home", "fax", "pager", "other"];
const EMAIL_RANK = ["work", "home", "other"];

/** Best phone for display/import: cell > work > voice > home > fax > other. */
export function preferredPhone(c: ParsedVCard): VCardPhone | null {
  if (!c.phones.length) return null;
  const sorted = [...c.phones].sort(
    (a, b) => PHONE_RANK.indexOf(a.type) - PHONE_RANK.indexOf(b.type)
  );
  return sorted[0];
}

/** Best email for display/import: work first. */
export function preferredEmail(c: ParsedVCard): VCardEmail | null {
  if (!c.emails.length) return null;
  const sorted = [...c.emails].sort(
    (a, b) => EMAIL_RANK.indexOf(a.type) - EMAIL_RANK.indexOf(b.type)
  );
  return sorted[0];
}
