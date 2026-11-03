import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Text } from 'react-native';
import Home from '../app/home';
import { cacheable } from '../src/cache';
import { apiError, guardError, ME, TWO_LANDLORDS } from './fixtures';
import {
  AGENCY_LEASE,
  billing,
  BILLING,
  LANDLORD_LEASE,
  PAY_LINK,
  TWO_YEARLY,
} from './money-fixtures';

const mockPush = jest.fn();
const mockExpire = jest.fn();
const mockTenancies = jest.fn();
const mockSigning = jest.fn();
const mockBilling = jest.fn();
const mockPayLink = jest.fn();
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss', OPENED: 'opened' },
}));
jest.mock('../src/session', () => ({ useSession: () => mockSession }));
jest.mock('../src/api', () => ({
  api: {
    tenantApp: {
      tenancies: (...args: unknown[]) => mockTenancies(...args),
      signing: (...args: unknown[]) => mockSigning(...args),
    },
    tenantMoney: {
      billing: (...args: unknown[]) => mockBilling(...args),
      payLink: (...args: unknown[]) => mockPayLink(...args),
    },
  },
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;
const offline = () => new TypeError('Network request failed');

function appStateListener(): (state: string) => void {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls;
  return calls[calls.length - 1][1];
}

/** Everything written to the console during a test, to prove a link never is. */
function consoleOutput(): string {
  return (['log', 'info', 'warn', 'error', 'debug'] as const)
    .flatMap((method) => (console[method] as jest.Mock).mock.calls)
    .map((args) => args.map(String).join(' '))
    .join('\n');
}

/** Everything the app has put in the device's store. */
async function stored(): Promise<string> {
  const keys = await AsyncStorage.getAllKeys();
  const pairs = await AsyncStorage.multiGet(keys);
  return JSON.stringify(pairs);
}

/** A Fact shows its label, then its value: the value is what ends its text. */
const ends = (value: string) => new RegExp(value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&') + '$');

async function groups() {
  const found = await screen.findAllByTestId('landlord-group');
  await waitFor(() => expect(screen.getAllByTestId('tenancy-money')).toHaveLength(2));
  return found;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    jest.spyOn(console, method).mockImplementation(() => undefined);
  mockTenancies.mockResolvedValue(TWO_LANDLORDS);
  mockSigning.mockResolvedValue([]);
  mockBilling.mockImplementation(({ leaseId }: { leaseId: string }) =>
    Promise.resolve(BILLING[leaseId]),
  );
  mockPayLink.mockResolvedValue({ url: PAY_LINK, expiresAt: '2027-01-02T10:00:00.000Z' });
  openBrowser.mockResolvedValue({ type: 'cancel' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TL-01 and BC-04 the tenant app’s money screens: Home', () => {
  it('shows each tenancy’s balance, paid-until and next payment, in words, from integer pesewas', async () => {
    await render(<Home />);
    const [agency, landlord] = await groups();

    const own = within(agency!);
    expect(own.getByTestId('due-now')).toHaveTextContent(ends('GH₵2,200.00'));
    expect(own.getByTestId('paid-until')).toHaveTextContent(ends('Paid until 31 October 2026'));
    expect(own.getByTestId('next-due')).toHaveTextContent(ends('GH₵2,200.00 on 1 December 2026'));
    expect(own.getByTestId('payment-reference')).toHaveTextContent('Payment reference ELG105-4K');
    expect(own.queryByTestId('credit')).not.toBeOnTheScreen();
    expect(own.getByTestId('pay')).toBeOnTheScreen();

    const other = within(landlord!);
    expect(other.getByTestId('due-now')).toHaveTextContent(ends('Nothing due now'));
    expect(other.getByTestId('paid-until')).toHaveTextContent(
      ends('Paid until 14 May 2027, and GH₵1,200.50 paid towards the month from 15 May 2027'),
    );
    expect(other.getByTestId('next-due')).toHaveTextContent(ends('GH₵27,003.00 on 15 May 2027'));
    expect(other.getByTestId('credit')).toHaveTextContent(
      ends('GH₵1,200.50, kept for the months ahead'),
    );
    // When the landlord cannot take payments, the API says why, and there is no Pay.
    expect(other.queryByTestId('pay')).not.toBeOnTheScreen();
    expect(other.getByTestId('cannot-pay')).toHaveTextContent(/not taking payments in the app/);

    expect(mockBilling).toHaveBeenCalledWith({ leaseId: AGENCY_LEASE });
    expect(mockBilling).toHaveBeenCalledWith({ leaseId: LANDLORD_LEASE });
  });

  it('asks nothing about money for a lease that is not signed yet', async () => {
    mockTenancies.mockResolvedValue([
      {
        ...TWO_LANDLORDS[0]!,
        tenancies: [{ ...TWO_LANDLORDS[0]!.tenancies[0]!, status: 'pending_signatures' }],
      },
    ]);
    await render(<Home />);
    expect(await screen.findByTestId('tenancy-card')).toBeOnTheScreen();
    expect(screen.queryByTestId('tenancy-money')).not.toBeOnTheScreen();
    expect(mockBilling).not.toHaveBeenCalled();
  });

  it('Pay asks for a fresh pay link and opens the pay page, then reloads the figures', async () => {
    await render(<Home />);
    const [agency] = await groups();
    mockBilling.mockResolvedValue(billing({ dueNowMinor: 0, paidUntil: '2026-11-30' }));
    await fireEvent.press(within(agency!).getByTestId('pay'));

    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(mockPayLink).toHaveBeenCalledWith({ leaseId: AGENCY_LEASE });
    expect(openBrowser.mock.calls[0]![0]).toBe(PAY_LINK);
    // The in-app browser closed: the figures reload at once.
    await waitFor(() =>
      expect(within(agency!).getByTestId('due-now')).toHaveTextContent(ends('Nothing due now')),
    );
    expect(within(agency!).getByTestId('paid-until')).toHaveTextContent(
      ends('Paid until 30 November 2026'),
    );
    // The link is used once: never written down, logged or kept.
    expect(await stored()).not.toContain('Tz8wzlGq2fz3T8ulnkmXH5m9vDkYB1dC0aCqfbnT2Xw');
    expect(consoleOutput()).not.toContain('Tz8wzlGq2fz3T8ulnkmXH5m9vDkYB1dC0aCqfbnT2Xw');
  });

  it('reloads each tenancy’s figures when the app comes back to the foreground', async () => {
    await render(<Home />);
    await groups();
    expect(mockBilling).toHaveBeenCalledTimes(2);
    mockBilling.mockResolvedValue(billing({ dueNowMinor: 110_000 }));
    await act(async () => appStateListener()('active'));
    await waitFor(() => expect(mockBilling).toHaveBeenCalledTimes(4));
    expect(mockTenancies).toHaveBeenCalledTimes(2);
  });

  it('explains why the pay page could not be opened', async () => {
    mockPayLink.mockRejectedValueOnce(
      apiError(409, 'NO_SETTLEMENT_DESTINATION', 'Your landlord cannot take payments online yet.'),
    );
    await render(<Home />);
    const [agency] = await groups();
    await fireEvent.press(within(agency!).getByTestId('pay'));
    expect(await within(agency!).findByTestId('pay-error')).toHaveTextContent(
      'Your landlord cannot take payments online yet.',
    );
    expect(openBrowser).not.toHaveBeenCalled();

    mockPayLink.mockRejectedValueOnce(apiError(404, 'NOT_FOUND'));
    await fireEvent.press(within(agency!).getByTestId('pay'));
    await waitFor(() =>
      expect(within(agency!).getByTestId('pay-error')).toHaveTextContent(
        'Nothing is waiting to be paid on this lease just now.',
      ),
    );
  });

  it('sends the tenant to sign in when the session has ended', async () => {
    mockPayLink.mockRejectedValue(guardError(401, 'not_authenticated', 'Sign in to continue'));
    await render(<Home />);
    const [agency] = await groups();
    await fireEvent.press(within(agency!).getByTestId('pay'));
    await waitFor(() => expect(mockExpire).toHaveBeenCalled());
  });

  it('shows nothing about money for a lease the API does not bill, and says so when it fails', async () => {
    mockBilling.mockImplementation(({ leaseId }: { leaseId: string }) =>
      leaseId === AGENCY_LEASE
        ? Promise.reject(apiError(404, 'NOT_FOUND'))
        : Promise.reject(apiError(500, 'INTERNAL_SERVER_ERROR')),
    );
    await render(<Home />);
    const [agency, landlord] = await screen.findAllByTestId('landlord-group');
    expect(await within(landlord!).findByTestId('money-error')).toHaveTextContent(
      /could not load what is due/,
    );
    expect(within(agency!).queryByTestId('money-error')).not.toBeOnTheScreen();
    expect(within(agency!).queryByTestId('tenancy-money')).not.toBeOnTheScreen();
  });

  it('says the next invoice is not out yet for a new lease, not that nothing more is owed', async () => {
    mockBilling.mockImplementation(({ leaseId }: { leaseId: string }) =>
      Promise.resolve({ ...BILLING[leaseId]!, nextDue: null, paidUntil: null, partial: null }),
    );
    await render(<Home />);
    const [agency] = await groups();
    expect(within(agency!).getByTestId('next-due')).toHaveTextContent(
      ends('The next invoice is not out yet'),
    );
    expect(within(agency!).getByTestId('paid-until')).toHaveTextContent(ends('No rent paid yet'));
  });

  it('opens payments and receipts', async () => {
    await render(<Home />);
    await groups();
    await fireEvent.press(screen.getByTestId('open-payments'));
    expect(mockPush).toHaveBeenCalledWith('/payments');
  });
});

describe('TL-12 one landlord never sees another landlord’s money', () => {
  it('keeps each landlord’s figures, reference and Pay in that landlord’s box', async () => {
    await render(<Home />);
    const [agency, landlord] = await groups();
    const own = within(agency!);
    const other = within(landlord!);
    expect(own.getAllByTestId('tenancy-money')).toHaveLength(1);
    expect(other.getAllByTestId('tenancy-money')).toHaveLength(1);
    expect(own.queryByText(/TEM101-9Z/)).not.toBeOnTheScreen();
    expect(own.queryByText(/GH₵27,003.00/)).not.toBeOnTheScreen();
    expect(own.queryByText(/GH₵1,200.50/)).not.toBeOnTheScreen();
    expect(other.queryByText(/ELG105-4K/)).not.toBeOnTheScreen();
    expect(other.queryByText(/GH₵2,200.00/)).not.toBeOnTheScreen();
    // Nothing adds the landlords' figures up.
    expect(screen.queryByText(/GH₵2,200.00.*GH₵27,003.00|total/i)).not.toBeOnTheScreen();
    // Each Pay asks only for its own lease.
    await fireEvent.press(own.getByTestId('pay'));
    await waitFor(() => expect(mockPayLink).toHaveBeenCalledTimes(1));
    expect(mockPayLink).toHaveBeenCalledWith({ leaseId: AGENCY_LEASE });
  });
});

describe('TL-01 and BC-04 the tenant app’s money screens: offline cache', () => {
  it('shows the last figures, with the time they were fetched, when the API cannot be reached', async () => {
    const online = await render(<Home />);
    await groups();
    await online.unmount();

    // Later, with no connection.
    mockTenancies.mockRejectedValue(offline());
    mockBilling.mockRejectedValue(offline());
    await render(<Home />);
    expect(await screen.findByTestId('offline')).toHaveTextContent(
      /You are offline\. This is what we last fetched, at .+ \(Africa\/Accra\), so it may be out of date\./,
    );
    const [agency, landlord] = await groups();
    expect(within(agency!).getByTestId('due-now')).toHaveTextContent(ends('GH₵2,200.00'));
    expect(within(agency!).getByTestId('money-as-of')).toHaveTextContent(
      'As of 3 Nov 2026, 09:15 GMT (Africa/Accra). You are offline, so this may be out of date. Connect to the internet to pay.',
    );
    expect(within(landlord!).getByTestId('paid-until')).toHaveTextContent(
      ends('Paid until 14 May 2027, and GH₵1,200.50 paid towards the month from 15 May 2027'),
    );
    // No Pay while offline: it needs the API.
    expect(screen.queryByTestId('pay')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('error')).not.toBeOnTheScreen();

    // Back online, "Try again" brings fresh figures and the notice goes.
    mockTenancies.mockResolvedValue(TWO_LANDLORDS);
    mockBilling.mockImplementation(({ leaseId }: { leaseId: string }) =>
      Promise.resolve(BILLING[leaseId]),
    );
    await fireEvent.press(screen.getByTestId('retry-offline'));
    await waitFor(() => expect(screen.queryByTestId('offline')).not.toBeOnTheScreen());
    await act(async () => appStateListener()('active'));
    await waitFor(() => expect(screen.getAllByTestId('pay')).toHaveLength(1));
  });

  it('keeps the figures it has when a reload finds the device offline', async () => {
    await render(<Home />);
    const [agency] = await groups();
    mockBilling.mockRejectedValue(offline());
    await act(async () => appStateListener()('active'));
    expect(await within(agency!).findByTestId('money-as-of')).toHaveTextContent(
      /may be out of date/,
    );
    expect(within(agency!).getByTestId('due-now')).toHaveTextContent(ends('GH₵2,200.00'));
  });

  it('shows the error, not an empty screen, when nothing was cached yet', async () => {
    mockTenancies.mockRejectedValue(offline());
    await render(<Home />);
    expect(await screen.findByTestId('error')).toHaveTextContent(/could not reach the server/);
    expect(screen.queryByTestId('offline')).not.toBeOnTheScreen();
  });

  it('never falls back to the cache when the API refuses', async () => {
    const online = await render(<Home />);
    await groups();
    await online.unmount();
    mockTenancies.mockRejectedValue(apiError(500, 'INTERNAL_SERVER_ERROR'));
    await render(<Home />);
    expect(await screen.findByTestId('error')).toHaveTextContent(/could not load your tenancies/);
    expect(screen.queryByTestId('landlord-group')).not.toBeOnTheScreen();
  });

  it('keeps each person’s figures apart on a shared device', async () => {
    const online = await render(<Home />);
    await groups();
    await online.unmount();
    const someoneElse = { ...ME, personId: '0193a7c0-0000-7000-8000-0000000000bb' };
    Object.assign(mockSession, { me: someoneElse });
    try {
      mockTenancies.mockRejectedValue(offline());
      await render(<Home />);
      expect(await screen.findByTestId('error')).toHaveTextContent(/could not reach the server/);
      expect(screen.queryByText('ACC-ELG-B1-05')).not.toBeOnTheScreen();
    } finally {
      Object.assign(mockSession, { me: ME });
    }
  });

  it('never stores a link or a token', async () => {
    await render(<Home />);
    await groups();
    const saved = await stored();
    expect(saved).toContain('ELG105-4K');
    expect(saved).not.toMatch(/https?:/);
    expect(cacheable(JSON.stringify({ url: PAY_LINK }))).toBe(false);
    expect(
      cacheable(JSON.stringify({ path: '/l/Tz8wzlGq2fz3T8ulnkmXH5m9vDkYB1dC0aCqfbnT2Xw' })),
    ).toBe(false);
    expect(cacheable(JSON.stringify(BILLING))).toBe(true);
  });
});

describe('TL-06 and M4b decision 9 the two-yearly cycle in the tenant app', () => {
  it('names the cycle and shows the next payment, 24 months of rent', async () => {
    mockTenancies.mockResolvedValue(TWO_YEARLY);
    mockBilling.mockResolvedValue(
      billing({
        leaseId: LANDLORD_LEASE,
        dueNowMinor: 0,
        paidUntil: '2026-11-14',
        nextDue: { dueDate: '2026-11-15', amountMinor: 24 * 450_050 },
      }),
    );
    await render(<Home />);
    const [group] = await screen.findAllByTestId('landlord-group');
    expect(within(group!).getByText('GH₵4,500.50 a month, paid every two years')).toBeOnTheScreen();
    expect(await within(group!).findByTestId('next-due')).toHaveTextContent(
      ends('GH₵108,012.00 on 15 November 2026'),
    );
  });
});
