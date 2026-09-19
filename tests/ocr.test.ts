// ocr.test.ts — tests for the tiny OCR engine (src/ocr.ts). Zero deps.
import { describe, test, expect } from "bun:test";
import {
  decodePng, decodeJpeg, ocrBytes, ocrGrayImage, otsu, grayImage,
  renderFontText, matchGlyph, crc32, detectKind, type GrayImage,
} from "../src/ocr";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

// ---- PNG: build a minimal PNG in-test, round-trip it ---------------------------
function buildPng(w: number, h: number, rgb: (x: number, y: number) => [number, number, number]): Uint8Array {
  const stride = w * 3;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = y === 2 ? 1 : 0; // exercise the Sub filter on row 2
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgb(x, y);
      raw[y * (stride + 1) + 1 + x * 3] = r;
      raw[y * (stride + 1) + 1 + x * 3 + 1] = g;
      raw[y * (stride + 1) + 1 + x * 3 + 2] = b;
    }
    if (y === 2) {
      // Sub-encode: each byte stored as (value - previous pixel's byte)
      const base = y * (stride + 1) + 1;
      for (let i = stride - 1; i >= 0; i--) {
        raw[base + i] = (raw[base + i] - (i >= 3 ? raw[base + i - 3] : 0)) & 255;
      }
    }
  }
  const idat = Bun.deflateSync(raw);
  const chunks: Uint8Array[] = [];
  const push = (type: string, data: Uint8Array) => {
    const h = new Uint8Array(8);
    new DataView(h.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) h[4 + i] = type.charCodeAt(i);
    const body = new Uint8Array(4 + data.length);
    body.set(h.subarray(4, 8), 0); body.set(data, 4);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(body));
    chunks.push(h.subarray(0, 4), body, crc);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  push("IHDR", ihdr);
  push("IDAT", idat);
  push("IEND", new Uint8Array(0));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const out = new Uint8Array(8 + chunks.reduce((a, c) => a + c.length, 0));
  out.set(sig, 0);
  let o = 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

describe("PNG decoder", () => {
  test("round-trips an 8-bit RGB PNG (filters 0 and 1)", () => {
    const png = buildPng(6, 4, (x, y) => [(x * 40) % 256, (y * 60) % 256, ((x + y) * 30) % 256]);
    expect(detectKind(png)).toBe("png");
    const img = decodePng(png);
    expect(img.w).toBe(6); expect(img.h).toBe(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 6; x++) {
        const [r, g, b] = [(x * 40) % 256, (y * 60) % 256, ((x + y) * 30) % 256];
        const want = 0.299 * r + 0.587 * g + 0.114 * b;
        expect(Math.abs(img.d[y * 6 + x] - want)).toBeLessThan(0.51);
      }
    }
  });
  test("rejects non-PNG bytes", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

// ---- JPEG: tiny baseline encoder in-test, round-trip through the decoder --------
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48,
  41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15,
  23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
// Standard (Annex K) luminance Huffman tables.
const STD_DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STD_DC_SYMS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STD_AC_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const STD_AC_SYMS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

function canonicalCodes(counts: number[], syms: number[]): Map<number, { code: number; len: number }> {
  const m = new Map<number, { code: number; len: number }>();
  let code = 0, si = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) { m.set(syms[si++], { code, len }); code++; }
    code <<= 1;
  }
  return m;
}

class BitWriter {
  bytes: number[] = []; acc = 0; nbits = 0;
  write(code: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.nbits === 8) this.flush();
    }
  }
  flush() {
    if (!this.nbits) return;
    this.acc <<= 8 - this.nbits;
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0x00);
    this.acc = 0; this.nbits = 0;
  }
  result(): Uint8Array { this.flush(); return new Uint8Array(this.bytes); }
}

function fdctBlock(px: Float32Array): Float64Array {
  const F = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          s += px[y * 8 + x] * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        }
      }
      F[v * 8 + u] = 0.25 * (u === 0 ? Math.SQRT1_2 : 1) * (v === 0 ? Math.SQRT1_2 : 1) * s;
    }
  }
  return F;
}

