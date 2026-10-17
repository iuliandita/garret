# Lazy EPUB preview measurements

Window: all visible documents plus one neighbor on either side, with a minimum of three documents. Unvisited document extents and page totals are estimates until mounted. Refresh restores the archive document name and viewport offset, using a unique unchanged title when earlier insertions renumber document filenames. Removed or ambiguous documents fall back to the filename or nearest index. EPUB bytes remain the host archive readback. Closing releases mounted pages and archive strings.

Four five-minute stress persistence runs, same copied release host and dmabuf-llvmpipe renderer, isolated Xvfb/X11 and temporary data. Each enables idle refresh; the existing rail mode omits the full accessibility walk. Peak RSS includes startup and the writing phase; it is not the no-typing settled opening delta in issue #318.

| UI | Rail | Peak RSS MB | Post-boot median MB | Typing p95/p99 ms | Stall rate | Cliff ratio | Idle renders |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |
| before | closed | 822 | 750 | 33/34 | 0.0002 | 1 | 0 |
| before | open | 1511 | 1313 | 34/38 | 0.0004 | 0.917 | 12 |
| after | closed | 850 | 770 | 33/34 | 0 | 1 | 0 |
| after | open | 1235 | 987 | 33/34 | 0 | 0.971 | 14 |

The RSS ceiling remains <750 MB. These measurements do not establish that the separate closed-rail renderer climb is fixed.

Binary SHA-256: 97c9d9298a0d9717e3debab774b4b88943b794b1016d8d0209ff829e82e066c1

Baseline UI: origin/develop at 0eec015b57f61b03cd535e9813c972f70eed14f5. Implementation UI: 0317f54. Intermediate results marked intermediate-318 used the earlier 14afa66 UI, before the ordinal-filename position fallback; they are retained but excluded from this comparison.

Rig exit codes:

```
before open 1
before closed 1
intermediate open 1
intermediate closed 1
aborted-final open 1
after open 1
after closed 1
```

Native read-only window probe:

```json
{
  "rows": 20000,
  "close_released_documents": true,
  "documents": 1572,
  "end": {
    "label": "Page 2,716 of 2,716",
    "last_document_fragments": [
      {
        "height": 87.75,
        "width": 284.4375
      }
    ],
    "left": 977378,
    "mounted": 3,
    "total_width": 977738,
    "width": 360
  },
  "initial_elements": 45378,
  "initial_mounted": 3,
  "reader_after": {
    "height": 426,
    "last": [
      {
        "css": "height: 385.578125px; break-before: column; display: flow-root;",
        "name": "OEBPS/text/1567.xhtml",
        "rect": {
          "bottom": 641.015625,
          "height": 385.5625,
          "left": -226,
          "right": 90,
          "top": 255.453125,
          "width": 316,
          "x": -226,
          "y": 255.453125
        },
        "text": ""
      },
      {
        "css": "break-before: column; display: flow-root;",
        "name": "OEBPS/text/1568.xhtml",
        "rect": {
          "bottom": 343.1875,
          "height": 87.734375,
          "left": 149.8125,
          "right": 434.25,
          "top": 255.453125,
          "width": 284.4375,
          "x": 149.8125,
          "y": 255.453125
        },
        "text": "\n\nAus\u00eancia Lantern 185\n\n"
      },
      {
        "css": "break-before: column; display: flow-root;",
        "name": "OEBPS/text/1569.xhtml",
        "rect": {
          "bottom": 641.03125,
          "height": 385.578125,
          "left": 149.8125,
          "right": 794.25,
          "top": 255.453125,
          "width": 644.4375,
          "x": 149.8125,
          "y": 255.453125
        },
        "text": "\n\nAus\u00eancia Ombr\u00e9 29\n\n"
      },
      {
        "css": "break-before: column; display: flow-root;",
        "name": "OEBPS/text/1570.xhtml",
        "rect": {
          "bottom": 343.21875,
          "height": 87.75,
          "left": 869.8125,
          "right": 1154.25,
          "top": 255.46875,
          "width": 284.4375,
          "x": 869.8125,
          "y": 255.46875
        },
        "text": "\n\nNocturne Ombr\u00e9 813\n\n"
      }
    ],
    "left": 565538,
    "width": 565898
  },
  "reader_before": {
    "height": 426,
    "last": [
      {
        "css": "height: 385.578125px; display: flow-root; break-before: column;",
        "name": "OEBPS/text/1567.xhtml",
        "rect": {
          "bottom": 641.015625,
          "height": 385.5625,
          "left": -226,
          "right": 90,
          "top": 255.453125,
          "width": 316,
          "x": -226,
          "y": 255.453125
        },
        "text": ""
      },
      {
        "css": "display: flow-root; break-before: column;",
        "name": "OEBPS/text/1568.xhtml",
        "rect": {
          "bottom": 343.1875,
          "height": 87.734375,
          "left": 149.8125,
          "right": 434.25,
          "top": 255.453125,
          "width": 284.4375,
          "x": 149.8125,
          "y": 255.453125
        },
        "text": "\n\nAus\u00eancia Lantern 185\n\n"
      },
      {
        "css": "display: flow-root; break-before: column;",
        "name": "OEBPS/text/1569.xhtml",
        "rect": {
          "bottom": 343.171875,
          "height": 87.71875,
          "left": 509.8125,
          "right": 794.25,
          "top": 255.453125,
          "width": 284.4375,
          "x": 509.8125,
          "y": 255.453125
        },
        "text": "\n\nAus\u00eancia Ombr\u00e9 29\n\n"
      },
      {
        "css": "display: flow-root; break-before: column;",
        "name": "OEBPS/text/1570.xhtml",
        "rect": {
          "bottom": 343.21875,
          "height": 87.75,
          "left": 869.8125,
          "right": 1154.25,
          "top": 255.46875,
          "width": 284.4375,
          "x": 869.8125,
          "y": 255.46875
        },
        "text": "\n\nNocturne Ombr\u00e9 813\n\n"
      }
    ],
    "left": 977378,
    "width": 977738
  },
  "reader_refresh": {
    "after": {
      "name": "OEBPS/text/1570.xhtml",
      "offset": -59.8125
    },
    "before": {
      "name": "OEBPS/text/1570.xhtml",
      "offset": -59.8125
    },
    "delta_px": 0
  },
  "reopened_frame": true,
  "scroll_refresh": {
    "after": {
      "name": "OEBPS/text/0099.xhtml",
      "offset": 198.125
    },
    "before": {
      "name": "OEBPS/text/0099.xhtml",
      "offset": 198.46875
    },
    "delta_px": -0.34375
  },
  "scrolled_mounted": 3,
  "scope": "Staged-only read-only EPUB window, scroll and framed-page checks; no latency or memory verdicts."
}
```

