module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/?(*.)test.tsx', '**/?(*.)test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/web-build/'],
  // pnpm keeps packages under node_modules/.pnpm; let Babel transform the React Native ones.
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@rent/.*|better-auth|@better-auth/.*|temporal-polyfill|nanostores|@orpc/.*))',
  ],
};
