// app/ui/src/boot.ts
// Pure payload construction, kept out of main.ts so it is testable without a
// DOM or a host. "unknown" rather than a plausible default: a run that lost its
// host injection must be visible in the record, not disguised as a normal one.
export interface HostInjection {
  candidate?: string;
  seed?: string;
}

export interface ReadyPayload {
  ready: true;
  candidate: string;
  seed: string;
}

export function buildReadyPayload(host: HostInjection): ReadyPayload {
  return {
    ready: true,
    candidate: host.candidate ?? "unknown",
    seed: host.seed ?? "unknown",
  };
}