UI bundle provenance:

```json
{
  "baseline": {
    "source": "0eec015b57f61b03cd535e9813c972f70eed14f5",
    "main_sha256": "19640ef4a359b49171a6d2a52024a83140c83378f938935b24e7c87db44fa1db"
  },
  "intermediate": {
    "source": "14afa66",
    "main_sha256": "99b35a292f9463c861fb5cff3142746a3a20b8d2734c2f0603c7d0e1ffa4fca9"
  },
  "native_probe": {
    "source": "990e83ac",
    "main_sha256": "71f1872053c5e83c5337590b8cd10662b23f6227703b66f974f50309c33639f6"
  }
}
```

Local checks: 152 focused preview tests passed; TypeScript, release host build, final UI build and documentation guard exited 0. The native probe exited 0. Screenshots were inspected locally and remain untracked.

A single large EPUB document still mounts as a whole; this window bounds documents, not elements within one document.

The five-minute after runs use 0317f54. The native probe uses the same preview code plus the framed-only fractional-height correction in 990e83ac; those measured five-minute modes leave the frame off, so that correction does not execute there. The native result's rig_commit names the unchanged harness parent; the UI bundle above identifies the tested UI.

An earlier final attempt was terminated before grading to correct the duplicate-title fallback. The first native attempt exited 1 because measurement verify mode has no app menu; the corrected interactive probe then reproduced the framed-position regression twice (exit 1). A 386px placeholder exceeded the actual 385.578125px column height and spilled into a second column. Using the fractional height resolves the native check (exit 0).

After measurement, the branch was rebased onto develop at ba5d26a1. The preview modules and test are byte-identical to the native-tested source (990e83ac, now b9e66f22); only the generated documentation receipt required conflict resolution. The focused tests, TypeScript and documentation guard pass after rebase. The measurements above retain their original source and bundle provenance rather than claiming a new measurement of unrelated develop changes.

The first PR interface check then caught the literal scanner interpreting the long height template as prose. The final source extracts that unchanged arithmetic into a local height variable; the pixel value and control flow are unchanged. All 159 focused preview/literal-guard tests, TypeScript, the final UI build and documentation guard pass (exit 0). This does not add a new native or RSS measurement.
