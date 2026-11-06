import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, Text } from 'react-native';
import Home from '../app/home';
import Profile from '../app/profile';
import SignIn from '../app/sign-in';
import { rememberPerson, writeCache } from '../src/cache';
import { PushProvider } from '../src/push-context';
import { forgetRegistration } from '../src/push-registration';
import { hrefForPush } from '../src/push-routing';
import { SessionProvider } from '../src/session';
import { AGENCY, guardError, LANDLORD, ME } from './fixtures';

// M6 review round (LT findings L2, L6 to L8, L13, L14 and L15): push stops when the phone stops
// allowing it, is offered only when it can arrive, names the landlords it comes from, and nothing
// of a person stays after sign-out, even offline.

const TOKEN = 'ExponentPushToken[review123TOKEN]';
const DEVICE_KEY = 'rent.push.v1:device';
const SIGN_OUT_KEY = 'rent.push.v1:sign-out-pending';

const mockNotifications = {
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
  clearLastNotificationResponseAsync: jest.fn(),
  dismissAllNotificationsAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
};
const mockReplace = jest.fn();
const mockMe = jest.fn();
const mockTenancies = jest.fn();
const mockSigning = jest.fn();
const mockConversations = jest.fn();
const mockRegister = jest.fn();
const mockUnregister = jest.fn();
const mockPushConsent = jest.fn();
const mockSetPushConsent = jest.fn();
const mockAuthSignOut = jest.fn();
const mockSendOtp = jest.fn();

