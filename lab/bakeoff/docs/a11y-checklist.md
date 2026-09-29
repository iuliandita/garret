# PR10 accessibility checklist (Linux first, partly manual)

Run per candidate shell (Tauri, Electron). Automated portions feed the
`a11y_exposure` gate via `harness/src/atspi.ts`; the rest is a manual smoke
checklist recorded here by hand alongside the run's `rig_commit`.

## Automated (atspi probe)
- [ ] AT-SPI tree exposes an editor node (document/text/entry role)
- [ ] AT-SPI tree exposes a scene navigator (list role or name ~ "navigator")
- [ ] AT-SPI tree exposes a dialog node (quick-open) with a modal state

## Scripted keyboard-only journey
- [ ] Tab reaches the navigator, editor, and quick-open without a mouse
- [ ] Quick-open opens, filters, and jumps via keyboard only
- [ ] Focus returns to a sensible element after dialog close

## Render checks
- [ ] 200% zoom: no clipped controls, no horizontal scroll trap
- [ ] Reduced-motion honored (no non-essential animation)

## Composition and bidi (manual)
- [ ] fcitx CJK composition commits correctly into a scene
- [ ] RTL scene shows correct caret movement and selection direction

Record outcome, kernel, and `rig_commit` for each candidate. macOS is an
unmeasured gap and blocks contract promotion.
