import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { adler32, crc32, PNG_SIGNATURE, pngSize, writePng } from "../src/png";

/** A gradient, so no two adjacent blocks are the same colour. A fixture whose
 *  every block is uniform is the recorded downscale trap, and a picture that is
 *  one flat colour also deflates to nothing -- which would make the memory
 *  fixture cheap in exactly the dimension it exists to be expensive in. */
const gradient = (x: number, y: number): readonly [number, number, number] => [
  x & 0xff,
  y & 0xff,
  (x + y) & 0xff,
];

describe("crc32", () => {
  // KNOWN VECTORS, not a round trip through this module. A checksum checked
  // only against itself is a checksum nobody has checked, and every mutation of
  // the table or the loop would agree with such a test.
  test("the empty input is 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
  test('"123456789" is the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  test('"IEND" with no payload is the constant every PNG ends with', () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });
  test("a one-byte change changes the answer", () => {
    expect(crc32(new Uint8Array([1, 2, 3]))).not.toBe(crc32(new Uint8Array([1, 2, 4])));
  });
});

describe("adler32", () => {
  // Published vectors again, for `crc32`'s reason.
  test("the empty input is 1", () => {
    expect(adler32(new Uint8Array(0))).toBe(1);
  });
  test('"Wikipedia" is 0x11E60398', () => {
    expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11e60398);
  });
  test("an input long enough to wrap the modulus", () => {
    // A MUTATION IS WHY THIS EXISTS. `% 65521` -> `% 65536` survived the three
    // vectors above, because none of them accumulates past 65521 -- so every
    // one of them was a fact about the fixture rather than about the modulus.
    // 400 bytes of "a" does wrap it. The expected value comes from zlib
    // (`zlib.adler32(b"a" * 400)`), an implementation this module knows nothing
    // about.
    expect(adler32(new Uint8Array(400).fill(0x61))).toBe(0xbcc29791);
    // And a longer one whose SUM passes 65521, so the a accumulator wraps too.
    // 400 bytes of "a" total 38,800 and leave `a` untouched by its modulus,
    // which is how the first attempt at this test still survived the mutation
    // it was written for. `zlib.adler32(b"\xff" * 1000)`.
    expect(adler32(new Uint8Array(1000).fill(0xff))).toBe(0xe6e9e446);
  });

  test("order matters, so a byte swap changes the answer", () => {
    // The b accumulator is the only thing that sees order. Without it a sum
    // would agree on both, which is the whole reason Adler-32 has two halves.
    expect(adler32(new Uint8Array([1, 2]))).not.toBe(adler32(new Uint8Array([2, 1])));
  });
});

describe("writePng", () => {
  test("starts with the PNG signature", () => {
    const bytes = writePng(4, 3, gradient);
    expect(Array.from(bytes.slice(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
  });

  test("carries the asked-for dimensions in its header", () => {
    // NOT SQUARE and not equal to each other: a width/height swap is the
    // likeliest defect here and a square fixture cannot see one.
    const size = pngSize(writePng(37, 11, gradient));
    expect(size).toEqual({ width: 37, height: 11 });
  });

  test("declares eight-bit RGB, no interlace", () => {
    // The header the HOST's decoder reads. A wrong colour type or bit depth
    // makes a file every check above still accepts and no picture library will
    // read the way the pixels were actually written -- the same class of defect
    // as the raw-deflate IDAT, one field along.
    const bytes = writePng(4, 3, gradient);
    expect(Array.from(bytes.slice(24, 29))).toEqual([8, 2, 0, 0, 0]);
  });

  test("ends with IEND", () => {
    const bytes = writePng(2, 2, gradient);
    const tail = new TextDecoder().decode(bytes.slice(bytes.length - 8, bytes.length - 4));
    expect(tail).toBe("IEND");
  });

  test("every chunk's CRC checks out", () => {
    // Walks the file the way a decoder does, so a chunk written with the wrong
    // length or the CRC taken over the wrong span fails here rather than in a
    // GUI run an hour later.
    const bytes = writePng(9, 5, gradient);
    let at = PNG_SIGNATURE.length;
    const seen: string[] = [];
    while (at < bytes.length) {
      const length =
        ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
      const type = new TextDecoder().decode(bytes.slice(at + 4, at + 8));
      const body = bytes.slice(at + 4, at + 8 + length);
      const stored =
        ((bytes[at + 8 + length]! << 24) |
          (bytes[at + 9 + length]! << 16) |
          (bytes[at + 10 + length]! << 8) |
          bytes[at + 11 + length]!) >>>
        0;
      expect(crc32(body)).toBe(stored);
      seen.push(type);
      at += 12 + length;
    }
    expect(seen).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(at).toBe(bytes.length);
  });

  test("the pixels round-trip through the deflate stream", () => {
    // The one assertion that reaches the scanline loop. Without it a writer
    // that emitted the right chunks over the wrong bytes passes everything
    // above -- and the host would then decode a picture nobody chose.
    const width = 5;
    const height = 4;
    const bytes = writePng(width, height, gradient);
    let at = PNG_SIGNATURE.length;
    let idat: Uint8Array | null = null;
    while (at < bytes.length) {
      const length =
        ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
      const type = new TextDecoder().decode(bytes.slice(at + 4, at + 8));
      if (type === "IDAT") idat = bytes.slice(at + 8, at + 8 + length);
      at += 12 + length;
    }
    expect(idat).not.toBeNull();
    // `node:zlib`'s inflateSync, NEVER `Bun.inflateSync`. Bun's accepts a RAW
    // deflate stream, so the first version of this test round-tripped a file
    // through a reader that agreed with the writer about an IDAT no PNG decoder
    // would take -- the whole `zlibWrap` story. This one refuses a missing zlib
    // header, which is the property the host's decoder actually needs.
    const raw = new Uint8Array(inflateSync(Buffer.from(idat!)));
    expect(raw.length).toBe(height * (width * 3 + 1));
    for (let y = 0; y < height; y++) {
      const row = y * (width * 3 + 1);
      expect(raw[row]).toBe(0);
      for (let x = 0; x < width; x++) {
        expect([raw[row + 1 + x * 3], raw[row + 2 + x * 3], raw[row + 3 + x * 3]]).toEqual([
          ...gradient(x, y),
        ]);
      }
    }
  });

  test("a megapixel gradient is a file with real bytes in it", () => {
    // The property the memory fixture actually depends on: a picture that
    // deflates to nothing costs the host nothing to hold. Two orders of
    // magnitude below the raw size and this is no longer a photograph.
    const bytes = writePng(600, 400, gradient);
    expect(bytes.length).toBeGreaterThan(50_000);
  });

  test("refuses a size that is not a picture", () => {
    expect(() => writePng(0, 10, gradient)).toThrow();
    expect(() => writePng(10, -1, gradient)).toThrow();
    expect(() => writePng(1.5, 10, gradient)).toThrow();
  });
});

describe("pngSize", () => {
  test("refuses bytes that are not a PNG", () => {
    expect(pngSize(new TextEncoder().encode("this is not a picture at all!!!"))).toBeNull();
  });

  test("refuses a truncated file", () => {
    expect(pngSize(writePng(4, 4, gradient).slice(0, 20))).toBeNull();
  });

  test("refuses a header that stops inside the height field", () => {
    // ALSO A MUTATION'S DOING. Lowering the 24-byte floor to 8 survived the
    // truncated-file test above, because a 20-byte slice leaves the height
    // bytes reading as zero and the zero-dimension refusal catches it anyway --
    // two rules covering for each other, the recorded shape. A height whose
    // HIGH byte is inside the file and whose low bytes are not reads as a real
    // number, and only the length floor refuses it.
    const bytes = new Uint8Array(22);
    bytes.set(PNG_SIGNATURE, 0);
    bytes.set([0, 0, 0, 13], 8);
    bytes.set(new TextEncoder().encode("IHDR"), 12);
    bytes.set([0, 0, 0x03, 0xe8], 16); // width 1000
    bytes.set([0, 1], 20); // the top half of a height of 70000; the rest is gone
    expect(pngSize(bytes)).toBeNull();
  });

  test("refuses a PNG whose first chunk is not IHDR", () => {
    // The signature alone is not the format. A file that opens correctly and
    // then holds something else would otherwise have a length read out of
    // whatever that something is and reported as dimensions.
    const bytes = writePng(4, 4, gradient);
    bytes[12] = "s".charCodeAt(0);
    bytes[13] = "R".charCodeAt(0);
    bytes[14] = "G".charCodeAt(0);
    bytes[15] = "B".charCodeAt(0);
    expect(pngSize(bytes)).toBeNull();
  });

  test("a zero dimension is not a size", () => {
    const bytes = writePng(4, 4, gradient);
    bytes[16] = 0;
    bytes[17] = 0;
    bytes[18] = 0;
    bytes[19] = 0;
    expect(pngSize(bytes)).toBeNull();
  });

  test("reads a dimension past one byte", () => {
    // 1000 needs two bytes and 70000 needs three, so a reader that only ever
    // took the low byte would pass every small fixture above.
    expect(pngSize(writePng(1000, 300, gradient))).toEqual({ width: 1000, height: 300 });
  });
});
