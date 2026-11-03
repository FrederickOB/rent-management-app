import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Text } from 'react-native';
import ToSign from '../app/to-sign';
import { apiError, guardError, ME, SIGNER_ID, signedItem, signingItem } from './fixtures';

const mockExpire = jest.fn();
const mockSigning = jest.fn();
const mockSigningLink = jest.fn();
const mockFocus: { effect: (() => void) | null } = { effect: null };
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };
const LINK = 'http://localhost:3702/l/Tz8wzlGq2fz3T8ulnkmXH5m9vDkYB1dC0aCqfbnT2Xw';

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useFocusEffect: (effect: () => void) => {
    mockFocus.effect = effect;
  },
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
      signing: (...args: unknown[]) => mockSigning(...args),
      signingLink: (...args: unknown[]) => mockSigningLink(...args),
    },
  },
}));

// A function declaration, so it exists when the hoisted mock factory runs.
function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;

function appStateListener(): (state: string) => void {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls;
  return calls[calls.length - 1][1];
}

/** Everything written to the console during a test, to prove the link never is. */
function consoleOutput(): string {
  return (['log', 'info', 'warn', 'error', 'debug'] as const)
    .flatMap((method) => (console[method] as jest.Mock).mock.calls)
    .map((args) => args.map(String).join(' '))
    .join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocus.effect = null;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    jest.spyOn(console, method).mockImplementation(() => undefined);
  mockSigning.mockResolvedValue([signingItem()]);
  mockSigningLink.mockResolvedValue({ url: LINK, expiresAt: '2026-11-28T17:05:00.000Z' });
  openBrowser.mockResolvedValue({ type: 'cancel' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TL-07 to sign', () => {
  it('lists each lease out for the tenant’s signature, with who else signs', async () => {
    await render(<ToSign />);
    const item = await screen.findByTestId('signing-item');
    expect(within(item).getByText('Tenancy agreement: ACC-ELG-B1-07')).toBeOnTheScreen();
    expect(within(item).getByText('From Osu Ridge Property Managers')).toBeOnTheScreen();
    expect(within(item).getByText('ACC-ELG-B1-07, East Legon flats')).toBeOnTheScreen();
    expect(within(item).getByText('Sent 29 Oct 2026, 17:05 GMT (Africa/Accra)')).toBeOnTheScreen();
    expect(within(item).getByTestId('own-status')).toHaveTextContent(/Waiting for your signature/);

    const others = within(within(item).getByTestId('other-signers'));
    expect(others.getByText(/Kofi Manager/)).toBeOnTheScreen();
    expect(others.getByText(/For the landlord/)).toBeOnTheScreen();
    expect(others.getByText(/Esi Witness/)).toBeOnTheScreen();
    expect(others.getAllByText('Not signed yet')).toHaveLength(1);
    expect(others.getAllByText('Signed')).toHaveLength(1);
    // The tenant's own entry is their signature above, not one of the others.
    expect(others.queryByText(/Abena Mensah/)).not.toBeOnTheScreen();
    expect(within(item).getByTestId('review-and-sign')).toBeOnTheScreen();
  });

  it('fetches a fresh link, opens the signing page in the app’s browser, then reloads', async () => {
    await render(<ToSign />);
    mockSigning.mockResolvedValue([signedItem()]);
    await fireEvent.press(await screen.findByTestId('review-and-sign'));

    await waitFor(() => expect(mockSigningLink).toHaveBeenCalledWith({ signerId: SIGNER_ID }));
    await waitFor(() => expect(openBrowser).toHaveBeenCalledWith(LINK, expect.any(Object)));
    // The browser has closed (iOS): the list is read again and shows the signature.
    await waitFor(() => expect(mockSigning).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('You have signed')).toBeOnTheScreen();
    expect(screen.getByText('Signed 29 Oct 2026, 17:20 GMT (Africa/Accra)')).toBeOnTheScreen();
    expect(screen.queryByTestId('review-and-sign')).not.toBeOnTheScreen();
    expect(consoleOutput()).not.toContain('/l/');
  });

  it('reloads when the app comes back from the browser (Android) or to this screen', async () => {
    openBrowser.mockResolvedValue({ type: 'opened' });
    await render(<ToSign />);
    await fireEvent.press(await screen.findByTestId('review-and-sign'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalled());
    // Android's custom tab answers at once: no reload until the app is back in front.
    expect(mockSigning).toHaveBeenCalledTimes(1);

    mockSigning.mockResolvedValue([signedItem()]);
    await act(async () => appStateListener()('active'));
    expect(mockSigning).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('You have signed')).toBeOnTheScreen();

    // The screen's first focus is its first load; a later one reloads.
    await act(async () => mockFocus.effect?.());
    expect(mockSigning).toHaveBeenCalledTimes(2);
    await act(async () => mockFocus.effect?.());
    expect(mockSigning).toHaveBeenCalledTimes(3);
  });

  it('explains a lease that is no longer out for signature, and shows the list as it is now', async () => {
    mockSigningLink.mockRejectedValue(
      apiError(409, 'LINK_UNAVAILABLE', 'This document is no longer out for signature'),
    );
    await render(<ToSign />);
    mockSigning.mockResolvedValue([]);
    await fireEvent.press(await screen.findByTestId('review-and-sign'));
    expect(await screen.findByTestId('action-error')).toHaveTextContent(
      'This document is no longer out for signature',
    );
    expect(await screen.findByTestId('nothing-to-sign')).toBeOnTheScreen();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('explains a signer that is not the tenant’s own pending signer', async () => {
    mockSigningLink.mockRejectedValue(apiError(404, 'NOT_FOUND', 'Signer not found'));
    await render(<ToSign />);
    await fireEvent.press(await screen.findByTestId('review-and-sign'));
    expect(await screen.findByTestId('action-error')).toHaveTextContent(
      'This lease is no longer waiting for your signature.',
    );
    await waitFor(() => expect(mockSigning).toHaveBeenCalledTimes(2));
  });

  it('explains a failed connection and lets the tenant try again', async () => {
    mockSigningLink.mockRejectedValueOnce(new TypeError('Network request failed'));
    await render(<ToSign />);
    await fireEvent.press(await screen.findByTestId('review-and-sign'));
    expect(await screen.findByTestId('action-error')).toHaveTextContent(
      /could not reach the server/,
    );
    await fireEvent.press(screen.getByTestId('review-and-sign'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalledWith(LINK, expect.any(Object)));
    await waitFor(() => expect(screen.queryByTestId('action-error')).not.toBeOnTheScreen());
  });

  it('sends the tenant to sign in when the session has ended', async () => {
    mockSigningLink.mockRejectedValue(guardError(401, 'not_authenticated', 'Sign in to continue'));
    await render(<ToSign />);
    await fireEvent.press(await screen.findByTestId('review-and-sign'));
    await waitFor(() => expect(mockExpire).toHaveBeenCalled());
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('offers no signing once the tenant has signed, and says the others are still to sign', async () => {
    mockSigning.mockResolvedValue([signedItem()]);
    await render(<ToSign />);
    const item = await screen.findByTestId('signing-item');
    expect(within(item).getByTestId('own-status')).toHaveTextContent(/You have signed/);
    expect(within(item).getByTestId('own-status')).toHaveTextContent(/When everyone has signed/);
    expect(within(item).queryByTestId('review-and-sign')).not.toBeOnTheScreen();
  });

  it('says when nothing is waiting, and when the list cannot be loaded', async () => {
    mockSigning.mockResolvedValueOnce([]);
    await render(<ToSign />);
    expect(await screen.findByTestId('nothing-to-sign')).toBeOnTheScreen();

    mockSigning.mockRejectedValueOnce(apiError(500, 'INTERNAL_SERVER_ERROR', 'Boom'));
    await fireEvent.press(screen.getByTestId('refresh'));
    expect(await screen.findByTestId('refresh-problem')).toHaveTextContent(/could not update/);
    expect(screen.getByTestId('nothing-to-sign')).toBeOnTheScreen();
  });
});
