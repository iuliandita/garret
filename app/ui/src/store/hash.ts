// app/ui/src/store/hash.ts
// FNV-1a over the serialized document. Synchronous by design: SubtleCrypto is
// async and this runs inside the measured loop, where an await would add a
// microtask to every sample. This is a change detector, not a security
// primitive.
export function bodyHash(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