/** Minimal baseline grayscale JPEG encoder (test-only). Q table of all 1s: near-lossless. */
export function encodeJpegGray(w: number, h: number, px: Uint8Array): Uint8Array {
  const dcCodes = canonicalCodes(STD_DC_COUNTS, STD_DC_SYMS);
  const acCodes = canonicalCodes(STD_AC_COUNTS, STD_AC_SYMS);
  const bw = new BitWriter();
  let prevDC = 0;
  const cat = (v: number) => (v === 0 ? 0 : Math.floor(Math.log2(Math.abs(v))) + 1);
  const bitsOf = (v: number, s: number) => (v >= 0 ? v : v + (1 << s) - 1);
  for (let by = 0; by < h / 8; by++) {
    for (let bx = 0; bx < w / 8; bx++) {
      const blk = new Float32Array(64);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = px[(by * 8 + y) * w + bx * 8 + x] - 128;
      const F = fdctBlock(blk);
      const q = new Int32Array(64);
      for (let k = 0; k < 64; k++) q[k] = Math.round(F[ZIGZAG[k]]); // Q = 1, zigzag order
      const diff = q[0] - prevDC; prevDC = q[0];
      const s = cat(diff);
      const dc = dcCodes.get(s)!;
      bw.write(dc.code, dc.len); bw.write(bitsOf(diff, s), s);
      let zeroRun = 0;
      for (let k = 1; k < 64; k++) {
        const v = q[k];
        if (v === 0) { zeroRun++; continue; }
        while (zeroRun >= 16) { const z = acCodes.get(0xf0)!; bw.write(z.code, z.len); zeroRun -= 16; }
        const sym = (zeroRun << 4) | cat(v);
        const ac = acCodes.get(sym)!;
        bw.write(ac.code, ac.len); bw.write(bitsOf(v, cat(v)), cat(v));
        zeroRun = 0;
      }
      if (zeroRun > 0) { const eob = acCodes.get(0x00)!; bw.write(eob.code, eob.len); }
    }
  }
  const scan = bw.result();
  const out: number[] = [];
  const seg = (marker: number, data: number[]) => {
    out.push(0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data);
  };
  out.push(0xff, 0xd8); // SOI
  seg(0xdb, [0x00, ...new Array(64).fill(1)]); // DQT, all ones
  seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]); // SOF0 gray
  seg(0xc4, [0x00, ...STD_DC_COUNTS, ...STD_DC_SYMS]); // DHT DC
  seg(0xc4, [0x10, ...STD_AC_COUNTS, ...STD_AC_SYMS]); // DHT AC
  seg(0xda, [1, 1, 0x00, 0x00, 0x3f, 0x00]); // SOS
  for (const b of scan) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return new Uint8Array(out);
}

