module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/?(*.)test.tsx', '**/?(*.)test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/web-build/'],
  // React Native loads its components lazily and Babel transforms them on first use, so the first
  // render in a run is slow: 3 seconds on a CI runner with a cold cache, 18 when other suites share
  // its CPUs. Jest's 5-second default charges all of that to whichever test renders first.
  testTimeout: 60_000,
  // pnpm keeps packages under node_modules/.pnpm; let Babel transform the React Native ones.
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@rent/.*|better-auth|@better-auth/.*|temporal-polyfill|temporal-utils|nanostores|@orpc/.*))',
  ],
};
