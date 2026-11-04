import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text } from 'react-native';
import Payments from '../app/payments';
import { apiError, guardError, ME, TWO_LANDLORDS } from './fixtures';
import { payment, PAYMENTS, RECEIPT_URL } from './money-fixtures';

const mockExpire = jest.fn();
const mockPayments = jest.fn();
const mockTenancies = jest.fn();
const mockReceipt = jest.fn();
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
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
    tenantApp: { tenancies: (...args: unknown[]) => mockTenancies(...args) },
    tenantMoney: {
      payments: (...args: unknown[]) => mockPayments(...args),
      receiptDownload: (...args: unknown[]) => mockReceipt(...args),
    },
  },
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockPayments.mockResolvedValue(PAYMENTS);
  mockTenancies.mockResolvedValue(TWO_LANDLORDS);
  mockReceipt.mockResolvedValue({ url: RECEIPT_URL });
  openBrowser.mockResolvedValue({ type: 'cancel' });
});

describe('TL-01 and BC-04 the tenant app’s money screens: payments and receipts', () => {
  it('lists each payment, newest first, with how it was paid and its receipt number', async () => {
    await render(<Payments />);
    const [agency] = await screen.findAllByTestId('landlord-payments');
    const rows = within(agency!).getAllByTestId('payment-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/GH₵500\.00/);
    expect(rows[0]).toHaveTextContent(/1 November 2026 · Card · ACC-ELG-B1-05/);
    expect(within(rows[0]!).getByTestId('receipt-number')).toHaveTextContent(
      'Receipt RCT-2026-000057',
    );
    expect(rows[1]).toHaveTextContent(/GH₵2,200\.00/);
    expect(rows[1]).toHaveTextContent(/1 October 2026 · Mobile money · ACC-ELG-B1-05/);
  });

  it('downloads a receipt through a short-lived link fetched at the tap, never kept', async () => {
    await render(<Payments />);
    const [agency] = await screen.findAllByTestId('landlord-payments');
    const [newest] = within(agency!).getAllByTestId('payment-row');
    await fireEvent.press(within(newest!).getByTestId('download-receipt'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(mockReceipt).toHaveBeenCalledWith({ receiptId: '0193a7c0-0000-7000-8000-0000000000ea' });
    expect(openBrowser.mock.calls[0]![0]).toBe(RECEIPT_URL);
    const keys = await AsyncStorage.getAllKeys();
    expect(JSON.stringify(await AsyncStorage.multiGet(keys))).not.toContain('X-Amz-Signature');
  });

  it('says when a receipt is not ready, and sends the tenant to sign in when the session ends', async () => {
    mockReceipt.mockRejectedValueOnce(apiError(404, 'NOT_FOUND'));
    await render(<Payments />);
    const [agency] = await screen.findAllByTestId('landlord-payments');
    const [newest] = within(agency!).getAllByTestId('payment-row');
    await fireEvent.press(within(newest!).getByTestId('download-receipt'));
    expect(await within(newest!).findByTestId('download-error')).toHaveTextContent(
      'Your receipt is not ready yet. Try again in a minute.',
    );
    mockReceipt.mockRejectedValueOnce(guardError(401, 'not_authenticated', 'Sign in'));
    await fireEvent.press(within(newest!).getByTestId('download-receipt'));
    await waitFor(() => expect(mockExpire).toHaveBeenCalled());
  });

  it('marks a reversed payment, and one whose receipt is still being prepared', async () => {
    mockPayments.mockResolvedValue([
      payment({ status: 'reversed' }),
      payment({
        id: '0193a7c0-0000-7000-8000-0000000000f9',
        receiptId: null,
        receiptNumber: null,
      }),
    ]);
    await render(<Payments />);
    const rows = await screen.findAllByTestId('payment-row');
    expect(rows[0]).toHaveTextContent(/Reversed/);
    expect(rows[0]).toHaveTextContent(/no longer counts towards your rent/);
    expect(rows[1]).toHaveTextContent(/The receipt is being prepared/);
    expect(within(rows[1]!).queryByTestId('download-receipt')).not.toBeOnTheScreen();
  });

  it('says so when there are no payments yet', async () => {
    mockPayments.mockResolvedValue([]);
    await render(<Payments />);
    expect(await screen.findByTestId('no-payments')).toHaveTextContent(/No payments yet/);
  });

  it('shows the last list fetched, with when, while offline', async () => {
    const online = await render(<Payments />);
    await screen.findAllByTestId('payment-row');
    await online.unmount();
    mockPayments.mockRejectedValue(new TypeError('Network request failed'));
    mockTenancies.mockRejectedValue(new TypeError('Network request failed'));
    await render(<Payments />);
    expect(await screen.findByTestId('offline')).toHaveTextContent(
      /You are offline\. This is the list we last fetched, at .+ \(Africa\/Accra\)/,
    );
    expect(screen.getAllByTestId('payment-row')).toHaveLength(3);
    // Still one box per landlord, from the cached tenancies.
    expect(screen.getAllByTestId('landlord-payments')).toHaveLength(2);
  });
});

describe('TL-12 one landlord never sees another landlord’s money', () => {
  it('keeps each landlord’s payments in that landlord’s box', async () => {
    await render(<Payments />);
    const [agency, landlord] = await screen.findAllByTestId('landlord-payments');
    expect(agency).toHaveAccessibleName('Paid to Osu Ridge Property Managers');
    expect(landlord).toHaveAccessibleName('Paid to Kwabena Owusu');
    expect(within(agency!).getAllByTestId('payment-row')).toHaveLength(2);
    expect(within(landlord!).getAllByTestId('payment-row')).toHaveLength(1);
    expect(within(agency!).queryByText(/KO-000012/)).not.toBeOnTheScreen();
    expect(within(agency!).queryByText(/TEM-EST-B1-01/)).not.toBeOnTheScreen();
    expect(within(landlord!).queryByText(/RCT-2026/)).not.toBeOnTheScreen();
    expect(
      within(landlord!).getByText(/15 May 2026 · Bank transfer · TEM-EST-B1-01/),
    ).toBeOnTheScreen();
  });

  it('keeps two landlords of the same name apart once the tenancies say whose lease it is', async () => {
    const sameName = TWO_LANDLORDS.map((group) => ({
      ...group,
      landlord: { ...group.landlord, name: 'Owusu Properties' },
    }));
    mockTenancies.mockResolvedValue(sameName);
    mockPayments.mockResolvedValue(
      PAYMENTS.map((p) => ({ ...p, landlordName: 'Owusu Properties' })),
    );
    await render(<Payments />);
    await waitFor(() => expect(screen.getAllByTestId('landlord-payments')).toHaveLength(2));
  });
});
