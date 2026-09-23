// vcard.test.ts — vCard parser, /api/upload .vcf acceptance, and the chat
// import flow (offer card -> confirm -> create, with duplicate skipping).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { parseVcards, preferredPhone, preferredEmail } from "../src/vcard";
import * as auto from "../src/automation";
import { handleMessage, type Session } from "../src/brain";

const VCF_TWO = `BEGIN:VCARD
VERSION:3.0
FN:Jane Doe
N:Doe;Jane;;;
ORG:Acme Corp
TITLE:VP Sales
TEL;TYPE=WORK,VOICE:+1-555-0100
TEL;TYPE=CELL:+1-555-0101
EMAIL;TYPE=WORK:jane@acme.com
EMAIL;TYPE=HOME:jane@home.example
URL:https://acme.example
NOTE:Met at the spring conference
END:VCARD
BEGIN:VCARD
VERSION:4.0
FN:John Smith
N:Smith;John;;;
TEL;WORK;VOICE:+1-555-0200
EMAIL:john@smith.example
END:VCARD
`;

beforeAll(() => { auto.initAutomationDb(new Database(":memory:")); });

// ---- parser --------------------------------------------------------------------
describe("parseVcards", () => {
  test("parses two contacts with preferred phone/email", () => {
    const cards = parseVcards(VCF_TWO);
    expect(cards).toHaveLength(2);
    const [jane, john] = cards;
    expect(jane.name).toBe("Jane Doe");
    expect(jane.firstName).toBe("Jane");
    expect(jane.lastName).toBe("Doe");
    expect(jane.org).toBe("Acme Corp");
    expect(jane.title).toBe("VP Sales");
    expect(jane.url).toBe("https://acme.example");
    expect(jane.note).toBe("Met at the spring conference");
    expect(jane.phones).toHaveLength(2);
    expect(preferredPhone(jane)?.number).toBe("+1-555-0101"); // cell wins over work
    expect(preferredEmail(jane)?.email).toBe("jane@acme.com"); // work wins over home
    expect(john.name).toBe("John Smith");
    expect(john.phones[0].type).toBe("work"); // 3.0-style ;WORK;VOICE params
    expect(preferredEmail(john)?.email).toBe("john@smith.example");
  });

  test("handles folded lines", () => {
    const vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alexandra\r\nNOTE:This is a very long note that \r\n continues on the next line\r\nEND:VCARD\r\n";
    const [c] = parseVcards(vcf);
    expect(c.name).toBe("Alexandra");
    expect(c.note).toBe("This is a very long note that continues on the next line");
  });

  test("N without FN still yields a name", () => {
    const [c] = parseVcards("BEGIN:VCARD\nN:Rivera;Alex;;;\nEND:VCARD\n");
    expect(c.name).toBe("Alex Rivera");
  });

  test("missing fields stay empty; PHOTO is ignored", () => {
    const [c] = parseVcards("BEGIN:VCARD\nFN:No Photo\nPHOTO;ENCODING=b;TYPE=JPEG:ffff\nEND:VCARD\n");
    expect(c.name).toBe("No Photo");
    expect(c.phones).toHaveLength(0);
    expect(c.emails).toHaveLength(0);
    expect(preferredPhone(c)).toBeNull();
    expect(preferredEmail(c)).toBeNull();
  });

  test("unclosed card still counts (lenient)", () => {
    const cards = parseVcards("BEGIN:VCARD\nFN:Open Ended\n");
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe("Open Ended");
  });

  test("non-vCard input throws a descriptive error", () => {
    expect(() => parseVcards("just some text\nno cards here")).toThrow(/BEGIN:VCARD/);
    expect(() => parseVcards("")).toThrow(/BEGIN:VCARD/);
  });

  test("unescapes \\; \\, and \\n in values", () => {
    const [c] = parseVcards("BEGIN:VCARD\nFN:Esc Tester\nNOTE:line one\\nline two\\; done\nEND:VCARD\n");
    expect(c.note).toBe("line one\nline two; done");
  });
});

