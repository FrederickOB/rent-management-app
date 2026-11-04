import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, Text } from 'react-native';
import Home from '../app/home';
import Profile from '../app/profile';
import { PushProvider } from '../src/push-context';
import { forgetRegistration } from '../src/push-registration';
import { hrefForPush } from '../src/push-routing';
import * as webPush from '../src/push.web';
import { SessionProvider } from '../src/session';
import { AGENCY, guardError, LANDLORD, ME } from './fixtures';

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';
const TOKEN = 'ExponentPushToken[abc123DEF456]';
const PROJECT_ID = 'rent-test-project';

const mockNotifications = {
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
  clearLastNotificationResponseAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
};
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockPath = { current: '/home' };
const mockMe = jest.fn();
const mockTenancies = jest.fn();
const mockSigning = jest.fn();
const mockConversations = jest.fn();
const mockRegister = jest.fn();
const mockUnregister = jest.fn();
const mockPushConsent = jest.fn();
const mockSetPushConsent = jest.fn();
const mockAuthSignOut = jest.fn();

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
    push: mockPush,
    replace: mockReplace,
    back: jest.fn(),
    canGoBack: () => true,
  }),
  usePathname: () => mockPath.current,
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
  },
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

/** What the phone allows, and what its prompt will answer. */
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

/** A notification as Expo hands its tap to the app. */
function tapped(data: Record<string, unknown>, actionIdentifier = DEFAULT_ACTION) {
  return {
    actionIdentifier,
    notification: {
      request: {
        content: {
          title: 'A message from Osu Ridge Property Managers',
          body: 'Open the app to read it.',
          data,
        },
      },
    },
  };
}

/** The listener the app gave Expo for taps while it runs. */
async function tapListener(): Promise<(response: unknown) => void> {
  await waitFor(() =>
    expect(mockNotifications.addNotificationResponseReceivedListener).toHaveBeenCalled(),
  );
  return mockNotifications.addNotificationResponseReceivedListener.mock.calls.at(-1)![0];
}

const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0] ?? Infinity;

