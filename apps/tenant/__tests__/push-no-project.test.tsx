import { render, screen } from '@testing-library/react-native';
import Profile from '../app/profile';
import { PushProvider } from '../src/push-context';
import { SessionProvider } from '../src/session';
import { ME } from './fixtures';

// M6 review round (LT finding L6): a build with no EAS project can never get a push token, so it
// does not offer notifications at all, rather than saying "on" for something that cannot arrive.

const mockNotifications = {
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
};
const mockPushConsent = jest.fn();
const mockMe = jest.fn();

jest.mock('expo-notifications', () => mockNotifications);
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
    tenantMessaging: { pushConsent: (...args: unknown[]) => mockPushConsent(...args) },
  },
}));
jest.mock('../src/auth-client', () => ({
  authClient: {
    signOut: jest.fn(),
    listSessions: async () => ({ data: [] }),
    revokeSession: jest.fn(),
  },
}));

beforeEach(() => {
  mockMe.mockResolvedValue(ME);
});

describe('CM-09 a build without an EAS project offers no notifications (L6)', () => {
  it('Profile says notifications are not available, and the phone is never asked', async () => {
    await render(
      <SessionProvider>
        <PushProvider>
          <Profile />
        </PushProvider>
      </SessionProvider>,
    );
    expect(await screen.findByTestId('push-unavailable')).toHaveTextContent(
      /not available in this version of the app/,
    );
    expect(screen.queryByTestId('push-toggle')).not.toBeOnTheScreen();
    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockPushConsent).not.toHaveBeenCalled();
  });
});
