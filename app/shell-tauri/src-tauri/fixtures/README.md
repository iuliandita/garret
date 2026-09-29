# Picture fixtures

Binary, and therefore not readable in a diff — so the recipe is here, because
this repo's rule is that fixtures stay REPRODUCIBLE. Each was produced once with
Pillow and checked in.

They are deliberately NOT written by this application's own PNG encoder: a
picture the encoder made would check the decoder against the encoder, which is
the recorded "a reader built from the emitter checks the exporter against
itself" shape.

    python3 - <<'PY'
    from PIL import Image
    import struct, zlib

    # two-halves: 6x4, left three columns pure red and right three pure blue, so
    # a downscale can be read by COLOUR rather than by byte count.
    im = Image.new("RGB", (6, 4))
    for y in range(4):
        for x in range(6):
            im.putpixel((x, y), (255, 0, 0) if x < 3 else (0, 0, 255))
    im.save("two-halves.png", "PNG", optimize=True)
    im.save("two-halves.jpg", "JPEG", quality=95)

    # black-and-clear: 2x1 RGBA, one opaque black pixel and one fully
    # transparent black one. Composited onto white the second is white; carried
    # through unchanged it is black, which is what a transparent background
    # renders as in the panel.
    a = Image.new("RGBA", (2, 1))
    a.putpixel((0, 0), (0, 0, 0, 255))
    a.putpixel((1, 0), (0, 0, 0, 0))
    a.save("black-and-clear.png", "PNG", optimize=True)

    # wider-than-a-thumbnail: 600x400, LARGER than THUMB_MAX on both sides.
    # Every other fixture here is smaller than the bound, which makes box_scale
    # a no-op on all of them -- and a mutation caching a full-resolution
    # thumbnail survived a whole pass because of it.
    w = Image.new("RGB", (600, 400))
    for x in range(600):
        for y in range(400):
            w.putpixel((x, y), (x * 255 // 600, 64, 255 - x * 255 // 600))
    w.save("wider-than-a-thumbnail.png", "PNG", optimize=True)

    # declares-a-bomb: 66 bytes, an IHDR DECLARING 30000x30000 and NO pixel data
    # at all. 900 megapixels and 2.7 GB of RGB in a file no size ceiling can
    # catch, which is why the refusal is read off the header.
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))
    open("declares-a-bomb.png", "wb").write(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 30000, 30000, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00"))
        + chunk(b"IEND", b""))
    PY

This one is written with `zlib` and `struct` rather than
with Pillow for the reason the bomb is: the point of the file is its DECLARED
size, and a library that decides its own encoding is one more thing between the
recipe and the bytes.

    python3 - <<'PY'
    import struct, zlib

    # wider-than-a-full-view: 1800x1200, LARGER than FULL_MAX (1600) on its long
    # side. `wider-than-a-thumbnail` is 600x400, which is over THUMB_MAX and
    # UNDER the full-view bound -- so with that fixture alone `box_scale` is a
    # no-op inside `pictures::full` and a mutation deleting the bound survives.
    # That exercises the one bound further out. Left half black and
    # right half white, so a downscale is checkable by COLOUR as well as by size.
    W, H = 1800, 1200
    raw = bytearray()
    for y in range(H):
        raw.append(0)                       # filter: none
        for x in range(W):
            v = 0 if x < W // 2 else 255
            raw += bytes((v, v, v))
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))
    open("wider-than-a-full-view.png", "wb").write(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b""))
    PY