// ---- /api/upload: .vcf acceptance (isolated server process) -----------------------
describe("POST /api/upload .vcf", () => {
  let base = "";
  let proc: any = null;
  const dataDir = `/tmp/milton-vcard-test-${process.pid}`;

  function multipart(boundary: string, filename: string, bytes: Uint8Array, ctype: string): Uint8Array {
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${ctype}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const out = new Uint8Array(head.length + bytes.length + tail.length);
    out.set(head, 0); out.set(bytes, head.length); out.set(tail, head.length + bytes.length);
    return out;
  }

  async function upload(filename: string, text: string, ctype = "text/vcard") {
    const boundary = "vcfboundary1";
    return fetch(`${base}/api/upload?session=vcf-upload`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: multipart(boundary, filename, new TextEncoder().encode(text), ctype),
    });
  }

  beforeAll(async () => {
    const root = new URL("../", import.meta.url).pathname;
    proc = Bun.spawn([process.execPath, "src/server.ts"], {
      cwd: root,
      env: { ...process.env, MILTON_DATA: dataDir, PORT: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (value) {
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/milton listening on http:\/\/localhost:(\d+)/);
        if (m) { base = `http://localhost:${m[1]}`; break; }
      }
      if (done) break;
    }
    reader.releaseLock();
    if (!base) throw new Error("vcard test server did not start. output: " + buf.slice(-800));
  });

  afterAll(() => { try { proc?.kill(); } catch { /* already gone */ } });

  test("accepts a .vcf file with BEGIN:VCARD", async () => {
    const res = await upload("contacts.vcf", VCF_TWO);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(typeof j.id).toBe("string");
    expect(j.url).toBe(`/api/file/${j.id}`);
  });

  test("rejects a .vcf filename whose content isn't a vCard", async () => {
    const res = await upload("fake.vcf", "MZ\x90\x00binary junk, not a vCard");
    expect(res.status).toBe(415);
  });

  test("still rejects non-image, non-vcf files", async () => {
    const res = await upload("notes.txt", "just some notes");
    expect(res.status).toBe(415);
    const j: any = await res.json();
    expect(j.error).toMatch(/JPEG, PNG/);
  });
});

