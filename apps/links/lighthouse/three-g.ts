/**
 * The 3G profile for every new speed check (M11 decision 8): WebPageTest's "3G", as M4b's
 * Playwright specs already apply it, plus a CPU slowed four times, as on a low-end phone.
 *
 * - 300 ms round trips;
 * - 1.6 Mbps down and 768 kbps up (binary megabits, as WebPageTest and Chrome count them).
 *
 * pay.spec.ts and signing.spec.ts keep their own copies: they are passed tests (M4b).
 */
export const THREE_G = {
  roundTripMs: 300,
  downloadKbps: 1.6 * 1024,
  uploadKbps: 768,
  cpuSlowdown: 4,
} as const;

/** For Chrome's Network.emulateNetworkConditions (Playwright, through CDP): bytes a second. */
export const THREE_G_NETWORK = {
  offline: false,
  latency: THREE_G.roundTripMs,
  // 1.6 Mibit/s and 768 kibit/s, as bytes a second (M4b's figures).
  downloadThroughput: 209_715,
  uploadThroughput: 98_304,
} as const;

/** For Lighthouse, applied in the browser as the page loads ("devtools" throttling). */
export const THREE_G_LIGHTHOUSE = {
  rttMs: THREE_G.roundTripMs,
  throughputKbps: THREE_G.downloadKbps,
  requestLatencyMs: THREE_G.roundTripMs,
  downloadThroughputKbps: THREE_G.downloadKbps,
  uploadThroughputKbps: THREE_G.uploadKbps,
  cpuSlowdownMultiplier: THREE_G.cpuSlowdown,
} as const;
