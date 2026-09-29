/** Writing and reading just enough PNG for a rig to have a PHOTOGRAPH.
 *
 *  WHY THIS EXISTS. `peak_rss_mb` with a picture open has never been measured,
 *  and the only picture in this harness is `fixtures/demo-portrait.png` at
 *  3.7 kB -- a file whose decode, downscale and data URI together cost less
 *  than the noise in the figure. Measuring memory against it would produce a
 *  number and answer nothing, which is the shape this repo has already recorded
 *  seven times. A memory instrument needs the thing a writer actually attaches:
 *  several megapixels off a camera.
 *
 *  GENERATED AND NOT COMMITTED, deliberately. A multi-megabyte binary in a
 *  fixtures directory is a file every future clone pays for and nobody can
 *  diff; a generator is forty lines that a test can falsify. It also lets the
 *  rig state the dimensions it is measuring against in its own source, where a
 *  reader of the result can find them.
 *
 *  THE READER IS NOT DERIVED FROM THE WRITER beyond the format itself: `pngSize`
 *  parses IHDR out of arbitrary bytes and is used on files the HOST wrote (the
 *  regenerated thumbnail), never on this module's own output in the rig. It is
 *  the same rule `markdown-read.ts` follows -- a reader built from the emitter
 *  checks the emitter against itself.
 */

/** The eight bytes every PNG starts with. */
export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Colour type 2: three 8-bit channels, no palette and no alpha. The smallest
 *  encoding the host's sniff/decode path accepts that is still a real
 *  photograph's shape. */
const COLOUR_TYPE_RGB = 2;
const BIT_DEPTH = 8;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a PNG chunk carries, over its type bytes and its data.
 *
 *  Exported so a test can check it against a known vector rather than against
 *  this module's own answer: a checksum verified only by round-tripping through
 *  the function that computes it is a checksum nobody has checked. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The Adler-32 a zlib stream carries over its UNCOMPRESSED bytes.
 *
 *  Exported for the same reason `crc32` is: checked against a published vector,
 *  not against a round trip through the function that computes it. */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A raw DEFLATE stream wrapped as zlib (RFC 1950), which is what a PNG's IDAT
 *  chunk holds.
 *
 *  THIS WRAPPER IS THE WHOLE BUG THIS MODULE ALREADY SHIPPED ONCE. `Bun.deflateSync`
 *  returns RAW deflate, and the first version of `writePng` put it into IDAT
 *  unwrapped. Every test passed -- because they inflated it with `Bun.inflateSync`,
 *  which accepts raw, so the reader and the writer agreed with each other about a
 *  file no PNG decoder would take. The host answered `unreadable`, the panel drew
 *  no picture, and the rig's own guard is what caught it. The recorded rule, hit
 *  again: when two implementations agree on your fixture, the test is about the
 *  fixture. `png.test.ts` now checks the stream with `node:zlib`, which refuses a
 *  missing header.
 *
 *  0x78 0x01: deflate, 32 KiB window, no preset dictionary, and FCHECK chosen so
 *  the two bytes read as a big-endian multiple of 31. */
function zlibWrap(raw: Uint8Array, deflated: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + deflated.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(deflated, 2);
  out.set(be32(adler32(raw)), 2 + deflated.length);
  return out;
}

function be32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  if (typeBytes.length !== 4) throw new Error(`chunk type ${type} is not four bytes`);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 4 + body.length);
  return out;
}

/** What colour a pixel is. Takes the coordinates so a caller can make an image
 *  whose blocks are not uniform -- the recorded downscale-fixture rule: a
 *  fixture whose every block is one colour cannot tell a box filter from
 *  nearest neighbour, and a photograph that compresses to nothing is not a
 *  photograph's memory cost either. */
export type PixelFn = (x: number, y: number) => readonly [number, number, number];

/** An 8-bit RGB PNG of `width` x `height`, filter 0 on every scanline.
 *
 *  No interlacing, no palette, no ancillary chunks: the decoders this is fed to
 *  are the host's, and anything beyond the minimum would be the generator
 *  testing the decoder rather than the application. */
export function writePng(width: number, height: number, pixel: PixelFn): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`writePng: ${width}x${height} is not a picture`);
  }
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    // Filter type 0 (None). A real encoder would pick per row; picking one
    // costs the harness nothing and keeps this falsifiable by hand.
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const at = row + 1 + x * 3;
      raw[at] = r & 0xff;
      raw[at + 1] = g & 0xff;
      raw[at + 2] = b & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = BIT_DEPTH;
  ihdr[9] = COLOUR_TYPE_RGB;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const idat = zlibWrap(raw, Bun.deflateSync(raw));
  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface PngSize {
  width: number;
  height: number;
}

/** The dimensions in a PNG's IHDR, or null when the bytes are not a PNG.
 *
 *  NULL RATHER THAN A THROW, and null rather than zeros: a rig grading a file
 *  the host wrote has to tell "the host wrote something that is not a picture"
 *  apart from "the host wrote a 0x0 picture", and a gate reading 0 for both
 *  would report the wrong defect. */
export function pngSize(bytes: Uint8Array): PngSize | null {
  // 8 signature + 4 length + 4 type + 8 of IHDR's payload.
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  // IHDR must be the first chunk; a PNG whose first chunk is anything else is
  // malformed, and reading a length out of it would be reading a number out of
  // whatever it is instead.
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const read = (at: number): number =>
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  const width = read(16);
  const height = read(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
