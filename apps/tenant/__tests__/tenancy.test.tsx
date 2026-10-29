import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text } from 'react-native';
import TenancyScreen from '../app/tenancy/[leaseId]';
import { apiError, detail, guardError, ME } from './fixtures';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockExpire = jest.fn();
const mockTenancy = jest.fn();
const mockDownload = jest.fn();
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };
const mockParams = { leaseId: '0193a7c0-0000-7000-8000-0000000000a1' };
const SIGNED_COPY_URL = 'http://localhost:8333/rent-evidence/lease-scan?X-Amz-Signature=abc123';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: mockBack, canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
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
      tenancy: (...args: unknown[]) => mockTenancy(...args),
      documentDownload: (...args: unknown[]) => mockDownload(...args),
    },
  },
}));

// A function declaration, so it exists when the hoisted mock factory runs.
function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;

/** A fact's text: its label, then exactly this value. */
const value = (label: string, text: string): string => `${label}${text}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockTenancy.mockResolvedValue(detail());
  mockDownload.mockResolvedValue({ url: SIGNED_COPY_URL });
  openBrowser.mockResolvedValue({ type: 'cancel' });
});

describe('TL-01 tenancy detail', () => {
  it('shows the lease terms with amounts and dates in words', async () => {
    await render(<TenancyScreen />);
    expect(await screen.findByText('ACC-ELG-B1-05')).toBeOnTheScreen();
    expect(mockTenancy).toHaveBeenCalledWith({ leaseId: mockParams.leaseId });
    expect(screen.getByTestId('tenancy-status')).toHaveTextContent('Active');
    expect(screen.getByText('East Legon flats')).toBeOnTheScreen();
    expect(screen.getByText('12 Lagos Avenue, East Legon, Greater Accra')).toBeOnTheScreen();
    expect(screen.getByTestId('landlord-name')).toHaveTextContent(
      'Rented from Osu Ridge Property Managers',
    );
    expect(screen.getByTestId('fact-dates')).toHaveTextContent(
      value('Dates', '1 September 2026 to 31 August 2027'),
    );
    expect(screen.getByTestId('fact-rent')).toHaveTextContent(
      value('Rent', 'GH₵2,200.00 a month, paid monthly'),
    );
    expect(screen.getByTestId('fact-steps')).toHaveTextContent(
      value('Rent changes', 'From 1 March 2027: GH₵2,350.50 a month'),
    );
    expect(screen.getByTestId('fact-deposit')).toHaveTextContent(value('Deposit', 'GH₵4,400.00'));
    expect(screen.getByTestId('fact-service-charge')).toHaveTextContent(
      value('Service charge', 'GH₵150.00 a month'),
    );
    expect(screen.getByTestId('fact-notice')).toHaveTextContent(value('Notice period', '60 days'));
    expect(screen.getByTestId('signed-how')).toHaveTextContent('Signed on paper.');
  });

  it('says "None" for a deposit or service charge the lease does not have', async () => {
    mockTenancy.mockResolvedValue(
      detail({
        depositMinor: null,
        serviceChargeMonthlyMinor: null,
        steps: [],
        cycle: 'annual',
        signedOnPaper: false,
      }),
    );
    await render(<TenancyScreen />);
    expect(await screen.findByTestId('fact-deposit')).toHaveTextContent(value('Deposit', 'None'));
    expect(screen.getByTestId('fact-service-charge')).toHaveTextContent(
      value('Service charge', 'None'),
    );
    expect(screen.queryByTestId('fact-steps')).not.toBeOnTheScreen();
    expect(screen.getByTestId('fact-rent')).toHaveTextContent(
      value('Rent', 'GH₵2,200.00 a month, paid annually'),
    );
    expect(screen.getByTestId('signed-how')).toHaveTextContent('Signed electronically.');
  });

  it('downloads the signed copy through a fresh short-lived link', async () => {
    await render(<TenancyScreen />);
    await fireEvent.press(await screen.findByTestId('download-signed'));
    await waitFor(() =>
      expect(mockDownload).toHaveBeenCalledWith({
        documentId: '0193a7c0-0000-7000-8000-0000000000d1',
      }),
    );
    await waitFor(() =>
      expect(openBrowser).toHaveBeenCalledWith(SIGNED_COPY_URL, expect.any(Object)),
    );
    expect(screen.queryByTestId('download-error')).not.toBeOnTheScreen();
  });

  it('explains a signed copy that cannot be found', async () => {
    mockDownload.mockRejectedValue(apiError(404, 'NOT_FOUND', 'Document not found'));
    await render(<TenancyScreen />);
    await fireEvent.press(await screen.findByTestId('download-signed'));
    expect(await screen.findByTestId('download-error')).toHaveTextContent(
      /could not find the signed copy/,
    );
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('offers no download when there is no signed copy', async () => {
    mockTenancy.mockResolvedValue(detail({ documentId: null }));
    await render(<TenancyScreen />);
    await screen.findByTestId('tenancy-detail');
    expect(screen.queryByTestId('download-signed')).not.toBeOnTheScreen();
  });

  it('points a lease that is waiting for signatures to To sign', async () => {
    mockTenancy.mockResolvedValue(
      detail({ status: 'pending_signatures', signedOnPaper: false, documentId: null }),
    );
    await render(<TenancyScreen />);
    expect(await screen.findByTestId('tenancy-status')).toHaveTextContent('Waiting for signatures');
    expect(screen.getByTestId('signed-how')).toHaveTextContent(/waiting for signatures/);
    await fireEvent.press(screen.getByTestId('go-to-sign'));
    expect(mockPush).toHaveBeenCalledWith('/to-sign');
  });

  it('says a tenancy that cannot be found was not found', async () => {
    mockTenancy.mockRejectedValue(apiError(404, 'NOT_FOUND', 'Tenancy not found'));
    await render(<TenancyScreen />);
    expect(await screen.findByText('Tenancy not found')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('back'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('treats an address that holds no lease id as not found', async () => {
    mockTenancy.mockRejectedValue(apiError(400, 'BAD_REQUEST', 'Input validation failed'));
    await render(<TenancyScreen />);
    expect(await screen.findByText('Tenancy not found')).toBeOnTheScreen();
    expect(screen.queryByText(/Input validation failed/)).not.toBeOnTheScreen();
  });

  it('sends the tenant to sign in when the session has ended', async () => {
    mockTenancy.mockRejectedValue(guardError(401, 'not_authenticated', 'Sign in to continue'));
    await render(<TenancyScreen />);
    await act(async () => {});
    expect(mockExpire).toHaveBeenCalled();
  });
});
