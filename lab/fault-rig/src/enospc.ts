// lab/fault-rig/src/enospc.ts
export class EnospcError extends Error {
  code = "ENOSPC" as const;
  constructor(msg = "no space left on device (simulated)") {
    super(msg);
    this.name = "EnospcError";
  }
}

export interface ByteBudget {
  charge(bytes: number): void;
  used(): number;
  remaining(): number;
}

// Non-privileged disk-full simulation: throws ENOSPC once the cumulative
// charged bytes would exceed `limit`.
export function makeByteBudget(limit: number): ByteBudget {
  let used = 0;
  return {
    charge(bytes: number) {
      if (used + bytes > limit) throw new EnospcError();
      used += bytes;
    },
    used: () => used,
    remaining: () => Math.max(0, limit - used),
  };
}
