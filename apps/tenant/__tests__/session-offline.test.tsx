import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text, View } from 'react-native';
import { readCache, rememberPerson, writeCache } from '../src/cache';
import { SessionProvider, useSession } from '../src/session';
import { guardError, ME } from './fixtures';

const mockMe = jest.fn();

jest.mock('../src/api', () => ({ api: { me: { get: (...args: unknown[]) => mockMe(...args) } } }));
jest.mock('../src/auth-client', () => ({
  authClient: { signOut: jest.fn(() => Promise.reject(new TypeError('Network request failed'))) },
}));

/** Signed in until long after any run of these tests. */
const TENANT = { ...ME, sessionExpiresAt: '2099-01-01T00:00:00.000Z' };

function Who() {
  const { me, loading, offline, signOut, expire } = useSession();
  if (loading) return null;
  return (
    <View>
      <Text testID="who">
        {me ? `Signed in as ${me.name}${offline ? ', offline' : ''}` : 'Not signed in'}
      </Text>
      <Text testID="sign-out" onPress={() => void signOut()}>
        Sign out
      </Text>
      <Text testID="expire" onPress={expire}>
        Expire
      </Text>
    </View>
  );
}

const offline = () => new TypeError('Network request failed');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TL-01 and BC-04 the tenant app’s money screens: opening offline', () => {
  it('opens as the tenant last signed in here, so the cached figures show', async () => {
    mockMe.mockResolvedValueOnce(TENANT);
    const first = await render(
      <SessionProvider>
        <Who />
      </SessionProvider>,
    );
    expect(await screen.findByText('Signed in as Abena Mensah')).toBeOnTheScreen();
    await first.unmount();

    mockMe.mockRejectedValue(offline());
    await render(
      <SessionProvider>
        <Who />
      </SessionProvider>,
    );
    expect(await screen.findByText('Signed in as Abena Mensah, offline')).toBeOnTheScreen();
  });

  it('does not open offline once the session has run out', async () => {
    await rememberPerson({ ...TENANT, sessionExpiresAt: '2020-01-01T00:00:00.000Z' });
    mockMe.mockRejectedValue(offline());
    await render(
      <SessionProvider>
        <Who />
      </SessionProvider>,
    );
    expect(await screen.findByText('Not signed in')).toBeOnTheScreen();
  });

  it('never opens on the cache when the API refuses the session', async () => {
    await rememberPerson(TENANT);
    mockMe.mockRejectedValue(guardError(401, 'not_authenticated', 'Sign in to continue'));
    await render(
      <SessionProvider>
        <Who />
      </SessionProvider>,
    );
    expect(await screen.findByText('Not signed in')).toBeOnTheScreen();
  });

  it('signing out empties the cache, even offline, so a shared phone keeps nothing', async () => {
    mockMe.mockResolvedValue(TENANT);
    await render(
      <SessionProvider>
        <Who />
      </SessionProvider>,
    );
    await screen.findByText('Signed in as Abena Mensah');
    await writeCache(TENANT.personId, 'tenancies', [{ unit: 'ACC-ELG-B1-05' }]);
    await fireEvent.press(screen.getByTestId('sign-out'));
    expect(await screen.findByText('Not signed in')).toBeOnTheScreen();
    expect(await readCache(TENANT.personId, 'tenancies')).toBeNull();
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it('a session the API ends empties the cache too', async () => {
    mockMe.mockResolvedValue(TENANT);
    await render(
      <SessionProvider>
        <Who />
      </SessionProvider>,
    );
    await screen.findByText('Signed in as Abena Mensah');
    await writeCache(TENANT.personId, 'payments', []);
    await fireEvent.press(screen.getByTestId('expire'));
    expect(await screen.findByText('Not signed in')).toBeOnTheScreen();
    await waitFor(async () => expect(await AsyncStorage.getAllKeys()).toEqual([]));
  });
});
