// upload.test.ts — /api/upload, /api/file/:id, and chat attachments, against a
// real server booted with a temp MILTON_DATA dir. Zero deps.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { crc32, renderFontText } from "../src/ocr";

let server: any;
let base = "";
const SID = "upload-test-session";

function pngBytes(w: number, h: number, gray: (x: number, y: number) => number): Uint8Array {
  const stride = w;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (stride + 1) + 1 + x] = gray(x, y);
  }
  const idat = Bun.deflateSync(raw);
  const chunks: Uint8Array[] = [];
  const push = (type: string, data: Uint8Array) => {
    const hh = new Uint8Array(8);
    new DataView(hh.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) hh[4 + i] = type.charCodeAt(i);
    const body = new Uint8Array(4 + data.length);
    body.set(hh.subarray(4, 8), 0); body.set(data, 4);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(body));
    chunks.push(hh.subarray(0, 4), body, crc);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
  push("IHDR", ihdr);
  push("IDAT", idat);
  push("IEND", new Uint8Array(0));
  const out = new Uint8Array(8 + chunks.reduce((a, c) => a + c.length, 0));
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let o = 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function textPng(text: string): Uint8Array {
  const img = renderFontText(text, 5);
  return pngBytes(img.w, img.h, (x, y) => Math.round(img.d[y * img.w + x]));
}

function multipart(boundary: string, field: string, filename: string, bytes: Uint8Array, ctype: string): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${ctype}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0); out.set(bytes, head.length); out.set(tail, head.length + bytes.length);
  return out;
}

async function upload(session: string, filename: string, bytes: Uint8Array, ctype = "image/png") {
  const boundary = "testboundary123";
  const res = await fetch(`${base}/api/upload?session=${session}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: multipart(boundary, "photo", filename, bytes, ctype),
  });
  return res;
}

beforeAll(async () => {
  process.env.MILTON_DATA = `/tmp/milton-upload-test-${Date.now()}`;
  process.env.PORT = "0";
  const mod = await import("../src/server.ts");
  // The server module binds its database on first import and bun shares
  // module state across test files: another file may have imported server.ts
  // first (test files run in readdir order, which varies by filesystem) and
  // re-pointed the per-domain stores (e.g. chat_sessions) at a scratch DB
  // without the full schema. Reset explicitly so these tests always run
  // against their own dir.
  mod.__resetDataDirForTests(process.env.MILTON_DATA);
  server = mod.server;
  base = `http://localhost:${server.port}`;
});

afterAll(() => { server?.stop(); });

describe("POST /api/upload", () => {
  test("accepts a PNG photo and returns id + url", async () => {
    const res = await upload(SID, "note.png", textPng("HELLO"));
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(typeof j.id).toBe("string");
    expect(j.url).toBe(`/api/file/${j.id}`);
  });

  test("rejects non-image magic bytes with 415", async () => {
    const res = await upload(SID, "evil.exe", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]), "application/octet-stream");
    expect(res.status).toBe(415);
    const j: any = await res.json();
    expect(j.error).toMatch(/JPEG, PNG/);
  });

  test("rejects files over 10 MB with 413", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set([137, 80, 78, 71, 13, 10, 26, 10], 0); // PNG magic so it passes type check
    const res = await upload(SID, "big.png", big);
    expect(res.status).toBe(413);
  });

  test("requires multipart", async () => {
    const res = await fetch(`${base}/api/upload?session=${SID}`, { method: "POST", body: "hi" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/file/:id", () => {
  test("serves the photo back to the owning session", async () => {
    const up = await upload("file-owner", "a.png", textPng("ABC"));
    const { id } = (await up.json()) as any;
    const res = await fetch(`${base}/api/file/${id}?session=file-owner`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(50);
  });

  test("another session gets 404 (scoped)", async () => {
    const up = await upload("file-owner-2", "b.png", textPng("XYZ"));
    const { id } = (await up.json()) as any;
    const res = await fetch(`${base}/api/file/${id}?session=intruder`);
    expect(res.status).toBe(404);
  });

  test("unknown id gets 404", async () => {
    const res = await fetch(`${base}/api/file/nope?session=${SID}`);
    expect(res.status).toBe(404);
  });
});

describe("chat with attachments", () => {
  test("captionless upload auto-runs OCR and returns a transcription card", async () => {
    const up = await upload("ocr-session", "note.png", textPng("HELLO 123"));
    const { id } = (await up.json()) as any;
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "ocr-session", message: "", attachments: [id] }),
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    const card = (j.cards || []).find((c: any) => c.kind === "transcription");
    expect(card).toBeTruthy();
    expect(card.ocrText.replace(/\s+/g, " ").trim()).toBe("HELLO 123");
    expect(card.confidence).toBeGreaterThan(0.8);
    expect(j.chips).toContain("Analyze handwriting");
    expect(j.chips).toContain("Save note to a deal");
  });

  test("'read this' works on the session's latest upload", async () => {
    await upload("read-session", "note.png", textPng("ACME 50K"));
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "read-session", message: "read this" }),
    });
    const j: any = await res.json();
    const card = (j.cards || []).find((c: any) => c.kind === "transcription");
    expect(card?.ocrText.replace(/\s+/g, " ").trim()).toBe("ACME 50K");
  });

  test("'analyze handwriting' works on the latest upload", async () => {
    await upload("hw-session", "note.png", textPng("HELLO"));
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "hw-session", message: "analyze handwriting" }),
    });
    const j: any = await res.json();
    const card = (j.cards || []).find((c: any) => c.kind === "handwriting");
    expect(card).toBeTruthy();
    expect(card.notes.join(" ")).toMatch(/geometric stroke analysis, not personality science/);
    expect(card.metrics.chars).toBeGreaterThan(0);
  });

  test("'read this' with no photo tells the user to tap the camera button", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "empty-session", message: "read this" }),
    });
    const j: any = await res.json();
    expect(j.text).toMatch(/camera button/);
    expect(j.cards || []).toHaveLength(0);
  });

  test("attachments from another session are ignored", async () => {
    const up = await upload("owner-session", "note.png", textPng("SECRET"));
    const { id } = (await up.json()) as any;
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "other-session", message: "read this", attachments: [id] }),
    });
    const j: any = await res.json();
    expect(j.text).toMatch(/camera button/);
  });
});