// ---- chat import flow (stubbed exec-crm, real temp vcf files) ----------------------
describe("vCard import flow", () => {
  const calls: { method: string; path: string; body?: any }[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  let stubContacts: any[] = [];
  let stubCompanies: any[] = [];
  let nextId = 100;

  function stubFetch(input: any, init: any = {}): Promise<Response> {
    const url = String(input);
    if (!url.startsWith("http://localhost:3001")) return realFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    const path = url.replace("http://localhost:3001", "");
    let body: any;
    try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    calls.push({ method, path, body });
    const ok = (data: any, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
    if (method === "GET" && path === "/api/contacts") return ok({ contacts: stubContacts });
    if (method === "GET" && path === "/api/companies") return ok({ companies: stubCompanies });
    if (method === "POST" && path === "/api/contacts") {
      const c = { id: nextId++, ...body };
      return ok({ contact: c });
    }
    return ok({});
  }

  const sess = (): Session => ({ id: "vcard-test", history: [], notes: [] });
  const dir = `/tmp/milton-vcard-flow-${process.pid}`;

  async function vcfRef(name: string, content: string) {
    await Bun.$`mkdir -p ${dir}`.quiet().catch(() => {});
    const path = `${dir}/${name}`;
    await Bun.write(path, content);
    return { id: name, mime: "text/vcard", size: content.length, path };
  }

  beforeAll(() => {
    (globalThis as any).fetch = stubFetch;
    stubContacts = [];
    stubCompanies = [];
    calls.length = 0;
  });
  afterAll(() => { (globalThis as any).fetch = realFetch; });

  test("captionless vcf upload offers an import with a contacts card, no writes yet", async () => {
    const ref = await vcfRef("two.vcf", VCF_TWO);
    const s = sess();
    const r = await handleMessage(s, "", { attachments: [ref] });
    expect(r.text).toMatch(/2 contacts/);
    const list = (r.cards || []).find((c) => c.kind === "contacts");
    expect(list?.items).toHaveLength(2);
    expect(list?.items?.[0].name).toBe("Jane Doe");
    expect(list?.items?.[0].email).toBe("jane@acme.com");
    expect(list?.items?.[0].phone).toBe("+1-555-0101");
    expect((r.cards || []).some((c) => c.kind === "confirm")).toBe(true);
    expect(s.pending?.type).toBe("vcard_import");
    expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing written before confirmation
  });

  test("'import these contacts' with attachment offers the import", async () => {
    const ref = await vcfRef("two2.vcf", VCF_TWO);
    const s = sess();
    const r = await handleMessage(s, "import these contacts", { attachments: [ref] });
    expect(r.text).toMatch(/2 contacts/);
    expect(s.pending?.type).toBe("vcard_import");
  });

  test("'import these contacts' with no file asks for one", async () => {
    const r = await handleMessage(sess(), "import these contacts");
    expect(r.text).toMatch(/\.vcf/);
  });

  test("confirming creates both contacts", async () => {
    calls.length = 0;
    const ref = await vcfRef("two3.vcf", VCF_TWO);
    const s = sess();
    await handleMessage(s, "import these contacts", { attachments: [ref] });
    const r = await handleMessage(s, "yes");
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/contacts");
    expect(posts).toHaveLength(2);
    expect(posts[0].body.name).toBe("Jane Doe");
    expect(posts[0].body.email).toBe("jane@acme.com");
    expect(posts[0].body.phone).toBe("+1-555-0101");
    expect(posts[0].body.title).toBe("VP Sales");
    expect(posts[1].body.name).toBe("John Smith");
    expect(r.text).toMatch(/Imported \*\*2\*\* contacts/);
  });

  test("unmatched ORG is appended to notes, never silently dropped", async () => {
    stubCompanies = []; // "Acme Corp" matches nothing
    calls.length = 0;
    const ref = await vcfRef("org-note.vcf", VCF_TWO);
    const s = sess();
    await handleMessage(s, "import these contacts", { attachments: [ref] });
    const r = await handleMessage(s, "yes");
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/contacts");
    expect(posts).toHaveLength(2);
    const jane = posts[0].body;
    expect(jane.name).toBe("Jane Doe");
    expect(jane.company_id).toBeUndefined();
    expect(jane.notes).toContain("Company: Acme Corp");
    expect(jane.notes).toContain("Met at the spring conference"); // existing NOTE merged
    expect(jane.notes).toContain("Website: https://acme.example");
    expect(r.text).toMatch(/Imported \*\*2\*\* contacts/);
    stubCompanies = [];
  });

  test("matched ORG links via company_id and does not duplicate into notes", async () => {
    stubCompanies = [{ id: 7, name: "Acme Corp" }];
    calls.length = 0;
    const ref = await vcfRef("org-match.vcf", VCF_TWO);
    const s = sess();
    await handleMessage(s, "import these contacts", { attachments: [ref] });
    await handleMessage(s, "yes");
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/contacts");
    expect(posts).toHaveLength(2);
    const jane = posts[0].body;
    expect(jane.company_id).toBe(7);
    expect(jane.notes || "").not.toContain("Company:");
    stubCompanies = [];
  });

  test("contact without ORG is unaffected", async () => {
    stubCompanies = [];
    calls.length = 0;
    const ref = await vcfRef("org-none.vcf", VCF_TWO);
    const s = sess();
    await handleMessage(s, "import these contacts", { attachments: [ref] });
    await handleMessage(s, "yes");
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/contacts");
    expect(posts).toHaveLength(2);
    const john = posts[1].body;
    expect(john.name).toBe("John Smith");
    expect(john.company_id).toBeUndefined();
    expect(john.notes).toBeUndefined();
  });

  test("duplicate emails are skipped", async () => {
    stubContacts = [{ id: 1, name: "Jane Doe", email: "jane@acme.com", phone: "", company_id: null, title: "", notes: "" }];
    calls.length = 0;
    const ref = await vcfRef("two4.vcf", VCF_TWO);
    const s = sess();
    await handleMessage(s, "import these contacts", { attachments: [ref] });
    const r = await handleMessage(s, "yes");
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/contacts");
    expect(posts).toHaveLength(1);
    expect(posts[0].body.name).toBe("John Smith");
    expect(r.text).toMatch(/1 skipped/);
    stubContacts = [];
  });

  test("malformed vCard gives a clean error, no pending", async () => {
    const ref = await vcfRef("bad.vcf", "not a vcard at all");
    const s = sess();
    const r = await handleMessage(s, "", { attachments: [ref] });
    expect(r.text).toMatch(/doesn't look like a valid vCard/);
    expect(s.pending).toBeUndefined();
  });
});
