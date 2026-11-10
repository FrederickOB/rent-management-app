import { fireEvent, render, screen } from '@testing-library/react-native';
import Profile from '../app/profile';
import { PushProvider } from '../src/push-context';
import { SessionProvider } from '../src/session';
import { ME } from './fixtures';

// M11 (identity work): the devices a tenant is signed in on (AD-06). A list that failed to load
// was shown as no devices at all, which reads as "nobody else is signed in". It now says it could
// not load them, and offers to try again.

const mockListSessions = jest.fn();
const mockMe = jest.fn();

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
}));
// No EAS project, so the notifications card asks the API nothing.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: {} }, easConfig: null, executionEnvironment: 'standalone' },
  ExecutionEnvironment: { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' },
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  usePathname: () => '/profile',
  useFocusEffect: jest.fn(),
  Redirect: () => null,
}));
jest.mock('../src/api', () => ({
  api: {
    me: { get: (...args: unknown[]) => mockMe(...args) },
    tenantMessaging: { pushConsent: jest.fn() },
  },
}));
jest.mock('../src/auth-client', () => ({
  authClient: {
    signOut: jest.fn(),
    listSessions: (...args: unknown[]) => mockListSessions(...args),
    revokeSession: jest.fn(),
  },
}));

const phone = {
  id: 's1',
  token: 't1',
  userAgent: 'Tecno Spark 10',
  createdAt: '2026-11-01T09:00:00.000Z',
};

function renderProfile() {
  return render(
    <SessionProvider>
      <PushProvider>
        <Profile />
      </PushProvider>
    </SessionProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMe.mockResolvedValue(ME);
});

describe('AD-06 the devices signed in, when the list cannot be loaded', () => {
  it('says the list could not be loaded, never "no devices", and loads it on a retry', async () => {
    mockListSessions.mockResolvedValueOnce({
      data: null,
      error: { status: 500, statusText: 'Internal Server Error' },
    });
    await renderProfile();

    expect(await screen.findByTestId('devices-error')).toHaveTextContent(
      /could not load the devices signed in/,
    );
    expect(screen.queryByText('Tecno Spark 10')).not.toBeOnTheScreen();

    mockListSessions.mockResolvedValueOnce({ data: [phone], error: null });
    await fireEvent.press(screen.getByTestId('retry-devices'));
    expect(await screen.findByText('Tecno Spark 10')).toBeOnTheScreen();
    expect(screen.queryByTestId('devices-error')).not.toBeOnTheScreen();
  });

  it('a phone with no connection is told so', async () => {
    mockListSessions.mockRejectedValueOnce(new TypeError('Network request failed'));
    await renderProfile();
    expect(await screen.findByTestId('devices-error')).toHaveTextContent(/connection|internet/i);
  });
});