beforeEach(() => {
  jest.clearAllMocks();
  forgetRegistration();
  mockPath.current = '/home';
  phone.allows = 'undetermined';
  phone.answers = 'granted';
  consent = [
    { companyId: AGENCY.companyId, landlordName: AGENCY.name, granted: true },
    { companyId: LANDLORD.companyId, landlordName: LANDLORD.name, granted: true },
  ];
  mockNotifications.getPermissionsAsync.mockImplementation(async () => ({ status: phone.allows }));
  mockNotifications.requestPermissionsAsync.mockImplementation(async () => {
    phone.allows = phone.answers;
    return { status: phone.allows };
  });
  mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
  mockNotifications.addNotificationResponseReceivedListener.mockReturnValue({ remove: jest.fn() });
  mockNotifications.getLastNotificationResponseAsync.mockResolvedValue(null);
  mockMe.mockResolvedValue(ME);
  mockTenancies.mockResolvedValue([]);
  mockSigning.mockResolvedValue([]);
  mockConversations.mockResolvedValue([]);
  mockRegister.mockResolvedValue({ deviceId: '0193a7c0-0000-7000-8000-0000000de001' });
  mockUnregister.mockResolvedValue({ ok: true });
  mockAuthSignOut.mockResolvedValue({});
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

describe('CM-09 push registration (M6 decision 5)', () => {
  it('registers the signed-in session’s token on a phone that already allows notifications, once, without asking', async () => {
    phone.allows = 'granted';
    await render(
      <App>
        <Text>Signed in</Text>
      </App>,
    );
    await waitFor(() =>
      expect(mockRegister).toHaveBeenCalledWith({ token: TOKEN, platform: 'ios' }),
    );
    expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: PROJECT_ID });
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockSetPushConsent).not.toHaveBeenCalled();

    // Back to the app: the phone is checked again, and the token is not registered twice.
    const listeners = (AppState.addEventListener as jest.Mock).mock.calls;
    await act(async () => {
      for (const [, listener] of listeners) (listener as (state: string) => void)('active');
    });
    await waitFor(() =>
      expect(mockNotifications.getPermissionsAsync.mock.calls.length).toBeGreaterThan(2),
    );
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('registers nothing before sign-in', async () => {
    phone.allows = 'granted';
    mockMe.mockRejectedValue(guardError(401, 'not_authenticated', 'Sign in'));
    await render(
      <App>
        <Text>Signed out</Text>
      </App>,
    );
    await waitFor(() => expect(mockNotifications.getPermissionsAsync).toHaveBeenCalled());
    await act(async () => undefined);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('Home asks only once the tenancies are on the screen; Turn on asks the phone, then registers, then records consent', async () => {
    let release: (value: unknown) => void = () => undefined;
    mockTenancies.mockReturnValue(new Promise((resolve) => (release = resolve)));
    await render(
      <App>
        <Home />
      </App>,
    );
    expect(await screen.findByText('Hello, Abena Mensah')).toBeOnTheScreen();
    await act(async () => undefined);
    expect(screen.queryByTestId('push-prompt')).not.toBeOnTheScreen();

    await act(async () => release([]));
    expect(await screen.findByTestId('push-prompt')).toHaveTextContent(
      /when a receipt is ready, when rent is due and when your landlord writes to you/,
    );
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('push-turn-on'));
    expect(await screen.findByTestId('push-on')).toHaveTextContent(/Notifications are on/);
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith({ token: TOKEN, platform: 'ios' });
    expect(mockSetPushConsent).toHaveBeenCalledWith({ granted: true });
    expect(order(mockNotifications.requestPermissionsAsync)).toBeLessThan(order(mockRegister));
    expect(order(mockRegister)).toBeLessThan(order(mockSetPushConsent));
    expect(screen.queryByTestId('push-prompt')).not.toBeOnTheScreen();
  });

  it('Not now puts the prompt away for this person on this phone', async () => {
    const first = await render(
      <App>
        <Home />
      </App>,
    );
    await fireEvent.press(await screen.findByTestId('push-not-now'));
    expect(screen.queryByTestId('push-prompt')).not.toBeOnTheScreen();
    await first.unmount();

    await render(
      <App>
        <Home />
      </App>,
    );
    await screen.findByTestId('no-tenancies');
    await act(async () => undefined);
    expect(screen.queryByTestId('push-prompt')).not.toBeOnTheScreen();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('a phone that says no records no consent, and says where to change it', async () => {
    phone.answers = 'denied';
    await render(
      <App>
        <Home />
      </App>,
    );
    await fireEvent.press(await screen.findByTestId('push-turn-on'));
    expect(await screen.findByTestId('push-denied')).toHaveTextContent(/phone’s settings/);
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockSetPushConsent).not.toHaveBeenCalled();
  });

  it('signing out removes this device’s token while the session still works', async () => {
    phone.allows = 'granted';
    await render(
      <App>
        <Profile />
      </App>,
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    await fireEvent.press(await screen.findByTestId('sign-out'));
    await waitFor(() => expect(mockAuthSignOut).toHaveBeenCalled());
    expect(mockUnregister).toHaveBeenCalledWith({ token: TOKEN });
    expect(order(mockUnregister)).toBeLessThan(order(mockAuthSignOut));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/sign-in'));
  });

  it('the web build has no push, and Profile says how the landlord reaches the tenant instead', async () => {
    expect(webPush.pushSupported).toBe(false);
    expect(webPush.devicePlatform).toBe('web');
    expect(await webPush.permission()).toBe('denied');
    expect(await webPush.deviceToken()).toBeNull();
    expect(await webPush.launchTap()).toBeNull();

    // Without push (outside the provider, as on the web), Profile has no toggle.
    await render(
      <SessionProvider>
        <Profile />
      </SessionProvider>,
    );
    expect(await screen.findByTestId('push-unavailable')).toHaveTextContent(
      /WhatsApp, SMS or email/,
    );
    expect(screen.queryByTestId('push-toggle')).not.toBeOnTheScreen();
    expect(mockPushConsent).not.toHaveBeenCalled();
  });
});

describe('CM-09 the push consent toggle in Profile', () => {
  it('shows a switch for each landlord; turning one off records it for that landlord only', async () => {
    phone.allows = 'granted';
    await render(
      <App>
        <Profile />
      </App>,
    );
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    const toggles = await screen.findAllByTestId('push-toggle');
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toHaveAccessibleName(`Notifications from ${AGENCY.name}`);
    expect(toggles[1]).toHaveAccessibleName(`Notifications from ${LANDLORD.name}`);
    expect(toggles[1]).toHaveProp('value', true);

    await fireEvent(toggles[1]!, 'valueChange', false);
    await waitFor(() => expect(screen.getAllByTestId('push-toggle')[1]).toHaveProp('value', false));
    expect(mockSetPushConsent).toHaveBeenCalledWith({
      granted: false,
      companyId: LANDLORD.companyId,
    });
    expect(screen.getAllByTestId('push-toggle')[0]).toHaveProp('value', true);
    expect(mockUnregister).not.toHaveBeenCalled();

    // The last one off: no landlord may send any, so this device's token goes too.
    await fireEvent(screen.getAllByTestId('push-toggle')[0]!, 'valueChange', false);
    await waitFor(() => expect(mockUnregister).toHaveBeenCalledWith({ token: TOKEN }));
    expect(mockSetPushConsent).toHaveBeenLastCalledWith({
      granted: false,
      companyId: AGENCY.companyId,
    });
  });

  it('turning one on asks the phone first when it has not been asked, then records it', async () => {
    consent = [{ companyId: AGENCY.companyId, landlordName: AGENCY.name, granted: false }];
    await render(
      <App>
        <Profile />
      </App>,
    );
    const [toggle] = await screen.findAllByTestId('push-toggle');
    expect(toggle).toHaveProp('value', false);
    await fireEvent(toggle!, 'valueChange', true);
    await waitFor(() => expect(screen.getAllByTestId('push-toggle')[0]).toHaveProp('value', true));
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith({ token: TOKEN, platform: 'ios' });
    expect(mockSetPushConsent).toHaveBeenCalledWith({ granted: true, companyId: AGENCY.companyId });
    expect(order(mockNotifications.requestPermissionsAsync)).toBeLessThan(
      order(mockSetPushConsent),
    );
  });

  it('a phone that blocks notifications: says to allow them in settings, and records nothing', async () => {
    phone.allows = 'denied';
    consent = [{ companyId: AGENCY.companyId, landlordName: AGENCY.name, granted: false }];
    await render(
      <App>
        <Profile />
      </App>,
    );
    expect(await screen.findByTestId('push-blocked')).toHaveTextContent(/phone’s settings/);
    const [toggle] = await screen.findAllByTestId('push-toggle');
    await fireEvent(toggle!, 'valueChange', true);
    await act(async () => undefined);
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockSetPushConsent).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('push-toggle')[0]).toHaveProp('value', false);
  });
});

describe('CM-05 opening the right screen from a notification', () => {
  it('maps what a notification names to a screen, and nothing else', () => {
    expect(
      hrefForPush({ screen: 'receipt', receiptId: '0193a7c0-0000-7000-8000-0000000000ea' }),
    ).toBe('/payments');
    expect(hrefForPush({ screen: 'payments' })).toBe('/payments');
    expect(hrefForPush({ screen: 'messages', companyId: AGENCY.companyId })).toBe(
      `/messages/${AGENCY.companyId}`,
    );
    expect(hrefForPush({ screen: 'messages', companyId: '../../payments' })).toBe('/messages');
    expect(hrefForPush({ screen: 'to_sign' })).toBe('/to-sign');
    expect(
      hrefForPush({ screen: 'tenancy', leaseId: '0193a7c0-0000-7000-8000-0000000000a1' }),
    ).toBe('/tenancy/0193a7c0-0000-7000-8000-0000000000a1');
    expect(hrefForPush({ screen: 'tenancy', leaseId: 'x' })).toBe('/home');
    // By message purpose, when the notification names no screen.
    expect(hrefForPush({ purpose: 'receipt' })).toBe('/payments');
    expect(hrefForPush({ purpose: 'signing_link' })).toBe('/to-sign');
    expect(hrefForPush({ purpose: 'conversation_reply', companyId: LANDLORD.companyId })).toBe(
      `/messages/${LANDLORD.companyId}`,
    );
    expect(hrefForPush({ purpose: 'rent_reminder' })).toBe('/home');
    // Never a path, a URL or anything unknown that the notification carries.
    expect(hrefForPush({ screen: '/payments' })).toBeNull();
    expect(hrefForPush({ screen: 'https://evil.example/pay' })).toBeNull();
    expect(hrefForPush({ url: '/payments' })).toBeNull();
    expect(hrefForPush({ purpose: 'constructor' })).toBeNull();
    expect(hrefForPush(null)).toBeNull();
    expect(hrefForPush('messages')).toBeNull();
  });

  it('a tap while the app runs opens that landlord’s thread', async () => {
    await render(
      <App>
        <Text>Home</Text>
      </App>,
    );
    await screen.findByText('Home');
    const listener = await tapListener();
    await act(async () => listener(tapped({ screen: 'messages', companyId: AGENCY.companyId })));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/messages/${AGENCY.companyId}`));

    // A dismissal, or an action other than opening it, opens nothing.
    mockPush.mockClear();
    await act(async () => listener(tapped({ screen: 'payments' }, 'expo.dismiss')));
    await act(async () => listener(tapped({ screen: 'https://evil.example/' })));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('the tap that opened the app waits for sign-in and the start screen, then opens once', async () => {
    mockNotifications.getLastNotificationResponseAsync.mockResolvedValue(
      tapped({ screen: 'receipt' }),
    );
    mockPath.current = '/';
    const view = await render(
      <App>
        <Text>Starting</Text>
      </App>,
    );
    await waitFor(() =>
      expect(mockNotifications.clearLastNotificationResponseAsync).toHaveBeenCalled(),
    );
    await act(async () => undefined);
    expect(mockPush).not.toHaveBeenCalled();

    mockPath.current = '/home';
    await view.rerender(
      <App>
        <Text>Home</Text>
      </App>,
    );
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/payments'));
    await view.rerender(
      <App>
        <Text>Home again</Text>
      </App>,
    );
    await act(async () => undefined);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('shows a notification that arrives while the app is open as the phone shows it, adding nothing', async () => {
    await render(
      <App>
        <Text>Home</Text>
      </App>,
    );
    await waitFor(() => expect(mockNotifications.setNotificationHandler).toHaveBeenCalled());
    const handler = mockNotifications.setNotificationHandler.mock.calls[0]![0] as {
      handleNotification: () => Promise<Record<string, boolean>>;
    };
    expect(await handler.handleNotification()).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    expect(screen.queryByText(/A message from Osu Ridge/)).not.toBeOnTheScreen();
  });
});