jest.mock('expo-notifications', () => mockNotifications);
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { extra: { eas: { projectId: 'rent-test-project' } } },
    easConfig: null,
    executionEnvironment: 'standalone',
  },
  ExecutionEnvironment: { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' },
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: mockReplace,
    back: jest.fn(),
    canGoBack: () => true,
  }),
  usePathname: () => '/home',
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('../src/api', () => ({
  api: {
    me: { get: (...args: unknown[]) => mockMe(...args) },
    tenantApp: {
      tenancies: (...args: unknown[]) => mockTenancies(...args),
      signing: (...args: unknown[]) => mockSigning(...args),
    },
    tenantMessaging: {
      conversations: (...args: unknown[]) => mockConversations(...args),
      registerPushDevice: (...args: unknown[]) => mockRegister(...args),
      unregisterPushDevice: (...args: unknown[]) => mockUnregister(...args),
      pushConsent: (...args: unknown[]) => mockPushConsent(...args),
      setPushConsent: (...args: unknown[]) => mockSetPushConsent(...args),
    },
  },
}));
jest.mock('../src/auth-client', () => ({
  authClient: {
    signOut: (...args: unknown[]) => mockAuthSignOut(...args),
    listSessions: async () => ({ data: [] }),
    revokeSession: jest.fn(),
    phoneNumber: {
      sendOtp: (...args: unknown[]) => mockSendOtp(...args),
      verify: jest.fn(),
    },
  },
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const phone = { allows: 'undetermined', answers: 'granted' };
type Consent = { companyId: string; landlordName: string; granted: boolean }[];
let consent: Consent;

function App({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <PushProvider>{children}</PushProvider>
    </SessionProvider>
  );
}

/** The app comes back to the front: every AppState listener hears it. */
async function backToTheApp() {
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls;
  await act(async () => {
    for (const [, listener] of listeners) (listener as (state: string) => void)('active');
  });
}

const offline = () => new TypeError('Network request failed');
const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0] ?? Infinity;

beforeEach(() => {
  jest.clearAllMocks();
  forgetRegistration();
  phone.allows = 'undetermined';
  phone.answers = 'granted';
  consent = [
    { companyId: AGENCY.companyId, landlordName: AGENCY.name, granted: true },
    { companyId: LANDLORD.companyId, landlordName: LANDLORD.name, granted: true },
  ];
  for (const mock of [mockUnregister, mockRegister, mockAuthSignOut, mockSetPushConsent])
    mock.mockReset();
  mockNotifications.getPermissionsAsync.mockImplementation(async () => ({ status: phone.allows }));
  mockNotifications.requestPermissionsAsync.mockImplementation(async () => {
    phone.allows = phone.answers;
    return { status: phone.allows };
  });
  mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
  mockNotifications.addNotificationResponseReceivedListener.mockReturnValue({ remove: jest.fn() });
  mockNotifications.getLastNotificationResponseAsync.mockResolvedValue(null);
  mockNotifications.dismissAllNotificationsAsync.mockResolvedValue(undefined);
  mockMe.mockResolvedValue(ME);
  mockTenancies.mockResolvedValue([]);
  mockSigning.mockResolvedValue([]);
  mockConversations.mockResolvedValue([]);
  mockRegister.mockResolvedValue({ deviceId: '0193a7c0-0000-7000-8000-0000000de002' });
  mockUnregister.mockResolvedValue({ ok: true });
  mockAuthSignOut.mockResolvedValue({});
  mockSendOtp.mockResolvedValue({ data: {}, error: null });
  mockPushConsent.mockImplementation(async () => consent);
  mockSetPushConsent.mockImplementation(
    async ({ granted, companyId }: { granted: boolean; companyId?: string }) => {
      consent = consent.map((landlord) =>
        !companyId || landlord.companyId === companyId ? { ...landlord, granted } : landlord,
      );
      return consent;
    },
  );
});

describe('CM-09 push stops when the phone stops allowing it (L2)', () => {
  it('the token goes when the phone’s settings turn notifications off', async () => {
    phone.allows = 'granted';
    await render(
      <App>
        <Text>Home</Text>
      </App>,
    );
    await waitFor(() =>
      expect(mockRegister).toHaveBeenCalledWith({ token: TOKEN, platform: 'ios' }),
    );
    expect(mockUnregister).not.toHaveBeenCalled();

    phone.allows = 'denied';
    await backToTheApp();
    await waitFor(() => expect(mockUnregister).toHaveBeenCalledWith({ token: TOKEN }));
    expect(await AsyncStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  it('an app opened after the settings changed removes the token it registered before', async () => {
    await AsyncStorage.setItem(DEVICE_KEY, JSON.stringify({ token: TOKEN }));
    phone.allows = 'denied';
    await render(
      <App>
        <Text>Home</Text>
      </App>,
    );
    await waitFor(() => expect(mockUnregister).toHaveBeenCalledWith({ token: TOKEN }));
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('Profile shows a landlord’s switch off while the phone blocks notifications, though the landlord may send them', async () => {
    phone.allows = 'denied';
    await render(
      <App>
        <Profile />
      </App>,
    );
    expect(await screen.findByTestId('push-blocked')).toBeOnTheScreen();
    const toggles = await screen.findAllByTestId('push-toggle');
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle).toHaveProp('value', false);
      expect(toggle).toHaveProp('disabled', true);
    }
  });
});

describe('CM-09 notifications are offered only when they can arrive (L6)', () => {
  it('a device that cannot get a token records no consent, and Home says notifications are not available', async () => {
    mockNotifications.getExpoPushTokenAsync.mockRejectedValue(new Error('No token on a simulator'));
    await render(
      <App>
        <Home />
      </App>,
    );
    await fireEvent.press(await screen.findByTestId('push-turn-on'));
    expect(await screen.findByTestId('push-unavailable')).toHaveTextContent(
      /not available on this phone/,
    );
    expect(screen.queryByTestId('push-on')).not.toBeOnTheScreen();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockSetPushConsent).not.toHaveBeenCalled();
  });

  it('in Profile too: the switch stays off and says why', async () => {
    mockNotifications.getExpoPushTokenAsync.mockRejectedValue(new Error('No token'));
    consent = [{ companyId: AGENCY.companyId, landlordName: AGENCY.name, granted: false }];
    await render(
      <App>
        <Profile />
      </App>,
    );
    const [toggle] = await screen.findAllByTestId('push-toggle');
    await fireEvent(toggle!, 'valueChange', true);
    expect(await screen.findByTestId('push-no-token')).toHaveTextContent(/not available/);
    expect(mockSetPushConsent).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('push-toggle')[0]).toHaveProp('value', false);
  });
});

describe('CM-09 the Home question names the landlords (L7, L8)', () => {
  it('names every landlord the notifications would come from', async () => {
    await render(
      <App>
        <Home />
      </App>,
    );
    expect(await screen.findByTestId('push-landlords')).toHaveTextContent(
      `Notifications from ${AGENCY.name} and ${LANDLORD.name}. You can turn each one off in Profile.`,
    );
  });

  it('on a phone that already allows notifications, it asks for the landlords without consent, and records consent for them only', async () => {
    phone.allows = 'granted';
    consent = [
      { companyId: AGENCY.companyId, landlordName: AGENCY.name, granted: true },
      { companyId: LANDLORD.companyId, landlordName: LANDLORD.name, granted: false },
    ];
    await render(
      <App>
        <Home />
      </App>,
    );
    expect(await screen.findByTestId('push-landlords')).toHaveTextContent(
      `Notifications from ${LANDLORD.name}.`,
      { exact: false },
    );
    await fireEvent.press(screen.getByTestId('push-turn-on'));
    expect(await screen.findByTestId('push-on')).toBeOnTheScreen();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockSetPushConsent).toHaveBeenCalledTimes(1);
    expect(mockSetPushConsent).toHaveBeenCalledWith({
      granted: true,
      companyId: LANDLORD.companyId,
    });
  });

  it('a phone that allows notifications, with every landlord already on, asks nothing', async () => {
    phone.allows = 'granted';
    await render(
      <App>
        <Home />
      </App>,
    );
    await screen.findByTestId('no-tenancies');
    await waitFor(() => expect(mockPushConsent).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId('push-prompt')).not.toBeOnTheScreen();
  });

  it('a toggle in Profile answers the question: Home does not ask again', async () => {
    consent = [{ companyId: AGENCY.companyId, landlordName: AGENCY.name, granted: true }];
    phone.allows = 'granted';
    const profile = await render(
      <App>
        <Profile />
      </App>,
    );
    const [toggle] = await screen.findAllByTestId('push-toggle');
    await fireEvent(toggle!, 'valueChange', false);
    await waitFor(() => expect(mockSetPushConsent).toHaveBeenCalled());
    await profile.unmount();

    await render(
      <App>
        <Home />
      </App>,
    );
    await screen.findByTestId('no-tenancies');
    await act(async () => undefined);
    expect(screen.queryByTestId('push-prompt')).not.toBeOnTheScreen();
  });
});

describe('AD-06 nothing of a person stays after their session ends or they sign out (L13, L14)', () => {
  it('a session refused when the app opens empties the cache on the phone', async () => {
    await rememberPerson(ME);
    await writeCache(ME.personId, 'messages:abc', { items: [{ body: 'Private words' }] });
    mockMe.mockRejectedValue(guardError(401, 'not_authenticated', 'Sign in to continue'));
    await render(
      <SessionProvider>
        <Text>App</Text>
      </SessionProvider>,
    );
    await waitFor(async () =>
      expect(
        (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith('rent.cache')),
      ).toEqual([]),
    );
  });

  it('signing out offline keeps the session and the token until the API hears of it, empties the tray, and finishes on return', async () => {
    phone.allows = 'granted';
    await render(
      <App>
        <Profile />
      </App>,
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    mockUnregister.mockRejectedValueOnce(offline());
    await fireEvent.press(await screen.findByTestId('sign-out'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/sign-in'));
    expect(mockAuthSignOut).not.toHaveBeenCalled();
    expect(mockNotifications.dismissAllNotificationsAsync).toHaveBeenCalled();
    expect(await AsyncStorage.getItem(SIGN_OUT_KEY)).toBe('1');
    expect(await AsyncStorage.getItem(DEVICE_KEY)).toContain(TOKEN);

    // Back online and back to the app: the token goes, then the session.
    await backToTheApp();
    await waitFor(() => expect(mockAuthSignOut).toHaveBeenCalledTimes(1));
    expect(mockUnregister).toHaveBeenCalledTimes(2);
    expect(mockUnregister).toHaveBeenLastCalledWith({ token: TOKEN });
    expect(mockUnregister.mock.invocationCallOrder[1]).toBeLessThan(order(mockAuthSignOut));
    expect(await AsyncStorage.getItem(SIGN_OUT_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(DEVICE_KEY)).toBeNull();
    // That session never comes back: the screens stay signed out.
    expect(mockMe).toHaveBeenCalledTimes(1);
  });

  it('the next sign-in finishes a sign-out made offline before it asks for a code', async () => {
    await AsyncStorage.setItem(DEVICE_KEY, JSON.stringify({ token: TOKEN }));
    await AsyncStorage.setItem(SIGN_OUT_KEY, '1');
    // Still offline when the app opens.
    mockUnregister.mockRejectedValueOnce(offline());
    await render(
      <SessionProvider>
        <SignIn />
      </SessionProvider>,
    );
    await fireEvent.changeText(await screen.findByTestId('phone-input'), '024 412 3456');
    await fireEvent.press(screen.getByTestId('send-code'));
    await waitFor(() => expect(mockSendOtp).toHaveBeenCalled());
    expect(mockAuthSignOut).toHaveBeenCalledTimes(1);
    expect(order(mockAuthSignOut)).toBeLessThan(order(mockSendOtp));
    expect(await AsyncStorage.getItem(SIGN_OUT_KEY)).toBeNull();
    expect(mockMe).not.toHaveBeenCalled();
  });
});

describe('CM-05 tapping a notification that names only its purpose', () => {
  it('opens the screen the server names for that purpose', () => {
    expect(hrefForPush({ purpose: 'pay_link' })).toBe('/payments');
    expect(hrefForPush({ purpose: 'paid_until_prompt' })).toBe('/payments');
    expect(hrefForPush({ purpose: 'signed_copy' })).toBe('/home');
    expect(
      hrefForPush({ purpose: 'signed_copy', leaseId: '0193a7c0-0000-7000-8000-0000000000a1' }),
    ).toBe('/tenancy/0193a7c0-0000-7000-8000-0000000000a1');
    expect(hrefForPush({ purpose: 'id_check_link' })).toBe('/home');
    expect(hrefForPush({ purpose: 'broadcast', companyId: AGENCY.companyId })).toBe(
      `/messages/${AGENCY.companyId}`,
    );
  });
});

describe('NFR-PERF the web build leaves expo-notifications out (L15)', () => {
  type Entry = { name: string; isDirectory(): boolean };
  const fs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: 'utf8'): string;
    readdirSync(path: string, options: { withFileTypes: true }): Entry[];
  };
  const root = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();

  function sources(dir: string): string[] {
    return fs
      .readdirSync(`${root}/${dir}`, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? sources(`${dir}/${entry.name}`)
          : /\.tsx?$/.test(entry.name)
            ? [`${dir}/${entry.name}`]
            : [],
      );
  }

  it('only src/push.ts loads it, and Metro gives the web build push.web.ts instead', () => {
    const loads =
      /from 'expo-notifications'|require\('expo-notifications'\)|import\('expo-notifications'\)/;
    const importing = [...sources('app'), ...sources('src')].filter((file) => {
      const text = fs
        .readFileSync(`${root}/${file}`, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*import type /.test(line) && !/^\s*(\/\/|\*)/.test(line))
        .join('\n');
      return loads.test(text);
    });
    expect(importing).toEqual(['src/push.ts']);
    const web = fs.readFileSync(`${root}/src/push.web.ts`, 'utf8');
    expect(web).not.toMatch(/expo-notifications'/);
  });
});
