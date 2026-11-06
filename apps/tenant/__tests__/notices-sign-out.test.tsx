import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import TenancyScreen from '../app/tenancy/[leaseId]';
import { readCache } from '../src/cache';
import { SessionProvider, useSession } from '../src/session';
import { AGENCY, detail, ME } from './fixtures';

// M7 review round (LT 5): the notices kept for offline reading go when the tenant signs out, so a
// shared phone keeps none of them (TL-12).

const mockMe = jest.fn();
const mockTenancy = jest.fn();
const mockNotices = jest.fn();
const mockParams = { leaseId: '0193a7c0-0000-7000-8000-0000000000a1' };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss', OPENED: 'opened' },
}));
jest.mock('../src/api', () => ({
  api: {
    me: { get: (...args: unknown[]) => mockMe(...args) },
    tenantApp: {
      tenancy: (...args: unknown[]) => mockTenancy(...args),
      notices: (...args: unknown[]) => mockNotices(...args),
    },
  },
}));
jest.mock('../src/auth-client', () => ({
  authClient: { signOut: jest.fn(() => Promise.resolve()) },
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

function SignOut() {
  const { signOut } = useSession();
  return (
    <Text testID="sign-out" onPress={() => void signOut()}>
      Sign out
    </Text>
  );
}

/** Signed in until long after any run of these tests. */
const TENANT = { ...ME, sessionExpiresAt: '2099-01-01T00:00:00.000Z' };

beforeEach(() => {
  jest.clearAllMocks();
  mockMe.mockResolvedValue(TENANT);
  mockTenancy.mockResolvedValue(detail());
  mockNotices.mockResolvedValue([
    {
      landlord: AGENCY,
      notices: [
        {
          noticeId: '0193a7c0-0000-7000-8000-00000000f001',
          number: 'N-000007',
          typeLabel: 'Notice of entry',
          issuedAt: '2026-11-04T09:00:00.000Z',
          effectiveDate: '2026-11-20',
          leaseId: mockParams.leaseId,
          unitCode: 'ACC-ELG-B1-05',
          acknowledged: false,
          acknowledgedAt: null,
          superseded: false,
          closed: false,
          signerId: '0193a7c0-0000-7000-8000-0000000000c1',
        },
      ],
    },
  ]);
});

describe('TL-12 signing out empties the notices kept on the phone', () => {
  it('the tenancy’s notices are cached for offline reading, and gone after sign-out', async () => {
    await render(
      <SessionProvider>
        <TenancyScreen />
        <SignOut />
      </SessionProvider>,
    );
    expect(await screen.findByTestId('tenancy-notices')).toBeOnTheScreen();
    await waitFor(async () => expect(await readCache(TENANT.personId, 'notices')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('sign-out'));
    expect(await screen.findByText('Redirected to /sign-in')).toBeOnTheScreen();
    expect(await readCache(TENANT.personId, 'notices')).toBeNull();
    const kept = JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys()));
    expect(kept).not.toContain('N-000007');
  });
});