describe("JPEG decoder", () => {
  test("round-trips a 16x16 baseline grayscale JPEG within tolerance", () => {
    const w = 16, h = 16;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 13 + y * 29 + ((x * y) % 7) * 11) % 256;
    const jpg = encodeJpegGray(w, h, px);
    expect(detectKind(jpg)).toBe("jpeg");
    const img = decodeJpeg(jpg);
    expect(img.w).toBe(w); expect(img.h).toBe(h);
    let maxErr = 0;
    for (let i = 0; i < px.length; i++) maxErr = Math.max(maxErr, Math.abs(img.d[i] - px[i]));
    expect(maxErr).toBeLessThan(4); // DCT float rounding only; Q=1
  });
  test("rejects non-JPEG bytes", () => {
    expect(() => decodeJpeg(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe("Otsu + template matching", () => {
  test("otsu finds the valley of a bimodal image", () => {
    const img = grayImage(20, 10);
    const rnd = lcg(42);
    for (let i = 0; i < img.d.length; i++) {
      img.d[i] = i % 2 === 0 ? 40 + rnd() * 20 : 200 + rnd() * 20;
    }
    const t = otsu(img);
    expect(t).toBeGreaterThan(60);
    expect(t).toBeLessThan(200);
  });

  test("template matcher reads programmatically rendered 'HELLO 123'", () => {
    const img = renderFontText("HELLO 123", 6);
    const r = ocrGrayImage(img);
    expect(r.text).toBe("HELLO 123");
    expect(r.confidence).toBeGreaterThan(0.85);
    expect(r.script).toBe("print");
    expect(r.lines.length).toBe(1);
    expect(r.lines[0].text).toBe("HELLO 123");
  });

  test("template matcher tolerates a little speckle noise", () => {
    const img = renderFontText("ACME 50K", 5);
    const rnd = lcg(7);
    for (let i = 0; i < img.d.length; i++) {
      if (rnd() < 0.01) img.d[i] = img.d[i] > 128 ? 0 : 255; // flip 1% of pixels
    }
    const r = ocrGrayImage(img);
    expect(r.text).toBe("ACME 50K");
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  test("matchGlyph confidence drops for a random non-glyph blob", () => {
    const rnd = lcg(1234);
    let lo = 0, hi = 0;
    for (let b = 0; b < 35; b++) {
      if (rnd() < 0.5) { if (b < 32) lo |= 1 << b; else hi |= 1 << (b - 32); }
    }
    const r = matchGlyph([lo >>> 0, hi >>> 0]);
    expect(r.confidence).toBeLessThan(0.6);
  });
});

describe("handwriting metrics", () => {
  // synthetic right-leaning strokes: vertical bars sheared so tops shift right
  function slantedBars(deg: number): GrayImage {
    const w = 220, h = 110;
    const img = grayImage(w, h);
    img.d.fill(255);
    const t = Math.tan((deg * Math.PI) / 180);
    for (let b = 0; b < 8; b++) {
      const x0 = 15 + b * 25;
      for (let y = 10; y < 100; y++) {
        const xc = Math.round(x0 + (55 - y) * t); // top (small y) shifts right for deg>0
        for (let dx = -3; dx <= 3; dx++) {
          const x = xc + dx;
          if (x >= 0 && x < w) img.d[y * w + x] = 0;
        }
      }
    }
    return img;
  }

  test("slant sign: right-leaning strokes give positive slant", () => {
    const r = ocrGrayImage(slantedBars(10));
    expect(r.metrics.slantDeg).toBeGreaterThan(4);
  });

  test("slant sign: left-leaning strokes give negative slant", () => {
    const r = ocrGrayImage(slantedBars(-10));
    expect(r.metrics.slantDeg).toBeLessThan(-4);
  });

  test("stroke width median approximates the bar width", () => {
    const r = ocrGrayImage(slantedBars(0));
    expect(Math.abs(r.metrics.slantDeg)).toBeLessThan(4);
    expect(r.metrics.strokeMedian).toBeGreaterThan(3);
    expect(r.metrics.strokeMedian).toBeLessThan(12);
  });

  test("script detection flags messy low-confidence strokes", () => {
    // cursive-like: jagged random-walk "words" with pen lifts between them and
    // variable thickness ("pressure") -> blobs that match templates poorly
    const w = 340, h = 200;
    const img = grayImage(w, h);
    img.d.fill(255);
    const rnd = lcg(5);
    const dot = (x: number, y: number, r: number) => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.round(x + dx), yy = Math.round(y + dy);
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && dx * dx + dy * dy <= r * r) {
            img.d[yy * w + xx] = 0;
          }
        }
      }
    };
    for (let line = 0; line < 3; line++) {
      const yBase = 30 + line * 60;
      let x = 12;
      while (x < w - 50) {
        let px = x, py = yBase + (rnd() - 0.5) * 8; // one "word": jagged walk
        const steps = 14 + Math.floor(rnd() * 14);
        for (let s = 0; s < steps; s++) {
          px += 2 + rnd() * 3;
          py += (rnd() - 0.5) * 14 + (yBase - py) * 0.25; // wander, pulled to baseline
          if (rnd() < 0.18) py += (rnd() < 0.5 ? -1 : 1) * (8 + rnd() * 10); // ascender/descender
          dot(px, py, 1 + Math.floor(rnd() * 3)); // variable "pressure"
        }
        x = px + 14 + rnd() * 18; // pen lift: gap before the next word
      }
    }
    const r = ocrGrayImage(img);
    expect(r.metrics.lines).toBeGreaterThanOrEqual(2);
    expect(r.metrics.chars).toBeGreaterThanOrEqual(6);
    expect(r.confidence).toBeLessThan(0.72); // below the "mixed" script threshold
    expect(["handwriting", "mixed"]).toContain(r.script);
  });
});

describe("graceful failures", () => {
  test("webp bytes -> webp error, not a throw", () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3]);
    expect(detectKind(webp)).toBe("webp");
    const r = ocrBytes(webp);
    expect(r.error).toBe("webp");
    expect(r.text).toBe("");
  });

  test("garbage bytes -> decode error, not a throw", () => {
    const r = ocrBytes(new Uint8Array([9, 9, 9, 9, 9]));
    expect(r.error).toBe("decode");
  });

  test("blank image -> empty text, zero confidence", () => {
    const img = grayImage(100, 60);
    img.d.fill(255);
    const r = ocrGrayImage(img);
    expect(r.text).toBe("");
    expect(r.confidence).toBe(0);
  });
});
