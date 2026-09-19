// ocr.ts — a tiny self-contained OCR engine. Zero dependencies.
//
// Decodes PNG and baseline JPEG from scratch, then runs a classical pipeline:
//   grayscale -> polarity -> Otsu binarization -> deskew ->
//   line segmentation -> char segmentation -> 5x7 template matching.
//
// Honest limits: this is good for straight-on photos of printed/typed text.
// Handwriting gets low-confidence best-guess transcriptions — the engine says
// so via the confidence score and the `script` field. WebP is accepted for
// upload but not decoded for OCR (graceful error, not a crash).

export interface GrayImage { w: number; h: number; d: Float32Array } // 0..255
export interface BinImage { w: number; h: number; d: Uint8Array } // 1 = ink

export interface OcrLine { text: string; confidence: number }
export interface HandMetrics {
  slantDeg: number;        // + = leans right, - = leans left
  strokeMedian: number;    // px, pressure proxy
  strokeStd: number;
  heightMean: number;      // px
  heightStd: number;
  spacingRatio: number;    // median word gap / median char gap
  baselineDrift: number;   // degrees, + = downhill to the right
  inkDensity: number;      // 0..1
  chars: number; words: number; lines: number;
}
export interface OcrResult {
  text: string;
  lines: OcrLine[];
  confidence: number;      // 0..1
  script: "print" | "handwriting" | "mixed";
  metrics: HandMetrics;
  error?: "webp" | "decode";
}

export function grayImage(w: number, h: number, d?: Float32Array): GrayImage {
  return { w, h, d: d || new Float32Array(w * h) };
}

// ---- utils ------------------------------------------------------------------
export function crc32(bytes: Uint8Array): number {
  let table = (crc32 as any)._t as Int32Array | undefined;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as any)._t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function detectKind(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return null;
}

