// app/ui/src/fixture/source.ts
// What the navigator reads: identifiers and titles only. Scene bodies are never
// retained for it — discovery's `lazy-docs` result showed the retained
// manuscript is the memory lever, so this applies it at the source rather than
// rediscovering it. The editor gets exactly one scene, carried separately.
//
// The only implementation is the SQLite store's (`store/source.ts`). There was a
// second one built from a staged `corpus.json`, and the host stopped serving
// that path on 2026-08-10; it is gone rather than revived, because it built no
// export bar, no find, no save indicator, no word count and no rename panel.
export interface CorpusBlock {
  type: string;
  text: string;
}

export interface FixtureSource {
  readonly count: number;
  readonly seed: string;
  titleAt(index: number): string;
  idAt(index: number): string;
}
