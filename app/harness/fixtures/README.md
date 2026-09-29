# Harness fixtures

Binary, so the recipe is here — this repo's rule is that fixtures stay
REPRODUCIBLE.

## demo-portrait.png

The picture `shot-cli --cast` plants on the first cast entry. A SYNTHETIC
harbour scene and not anybody's photograph: fixtures stay synthetic, and a
picture of a person in a screenshot directory would be the one file here nobody
could explain. It carries structure that survives a downscale to 256 px and
again to the panel's 160 px, so a capture says whether the box filter worked.

    python3 - <<'PY'
    from PIL import Image, ImageDraw
    W, H = 480, 640
    im = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(im)
    for y in range(H):
        f = y / H
        if f < 0.55:
            g = 1 - f / 0.55
            c = (int(60 + 130 * g), int(90 + 120 * g), int(140 + 100 * g))
        else:
            g = (f - 0.55) / 0.45
            c = (int(30 + 30 * g), int(60 + 40 * g), int(80 + 30 * g))
        d.line([(0, y), (W, y)], fill=c)
    d.ellipse([300, 70, 380, 150], fill=(250, 235, 190))
    for i, x in enumerate(range(40, 460, 90)):
        top = 260 + (i % 3) * 30
        d.rectangle([x, top, x + 55, 352], fill=(35, 40, 55))
        d.rectangle([x + 20, top - 40, x + 26, top], fill=(35, 40, 55))
    d.rectangle([0, 352, W, 366], fill=(20, 24, 34))
    for y in range(366, H, 14):
        d.line([(0, y), (W, y)], fill=(45, 80, 105), width=3)
    im.save("demo-portrait.png", "PNG", optimize=True)
    PY

## demo-cover-front.png and demo-cover-back.png

The pictures `shot-cli --covers` plants on the book's two sides. Synthetic, for
`demo-portrait.png`'s reason.

THE TWO SIZES ARE THE POINT OF THE FIXTURE. The front is 600x900 -- exactly 2:3,
which is the fiction preset's 6 x 9 in page, so its proportions are right and
only its resolution is short (100 dpi against 300). The back is the same picture
turned on its side: landscape on a portrait page, so it is the wrong shape AND
short of resolution. Between them one capture holds a one-sentence finding block
and a two-sentence one, which is the layout a screenshot is needed to judge and
the reason the plant does not use a cover that passes.

    python3 - <<'PY'
    from PIL import Image, ImageDraw

    W, H = 600, 900
    im = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(im)
    for y in range(H):
        f = y / H
        c = (int(18 + 40 * f), int(30 + 60 * f), int(58 + 70 * f))
        d.line([(0, y), (W, y)], fill=c)
    d.ellipse([W - 210, 90, W - 70, 230], fill=(244, 232, 196))
    for i, x in enumerate(range(40, W - 40, 120)):
        top = 470 + (i % 3) * 40
        d.rectangle([x, top, x + 70, 640], fill=(14, 18, 30))
        d.rectangle([x + 28, top - 55, x + 34, top], fill=(14, 18, 30))
    d.rectangle([0, 640, W, 660], fill=(10, 13, 22))
    for y in range(660, H, 18):
        d.line([(0, y), (W, y)], fill=(38, 72, 100), width=4)
    d.rectangle([60, 250, W - 60, 262], fill=(238, 230, 210))
    d.rectangle([120, 300, W - 120, 310], fill=(200, 194, 180))
    im.save("demo-cover-front.png", "PNG", optimize=True)
    im.rotate(90, expand=True).save("demo-cover-back.png", "PNG", optimize=True)
    PY