// ---- PNG decoder --------------------------------------------------------------
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): GrayImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  while (pos + 8 <= bytes.length) {
    const len = u32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = u32(data, 0); height = u32(data, 4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "PLTE") { palette = data; }
    else if (type === "IDAT") { idat.push(data); }
    else if (type === "IEND") { break; }
    pos += 12 + len;
  }
  if (!width || !height) throw new Error("PNG missing IHDR");
  if (interlace) throw new Error("interlaced PNG not supported");
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} not supported`);
  const ch = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!ch) throw new Error(`PNG color type ${colorType} not supported`);
  if (colorType === 3 && !palette) throw new Error("PNG palette missing");

  const raw = Bun.inflateSync(concat(idat));
  const stride = width * ch;
  const out = new Float32Array(width * height);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const v = raw[p++];
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let r: number;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = (v + a) & 255; break;
        case 2: r = (v + b) & 255; break;
        case 3: r = (v + ((a + b) >> 1)) & 255; break;
        case 4: r = (v + paeth(a, b, c)) & 255; break;
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      cur[i] = r;
    }
    for (let x = 0; x < width; x++) {
      const o = x * ch;
      let g: number;
      if (colorType === 0) g = cur[o];
      else if (colorType === 2) g = 0.299 * cur[o] + 0.587 * cur[o + 1] + 0.114 * cur[o + 2];
      else if (colorType === 3) { const pi = cur[o] * 3; g = 0.299 * palette![pi] + 0.587 * palette![pi + 1] + 0.114 * palette![pi + 2]; }
      else if (colorType === 4) g = cur[o];
      else g = 0.299 * cur[o] + 0.587 * cur[o + 1] + 0.114 * cur[o + 2]; // type 6, ignore alpha
      out[y * width + x] = g;
    }
    prev.set(cur);
  }
  return { w: width, h: height, d: out };
}

// ---- baseline JPEG decoder ------------------------------------------------------
// Supports SOF0 (baseline DCT), 1 or 3 components, sampling factors 1-2,
// 8-bit. Progressive (SOF2) and arithmetic coding are rejected with a clear error.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48,
  41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15,
  23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

interface HuffTable { map: Map<number, number> }
function buildHuffman(counts: Uint8Array, symbols: Uint8Array): HuffTable {
  const map = new Map<number, number>();
  let code = 0, si = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      map.set((len << 24) | code, symbols[si++]);
      code++;
    }
    code <<= 1;
  }
  return { map };
}

class JpegBitReader {
  d: Uint8Array; pos: number; buf = 0; nbits = 0;
  onRestart: () => void;
  constructor(d: Uint8Array, onRestart: () => void) { this.d = d; this.pos = 0; this.onRestart = onRestart; }
  getBit(): number {
    if (this.nbits === 0) {
      let b = this.d[this.pos++];
      if (b === 0xff) {
        const m = this.d[this.pos++];
        if (m === 0x00) { /* stuffed 0xff, data continues */ }
        else if (m >= 0xd0 && m <= 0xd7) { this.nbits = 0; this.onRestart(); return this.getBit(); }
        else throw new Error(`unexpected JPEG marker ff${m.toString(16)} in scan`);
      }
      this.buf = b; this.nbits = 8;
    }
    this.nbits--;
    return (this.buf >> this.nbits) & 1;
  }
  getBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.getBit();
    return v;
  }
  huff(t: HuffTable): number {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | this.getBit();
      const s = t.map.get((len << 24) | code);
      if (s !== undefined) return s;
    }
    throw new Error("bad Huffman code in JPEG scan");
  }
}

function jpegExtend(v: number, s: number): number {
  return s === 0 ? 0 : v < (1 << (s - 1)) ? v - ((1 << s) - 1) : v;
}

// IDCT with a precomputed cosine table.
const IDCOS: Float64Array = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();
const SQRT1_2 = Math.SQRT1_2;
function idct(block: Float64Array): void {
  const out = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) {
        const cv = v === 0 ? SQRT1_2 : 1, cy = IDCOS[y * 8 + v];
        for (let u = 0; u < 8; u++) {
          s += (u === 0 ? SQRT1_2 : 1) * cv * block[v * 8 + u] * IDCOS[x * 8 + u] * cy;
        }
      }
      out[y * 8 + x] = s / 4;
    }
  }
  block.set(out);
}

interface JpegComp { id: number; h: number; v: number; tq: number; td: number; ta: number }

export function decodeJpeg(bytes: Uint8Array): GrayImage {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
  let pos = 2;
  const u16 = () => { const v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return v; };
  let width = 0, height = 0;
  const quant: Float64Array[] = [];
  const huffDC: HuffTable[] = [], huffAC: HuffTable[] = [];
  let comps: JpegComp[] = [];
  let scanData = new Uint8Array(0);
  let restartInterval = 0;

  const isRst = (b: number) => b >= 0xd0 && b <= 0xd7;
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    let m = bytes[pos + 1];
    while (m === 0xff) { pos++; m = bytes[pos + 1]; }
    pos += 2;
    if (m === 0xd8 || m === 0x01) continue;
    if (m === 0xd9) break;
    if (isRst(m)) continue;
    if (m === 0xc2) throw new Error("progressive JPEG not supported");
    const len = u16();
    const end = pos + len - 2;
    if (m === 0xc0) {
      height = (bytes[pos + 1] << 8) | bytes[pos + 2];
      width = (bytes[pos + 3] << 8) | bytes[pos + 4];
      const n = bytes[pos + 5];
      comps = [];
      for (let i = 0; i < n; i++) {
        const o = pos + 6 + i * 3;
        comps.push({ id: bytes[o], h: bytes[o + 1] >> 4, v: bytes[o + 1] & 15, tq: bytes[o + 2], td: 0, ta: 0 });
      }
      if (![1, 3].includes(n)) throw new Error(`JPEG with ${n} components not supported`);
    } else if (m === 0xdb) {
      let q = pos;
      while (q < end) {
        const info = bytes[q++], tq = info & 15, is16 = (info >> 4) === 1;
        const table = new Float64Array(64);
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]] = is16 ? (bytes[q] << 8) | bytes[q + 1] : bytes[q];
          q += is16 ? 2 : 1;
        }
        quant[tq] = table;
      }
    } else if (m === 0xc4) {
      let q = pos;
      while (q < end) {
        const info = bytes[q++], tc = info >> 4, th = info & 15;
        const counts = bytes.slice(q, q + 16); q += 16;
        const total = counts.reduce((a, b) => a + b, 0);
        const symbols = bytes.slice(q, q + total); q += total;
        const t = buildHuffman(counts, symbols);
        if (tc === 0) huffDC[th] = t; else huffAC[th] = t;
      }
    } else if (m === 0xdd) {
      restartInterval = (bytes[pos] << 8) | bytes[pos + 1];
    } else if (m === 0xda) {
      const n = bytes[pos];
      for (let i = 0; i < n; i++) {
        const o = pos + 1 + i * 2, cs = bytes[o];
        const comp = comps.find((c) => c.id === cs);
        if (!comp) throw new Error("JPEG SOS references unknown component");
        comp.td = bytes[o + 1] >> 4; comp.ta = bytes[o + 1] & 15;
      }
      const start = pos + 1 + n * 2 + 3; // skip Ss, Se, Ah/Al
      // find scan end: 0xff not followed by 0x00, RSTn, or fill 0xff
      let e = start;
      while (e < bytes.length - 1) {
        if (bytes[e] === 0xff) {
          const nx = bytes[e + 1];
          if (nx === 0x00 || isRst(nx) || nx === 0xff) { e += nx === 0xff ? 1 : 2; continue; }
          break;
        }
        e++;
      }
      scanData = bytes.slice(start, e);
      pos = e;
      continue;
    }
    pos = end;
  }
  if (!width || !height) throw new Error("JPEG missing SOF0");
  for (const c of comps) {
    if (!quant[c.tq] || !huffDC[c.td] || !huffAC[c.ta]) throw new Error("JPEG missing tables");
  }

  const maxH = Math.max(...comps.map((c) => c.h)), maxV = Math.max(...comps.map((c) => c.v));
  const mcuCols = Math.ceil(width / (8 * maxH)), mcuRows = Math.ceil(height / (8 * maxV));
  // per-component pixel planes (Y only is kept for output; chroma decoded to advance the stream)
  const planes = comps.map((c) => {
    const bw = Math.ceil((width * c.h) / (8 * maxH)), bh = Math.ceil((height * c.v) / (8 * maxV));
    return { comp: c, bw, bh, px: new Float32Array(bw * 8 * bh * 8) };
  });
  const prevDC = new Array(comps.length).fill(0);
  const br = new JpegBitReader(scanData, () => { for (let i = 0; i < prevDC.length; i++) prevDC[i] = 0; });
  const block = new Float64Array(64);
  let mcuCount = 0;

  for (let my = 0; my < mcuRows; my++) {
    for (let mx = 0; mx < mcuCols; mx++) {
      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci], pl = planes[ci];
        const tdc = huffDC[c.td], tac = huffAC[c.ta], qt = quant[c.tq];
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            block.fill(0);
            const s = br.huff(tdc);
            prevDC[ci] += jpegExtend(br.getBits(s), s);
            block[0] = prevDC[ci] * qt[0];
            let k = 1;
            while (k < 64) {
              const rs = br.huff(tac), r = rs >> 4, ss = rs & 15;
              if (ss === 0) { if (r === 15) { k += 16; continue; } break; }
              k += r;
              if (k >= 64) break;
              block[ZIGZAG[k]] = jpegExtend(br.getBits(ss), ss) * qt[ZIGZAG[k]];
              k++;
            }
            if (ci === 0) {
              // only the luma plane is needed for OCR
              idct(block);
              const ox = (mx * c.h + bx) * 8, oy = (my * c.v + by) * 8;
              const stride = pl.bw * 8;
              for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 8; x++) {
                  const v = block[y * 8 + x] + 128;
                  pl.px[(oy + y) * stride + ox + x] = v < 0 ? 0 : v > 255 ? 255 : v;
                }
              }
            }
          }
        }
      }
      mcuCount++;
      void mcuCount;
    }
  }
  void restartInterval; // tolerated via RSTn handling in the bit reader
  const yPlane = planes[0].px, yStride = planes[0].bw * 8;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = yPlane[y * yStride + x];
  }
  return { w: width, h: height, d: out };
}

// ---- hand-authored 5x7 bitmap font ------------------------------------------------
// Each glyph: 7 rows of 5 chars, "#" = ink. Uppercase letters, digits, punctuation.

export const GLYPHS: Record<string, string[]> = {
  "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  "C": [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  "D": ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
  "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  "G": [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
  "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "I": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  "J": ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  "N": ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"],
  "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#..##", "#.#.#", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "'": ["..#..", "..#..", ".....", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  ";": [".....", ".##..", ".##..", ".....", ".##..", ".##..", ".#..."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  "$": ["..#..", ".####", "#.#..", ".###.", "..#.#", "####.", "..#.."],
  "%": ["##..#", "##..#", "...#.", "..#..", ".#...", "#..##", "#..##"],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
};

// Packed bitmasks: [lo32, hi3] per glyph.
const FONT: Map<string, [number, number]> = (() => {
  const m = new Map<string, [number, number]>();
  for (const [ch, rows] of Object.entries(GLYPHS)) {
    let lo = 0, hi = 0;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (rows[r][c] === "#") {
          const bit = r * 5 + c;
          if (bit < 32) lo |= 1 << bit; else hi |= 1 << (bit - 32);
        }
      }
    }
    m.set(ch, [lo >>> 0, hi >>> 0]);
  }
  return m;
})();

function popcount32(x: number): number {
  x >>>= 0;
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Best template match for a 5x7 bitmask. Returns {char, confidence}. */
export function matchGlyph(mask: [number, number]): { char: string; confidence: number } {
  let best = "?", bestDist = 99;
  for (const [ch, [lo, hi]] of FONT) {
    const d = popcount32(mask[0] ^ lo) + popcount32(mask[1] ^ hi);
    if (d < bestDist) { bestDist = d; best = ch; }
  }
  // 24 = the distance at which a blob stops looking like any known glyph.
  return { char: best, confidence: Math.max(0, 1 - bestDist / 24) };
}

/** Render text with the built-in font into a grayscale image (for tests/synth). */
export function renderFontText(text: string, scale: number): GrayImage {
  const cw = 5 * scale, chh = 7 * scale, gap = scale, pad = scale;
  const adv = (ch: string) => (ch === " " ? 4 * scale : cw + gap);
  const w = pad * 2 + [...text].reduce((a, ch) => a + adv(ch), 0);
  const h = pad * 2 + chh;
  const img = grayImage(w, h);
  img.d.fill(255);
  let x = pad;
  for (const raw of text) {
    const ch = raw.toUpperCase();
    if (ch === " ") { x += adv(ch); continue; }
    const rows = GLYPHS[ch];
    if (rows) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (rows[r][c] === "#") {
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) {
                img.d[(pad + r * scale + dy) * w + x + c * scale + dx] = 0;
              }
            }
          }
        }
      }
    }
    x += adv(ch);
  }
  return img;
}

// ---- pipeline -------------------------------------------------------------------
const MAX_W = 1200;

export function downscale(img: GrayImage, maxW = MAX_W): GrayImage {
  if (img.w <= maxW) return img;
  const s = maxW / img.w, nw = maxW, nh = Math.max(1, Math.round(img.h * s));
  const out = grayImage(nw, nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x / s), x1 = Math.min(img.w - 1, Math.ceil((x + 1) / s));
      const y0 = Math.floor(y / s), y1 = Math.min(img.h - 1, Math.ceil((y + 1) / s));
      let sum = 0, n = 0;
      for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) { sum += img.d[sy * img.w + sx]; n++; }
      out.d[y * nw + x] = sum / n;
    }
  }
  return out;
}

/** Otsu's threshold on a grayscale image. */
export function otsu(img: GrayImage): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < img.d.length; i++) hist[Math.max(0, Math.min(255, Math.round(img.d[i])))]++;
  const total = img.d.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = -1, t0 = 0, t1 = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t0 = t1 = t; }
    else if (between === best) { t1 = t; } // plateau: take the middle
  }
  return Math.round((t0 + t1) / 2);
}

/** Binarize: ink (dark) = 1. Auto-detects polarity from the border. */
export function binarize(img: GrayImage): BinImage {
  let border = 0, n = 0;
  const f = 8;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (x < f || y < f || x >= img.w - f || y >= img.h - f) { border += img.d[y * img.w + x]; n++; }
    }
  }
  const lightBg = n === 0 || border / n >= 128;
  const t = otsu(img);
  const d = new Uint8Array(img.w * img.h);
  for (let i = 0; i < img.d.length; i++) {
    const ink = img.d[i] < t;
    d[i] = lightBg ? (ink ? 1 : 0) : ink ? 0 : 1;
  }
  return { w: img.w, h: img.h, d };
}

/** Remove tiny ink components (salt noise). Keeps 4-connected components >= minSize px. */
export function despeckle(bin: BinImage, minSize = 10): BinImage {
  const seen = new Uint8Array(bin.w * bin.h);
  const out = new Uint8Array(bin.w * bin.h);
  const stack: number[] = [];
  for (let i = 0; i < bin.d.length; i++) {
    if (!bin.d[i] || seen[i]) continue;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    const comp: number[] = [];
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % bin.w, y = (p / bin.w) | 0;
      if (x > 0 && bin.d[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x + 1 < bin.w && bin.d[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && bin.d[p - bin.w] && !seen[p - bin.w]) { seen[p - bin.w] = 1; stack.push(p - bin.w); }
      if (y + 1 < bin.h && bin.d[p + bin.w] && !seen[p + bin.w]) { seen[p + bin.w] = 1; stack.push(p + bin.w); }
    }
    if (comp.length >= minSize) for (const p of comp) out[p] = 1;
  }
  return { w: bin.w, h: bin.h, d: out };
}

function shearBinary(src: BinImage, s: number): BinImage {
  const off = s < 0 ? Math.ceil(-s * src.h) : 0;
  const w = src.w + Math.ceil(Math.abs(s) * src.h);
  const d = new Uint8Array(w * src.h);
  for (let y = 0; y < src.h; y++) {
    const shift = Math.round(s * y) + off;
    for (let x = 0; x < src.w; x++) {
      if (src.d[y * src.w + x]) d[y * w + x + shift] = 1;
    }
  }
  return { w, h: src.h, d };
}

/** Deskew by searching the shear angle that maximizes vertical-projection variance. */
export function deskew(src: BinImage): { img: BinImage; slantDeg: number } {
  const coords: number[] = [];
  for (let i = 0; i < src.d.length; i++) if (src.d[i]) coords.push(i);
  let bestDeg = 0, bestVar = -1;
  for (let deg = -12; deg <= 12; deg += 2) {
    const s = Math.tan((deg * Math.PI) / 180);
    const off = s < 0 ? Math.ceil(-s * src.h) : 0;
    const w = src.w + Math.ceil(Math.abs(s) * src.h);
    const cols = new Float64Array(w);
    for (const i of coords) {
      const x = i % src.w, y = (i / src.w) | 0;
      cols[x + Math.round(s * y) + off]++;
    }
    let mean = 0;
    for (let c = 0; c < w; c++) mean += cols[c];
    mean /= w;
    let v = 0;
    for (let c = 0; c < w; c++) { const dd = cols[c] - mean; v += dd * dd; }
    if (v > bestVar) { bestVar = v; bestDeg = deg; }
  }
  // the shear that straightens the text equals the text's own slant:
  // right-leaning strokes need a positive shear to become vertical.
  return { img: shearBinary(src, Math.tan((bestDeg * Math.PI) / 180)), slantDeg: bestDeg };
}

interface LineBand { y0: number; y1: number }

function findLines(bin: BinImage): LineBand[] {
  const rows = new Uint32Array(bin.h);
  for (let y = 0; y < bin.h; y++) {
    let c = 0;
    for (let x = 0; x < bin.w; x++) c += bin.d[y * bin.w + x];
    rows[y] = c;
  }
  const active = Math.max(2, bin.w * 0.002);
  const bands: LineBand[] = [];
  let y = 0;
  while (y < bin.h) {
    if (rows[y] < active) { y++; continue; }
    let y1 = y;
    while (y1 + 1 < bin.h && rows[y1 + 1] >= active) y1++;
    // merge small gaps
    let y2 = y1;
    while (y2 + 1 < bin.h && y2 + 1 - y1 < 4) {
      y2++;
      while (y2 + 1 < bin.h && rows[y2 + 1] >= active) y2++;
      if (rows[y2] >= active) y1 = y2;
    }
    if (y1 - y + 1 >= 6) bands.push({ y0: y, y1 });
    y = y2 + 1;
  }
  return bands;
}

interface CharBox { x0: number; x1: number; y0: number; y1: number; wordBreakAfter: boolean }

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function segmentLine(bin: BinImage, band: LineBand): CharBox[] {
  const cols = new Uint32Array(bin.w);
  for (let y = band.y0; y <= band.y1; y++) {
    for (let x = 0; x < bin.w; x++) cols[x] += bin.d[y * bin.w + x];
  }
  // ink runs
  const runs: { x0: number; x1: number }[] = [];
  let x = 0;
  while (x < bin.w) {
    if (!cols[x]) { x++; continue; }
    let x1 = x;
    while (x1 + 1 < bin.w && cols[x1 + 1]) x1++;
    runs.push({ x0: x, x1 });
    x = x1 + 1;
  }
  if (!runs.length) return [];
  const gaps = runs.slice(1).map((r, i) => r.x0 - runs[i].x1 - 1);
  const medGap = Math.max(1, median(gaps));
  const wordThresh = Math.max(12, 3 * medGap);
  // merge runs separated by tiny gaps into chars
  const chars: { x0: number; x1: number }[] = [];
  let cur = { ...runs[0] };
  const runGaps: number[] = [];
  for (let i = 1; i < runs.length; i++) {
    const g = runs[i].x0 - cur.x1 - 1;
    runGaps.push(g);
    if (g < 2) cur.x1 = runs[i].x1;
    else { chars.push(cur); cur = { ...runs[i] }; }
  }
  chars.push(cur);
  // split overly wide segments at their deepest valley
  const widths = chars.map((c) => c.x1 - c.x0 + 1);
  const medW = Math.max(4, median(widths));
  const split: { x0: number; x1: number }[] = [];
  for (const c of chars) {
    if (c.x1 - c.x0 + 1 > medW * 2.2) {
      let bx = -1, bv = Infinity;
      for (let sx = c.x0 + Math.floor(medW * 0.4); sx <= c.x1 - Math.floor(medW * 0.4); sx++) {
        if (cols[sx] < bv) { bv = cols[sx]; bx = sx; }
      }
      if (bx > 0) { split.push({ x0: c.x0, x1: bx }, { x0: bx + 1, x1: c.x1 }); continue; }
    }
    split.push(c);
  }
  // tight vertical bounds per char
  const out: CharBox[] = [];
  for (let i = 0; i < split.length; i++) {
    const c = split[i];
    let ty0 = band.y1, ty1 = band.y0;
    for (let yy = band.y0; yy <= band.y1; yy++) {
      for (let xx = c.x0; xx <= c.x1; xx++) {
        if (bin.d[yy * bin.w + xx]) { if (yy < ty0) ty0 = yy; if (yy > ty1) ty1 = yy; }
      }
    }
    if (ty1 < ty0) continue;
    const next = split[i + 1];
    const gapAfter = next ? next.x0 - c.x1 - 1 : 0;
    out.push({ x0: c.x0, x1: c.x1, y0: ty0, y1: ty1, wordBreakAfter: gapAfter >= wordThresh });
  }
  return out;
}

/** Normalize a char box to a 5x7 bitmask (packed [lo32, hi3]). */
function normalizeChar(bin: BinImage, box: CharBox): [number, number] {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
  let lo = 0, hi = 0;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      const sx0 = box.x0 + (c * w) / 5, sx1 = box.x0 + ((c + 1) * w) / 5;
      const sy0 = box.y0 + (r * h) / 7, sy1 = box.y0 + ((r + 1) * h) / 7;
      let ink = 0, n = 0;
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) {
        for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
          if (xx < 0 || yy < 0 || xx >= bin.w || yy >= bin.h) continue;
          ink += bin.d[yy * bin.w + xx]; n++;
        }
      }
      if (n > 0 && ink / n > 0.45) {
        const bit = r * 5 + c;
        if (bit < 32) lo |= 1 << bit; else hi |= 1 << (bit - 32);
      }
    }
  }
  return [lo >>> 0, hi >>> 0];
}

const emptyMetrics = (lines = 0): HandMetrics => ({
  slantDeg: 0, strokeMedian: 0, strokeStd: 0, heightMean: 0, heightStd: 0,
  spacingRatio: 0, baselineDrift: 0, inkDensity: 0, chars: 0, words: 0, lines,
});

/** Full OCR pipeline on an already-grayscale image. */
export function ocrGrayImage(img: GrayImage): OcrResult {
  const small = downscale(img);
  const bin = despeckle(binarize(small));
  const { img: desk, slantDeg } = deskew(bin);
  const bands = findLines(desk);

  const lines: OcrLine[] = [];
  const charHeights: number[] = [];
  const charGaps: number[] = [];
  const wordGaps: number[] = [];
  const drifts: { slope: number; w: number }[] = [];
  let totalConf = 0, totalChars = 0, inkPx = 0, areaPx = 0;

  for (const band of bands) {
    const chars = segmentLine(desk, band);
    if (!chars.length) continue;
    let text = "", confSum = 0, n = 0;
    const bottoms: { x: number; y: number }[] = [];
    for (let i = 0; i < chars.length; i++) {
      const box = chars[i];
      const mask = normalizeChar(desk, box);
      if (mask[0] === 0 && mask[1] === 0) continue; // blank
      const { char, confidence } = matchGlyph(mask);
      text += char; confSum += confidence; n++;
      charHeights.push(box.y1 - box.y0 + 1);
      bottoms.push({ x: (box.x0 + box.x1) / 2, y: box.y1 });
      if (i + 1 < chars.length) {
        const g = chars[i + 1].x0 - box.x1 - 1;
        (box.wordBreakAfter ? wordGaps : charGaps).push(g);
      }
      if (box.wordBreakAfter) text += " ";
    }
    text = text.replace(/ +/g, " ").trim();
    if (!text) continue;
    lines.push({ text, confidence: n ? confSum / n : 0 });
    totalConf += confSum; totalChars += n;
    // baseline drift: slope of char bottoms
    if (bottoms.length >= 3) {
      const mx = bottoms.reduce((a, b) => a + b.x, 0) / bottoms.length;
      const my = bottoms.reduce((a, b) => a + b.y, 0) / bottoms.length;
      let num = 0, den = 0;
      for (const b of bottoms) { num += (b.x - mx) * (b.y - my); den += (b.x - mx) * (b.x - mx); }
      if (den > 0) drifts.push({ slope: num / den, w: bottoms.length });
    }
    for (let y = band.y0; y <= band.y1; y++) {
      for (let x = 0; x < desk.w; x++) {
        inkPx += desk.d[y * desk.w + x];
      }
    }
    areaPx += (band.y1 - band.y0 + 1) * desk.w;
  }

  // stroke widths: horizontal ink run lengths, sampled every 3rd row
  const runs: number[] = [];
  for (let y = 0; y < desk.h; y += 3) {
    let x = 0;
    while (x < desk.w) {
      if (!desk.d[y * desk.w + x]) { x++; continue; }
      let x1 = x;
      while (x1 + 1 < desk.w && desk.d[y * desk.w + x1 + 1]) x1++;
      runs.push(x1 - x + 1);
      x = x1 + 1;
    }
  }
  const sMed = median(runs);
  const sMean = runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 0;
  const sStd = runs.length ? Math.sqrt(runs.reduce((a, b) => a + (b - sMean) * (b - sMean), 0) / runs.length) : 0;
  const hMean = charHeights.length ? charHeights.reduce((a, b) => a + b, 0) / charHeights.length : 0;
  const hStd = charHeights.length
    ? Math.sqrt(charHeights.reduce((a, b) => a + (b - hMean) * (b - hMean), 0) / charHeights.length) : 0;
  const medCharGap = median(charGaps), medWordGap = median(wordGaps);
  const driftW = drifts.reduce((a, d) => a + d.w, 0);
  const driftSlope = driftW ? drifts.reduce((a, d) => a + d.slope * d.w, 0) / driftW : 0;

  const confidence = totalChars ? totalConf / totalChars : 0;
  const strokeCV = sMed > 0 ? sStd / sMed : 0;
  const slantAbs = Math.abs(slantDeg);
  let script: OcrResult["script"] = "print";
  if (totalChars >= 3) {
    if (confidence < 0.58 && strokeCV > 0.5) script = "handwriting";
    else if (confidence < 0.72 && (strokeCV > 0.5 || slantAbs > 8)) script = "mixed";
  }

  const metrics: HandMetrics = {
    slantDeg: Math.round(slantDeg * 10) / 10,
    strokeMedian: Math.round(sMed * 10) / 10,
    strokeStd: Math.round(sStd * 10) / 10,
    heightMean: Math.round(hMean * 10) / 10,
    heightStd: Math.round(hStd * 10) / 10,
    spacingRatio: medCharGap > 0 ? Math.round((medWordGap / medCharGap) * 10) / 10 : 0,
    baselineDrift: Math.round((Math.atan(driftSlope) * 180) / Math.PI * 10) / 10,
    inkDensity: areaPx ? Math.round((inkPx / areaPx) * 1000) / 1000 : 0,
    chars: totalChars,
    words: lines.reduce((a, l) => a + l.text.split(" ").filter(Boolean).length, 0),
    lines: lines.length,
  };

  return {
    text: lines.map((l) => l.text).join("\n"),
    lines,
    confidence: Math.round(confidence * 1000) / 1000,
    script,
    metrics,
  };
}

/** Decode raw image bytes (PNG/JPEG) and run OCR. WebP -> graceful error result. */
export function ocrBytes(bytes: Uint8Array): OcrResult {
  const kind = detectKind(bytes);
  if (kind === "webp") {
    return { text: "", lines: [], confidence: 0, script: "print", metrics: emptyMetrics(), error: "webp" };
  }
  try {
    const img = kind === "png" ? decodePng(bytes) : kind === "jpeg" ? decodeJpeg(bytes) : null;
    if (!img) throw new Error("unrecognized image format");
    return ocrGrayImage(img);
  } catch (e: any) {
    return { text: "", lines: [], confidence: 0, script: "print", metrics: emptyMetrics(), error: "decode" };
  }
}

/** OCR an uploaded file on disk. */
export async function ocrUpload(path: string, mime: string): Promise<OcrResult> {
  if (mime === "image/webp") {
    return { text: "", lines: [], confidence: 0, script: "print", metrics: emptyMetrics(), error: "webp" };
  }
  try {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    return ocrBytes(bytes);
  } catch {
    return { text: "", lines: [], confidence: 0, script: "print", metrics: emptyMetrics(), error: "decode" };
  }
}
