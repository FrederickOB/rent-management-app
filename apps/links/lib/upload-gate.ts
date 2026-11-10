/**
 * Who may send the job sheet a photo form now (M11 security review F2), decided before a byte of
 * the form is read. A photo form may carry 100 MB; this keeps any one address, and the server as a
 * whole, to a few at a time:
 *
 * - **per server:** JOB_SHEET_UPLOADS_PER_SERVER forms at once (4 unless set);
 * - **per address:** 2 at once, so a double tap still reaches the form-id check that answers it
 *   once (lib/job-sheet-store.ts), and 30 in 10 minutes.
 *
 * In this server's memory, on `globalThis`, so every route shares it. An address that holds no
 * place and has nothing left in its window is forgotten in a sweep, at most once a minute (M11
 * review), so the map never grows with addresses seen once.
 */
const PER_ADDRESS_AT_ONCE = 2;
const PER_ADDRESS_WINDOW_MS = 10 * 60_000;
const PER_ADDRESS_IN_WINDOW = 30;
const SWEEP_EVERY_MS = 60_000;

interface Gate {
  active: number;
  lastSweep: number;
  readonly byAddress: Map<string, { active: number; admitted: number[] }>;
}

const holder = globalThis as typeof globalThis & { __rentUploadGate?: Gate };
const gate: Gate = (holder.__rentUploadGate ??= {
  active: 0,
  lastSweep: 0,
  byAddress: new Map(),
});

const live = (at: number, now: number) => now - at < PER_ADDRESS_WINDOW_MS;

/** Forgets every address that holds no place and has nothing left in its window. */
function sweep(now: number): void {
  if (now - gate.lastSweep < SWEEP_EVERY_MS) return;
  gate.lastSweep = now;
  for (const [address, own] of gate.byAddress) {
    own.admitted = own.admitted.filter((at) => live(at, now));
    if (own.active === 0 && own.admitted.length === 0) gate.byAddress.delete(address);
  }
}

const perServer = (env: Readonly<Record<string, string | undefined>>): number => {
  const value = Number(env.JOB_SHEET_UPLOADS_PER_SERVER);
  return Number.isInteger(value) && value > 0 ? value : 4;
};

export type Admission =
  { readonly ok: true; readonly release: () => void } | { readonly ok: false };

/** A place for one photo form from `address`, or none; release it once the form is handled. */
export function admitUpload(
  address: string,
  now = Date.now(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Admission {
  sweep(now);
  const own = gate.byAddress.get(address) ?? { active: 0, admitted: [] };
  own.admitted = own.admitted.filter((at) => live(at, now));
  if (
    gate.active >= perServer(env) ||
    own.active >= PER_ADDRESS_AT_ONCE ||
    own.admitted.length >= PER_ADDRESS_IN_WINDOW
  ) {
    if (own.active === 0 && own.admitted.length === 0) gate.byAddress.delete(address);
    return { ok: false };
  }
  gate.active += 1;
  own.active += 1;
  own.admitted.push(now);
  gate.byAddress.set(address, own);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      gate.active -= 1;
      own.active -= 1;
    },
  };
}

/** For tests: an empty gate. */
export function resetUploadGate(): void {
  gate.active = 0;
  gate.lastSweep = 0;
  gate.byAddress.clear();
}

/** For tests: how many addresses the gate remembers. */
export const rememberedAddresses = (): number => gate.byAddress.size;
