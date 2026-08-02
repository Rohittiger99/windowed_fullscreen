/**
 * Minimal, dependency-free PNG reader/writer used to normalize rendered store
 * assets.
 *
 * Chrome's screenshot output is RGBA (colour type 6). The Chrome Web Store asks
 * for 24-bit PNGs with no alpha channel, so every rendered asset is decoded,
 * flattened onto an opaque background, and re-encoded as colour type 2
 * (truecolour, no alpha).
 *
 * Scope is deliberately narrow: 8-bit-per-channel, non-interlaced PNGs, which is
 * exactly what Chrome produces. Anything else throws rather than guessing.
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel for the colour types we support. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Read a PNG's dimensions without decoding pixel data. */
export function readSize(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("Not a PNG file");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Split a PNG into its chunks, in file order. */
function readChunks(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("Not a PNG file");
  }
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

/** Undo a single PNG scanline filter in place. `bpp` is bytes per pixel. */
function unfilter(type, line, previous, bpp) {
  switch (type) {
    case 0:
      break;
    case 1: // Sub
      for (let i = bpp; i < line.length; i += 1) {
        line[i] = (line[i] + line[i - bpp]) & 0xff;
      }
      break;
    case 2: // Up
      for (let i = 0; i < line.length; i += 1) {
        line[i] = (line[i] + previous[i]) & 0xff;
      }
      break;
    case 3: // Average
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      break;
    case 4: // Paeth
      for (let i = 0; i < line.length; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = previous[i];
        const c = i >= bpp ? previous[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
      break;
    default:
      throw new Error(`Unsupported PNG filter type ${type}`);
  }
  return line;
}

/**
 * Decode an 8-bit, non-interlaced PNG to `{ width, height, pixels }` where
 * `pixels` is tightly packed RGB or RGBA depending on the source colour type.
 */
export function decode(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("PNG is missing its IHDR chunk");

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data.readUInt8(8);
  const colourType = ihdr.data.readUInt8(9);
  const interlace = ihdr.data.readUInt8(12);

  if (depth !== 8) throw new Error(`Unsupported PNG bit depth ${depth}`);
  if (interlace !== 0) throw new Error("Interlaced PNGs are not supported");
  const bpp = CHANNELS[colourType];
  if (!bpp) throw new Error(`Unsupported PNG colour type ${colourType}`);

  const raw = inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)),
  );

  const stride = width * bpp;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filterType = raw[start];
    const line = raw.subarray(start + 1, start + 1 + stride);
    unfilter(filterType, line, previous, bpp);
    line.copy(pixels, y * stride);
    previous = line;
  }

  return { width, height, channels: bpp, pixels };
}

/** CRC-32, table built once on first use. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode tightly packed RGB pixel data as a 24-bit, non-interlaced PNG. */
export function encodeRgb({ width, height, pixels }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour, no alpha
  // compression / filter / interlace default to 0.

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Flatten a PNG onto an opaque background and re-encode it without an alpha
 * channel. Already-opaque RGB input is re-encoded unchanged.
 */
export function stripAlpha(buffer, background = [0x19, 0x19, 0x18]) {
  const { width, height, channels, pixels } = decode(buffer);
  if (channels === 3) return encodeRgb({ width, height, pixels });
  if (channels !== 4) {
    throw new Error(`Cannot strip alpha from ${channels}-channel PNG`);
  }

  const out = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; i < pixels.length; i += 4, o += 3) {
    const alpha = pixels[i + 3] / 255;
    for (let c = 0; c < 3; c += 1) {
      out[o + c] = Math.round(pixels[i + c] * alpha + background[c] * (1 - alpha));
    }
  }
  return encodeRgb({ width, height, pixels: out });
}
