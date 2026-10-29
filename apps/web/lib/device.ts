const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(A|iOS)?\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/(Firefox|FxiOS)\//, 'Firefox'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/(Chrome|CriOS)\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\//, 'Safari'],
  [/(okhttp|Expo|CFNetwork|Darwin)\b/, 'Mobile app'],
];

// Order matters: iPhone agents mention Mac OS X, and Android agents mention Linux.
const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** A short name for a device from its user agent, such as `Chrome on macOS`. */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'Unknown device';
}
