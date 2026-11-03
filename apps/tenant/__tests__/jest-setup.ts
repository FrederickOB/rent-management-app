import AsyncStorage from '@react-native-async-storage/async-storage';

// The device's key-value store, which holds the offline cache (src/cache.ts), kept in memory for
// the tests and emptied before each one, so no test sees what another cached.
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

beforeEach(async () => {
  await AsyncStorage.clear();
});
