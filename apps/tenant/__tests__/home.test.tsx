import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import Home from '../app/home';
import { apiError, guardError, ME, signedItem, signingItem, TWO_LANDLORDS } from './fixtures';

const mockPush = jest.fn();
const mockExpire = jest.fn();
const mockTenancies = jest.fn();
const mockSigning = jest.fn();
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('../src/session', () => ({ useSession: () => mockSession }));
jest.mock('../src/api', () => ({
  api: {
    tenantApp: {
      tenancies: (...args: unknown[]) => mockTenancies(...args),
      signing: (...args: unknown[]) => mockSigning(...args),
    },
  },
}));

// A function declaration, so it exists when the hoisted mock factory runs.
function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

/** The listener the screen gave AppState, to bring the app back to the foreground. */
function appStateListener(): (state: string) => void {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls;
  return calls[calls.length - 1][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTenancies.mockResolvedValue(TWO_LANDLORDS);
  mockSigning.mockResolvedValue([]);
});

describe('TL-01 tenancies by landlord', () => {
  it('shows each tenancy under the landlord it is rented from, with rent and dates in words', async () => {
    await render(<Home />);
    expect(await screen.findByText('Hello, Abena Mensah')).toBeOnTheScreen();
    const groups = await screen.findAllByTestId('landlord-group');
    expect(groups).toHaveLength(2);

    const agency = within(groups[0]!);
    expect(agency.getByText('Osu Ridge Property Managers')).toBeOnTheScreen();
    expect(agency.getByText('ACC-ELG-B1-05')).toBeOnTheScreen();
    expect(agency.getByText('East Legon flats')).toBeOnTheScreen();
    expect(agency.getByText('GH₵2,200.00 a month, paid monthly')).toBeOnTheScreen();
    expect(agency.getByText('1 September 2026 to 31 August 2027')).toBeOnTheScreen();
    expect(agency.getByText('Active')).toBeOnTheScreen();

    const landlord = within(groups[1]!);
    expect(landlord.getByText('Kwabena Owusu')).toBeOnTheScreen();
    expect(landlord.getByText('TEM-EST-B1-01')).toBeOnTheScreen();
    expect(landlord.getByText('GH₵4,500.50 a month, paid every six months')).toBeOnTheScreen();
    expect(landlord.getByText('15 May 2026 to 14 May 2028')).toBeOnTheScreen();
  });

  it('opens a tenancy', async () => {
    await render(<Home />);
    const [first] = await screen.findAllByTestId('tenancy-card');
    await fireEvent.press(first!);
    expect(mockPush).toHaveBeenCalledWith('/tenancy/0193a7c0-0000-7000-8000-0000000000a1');
  });

  it('says so when the tenant has no tenancies yet', async () => {
    mockTenancies.mockResolvedValue([]);
    await render(<Home />);
    expect(await screen.findByTestId('no-tenancies')).toHaveTextContent(/no tenancies yet/);
    expect(screen.queryByTestId('landlord-group')).not.toBeOnTheScreen();
  });

  it('explains a failure and tries again', async () => {
    mockTenancies.mockRejectedValueOnce(new TypeError('Network request failed'));
    await render(<Home />);
    expect(await screen.findByTestId('error')).toHaveTextContent(/could not reach the server/);
    await fireEvent.press(screen.getByTestId('retry'));
    expect(await screen.findAllByTestId('landlord-group')).toHaveLength(2);
    expect(mockTenancies).toHaveBeenCalledTimes(2);
  });

  it('sends the tenant to sign in when the session has ended', async () => {
    mockTenancies.mockRejectedValue(guardError(401, 'not_authenticated', 'Sign in to continue'));
    await render(<Home />);
    await act(async () => {});
    expect(mockExpire).toHaveBeenCalled();
  });

  it('reloads when the app comes back to the foreground', async () => {
    await render(<Home />);
    await screen.findAllByTestId('landlord-group');
    mockTenancies.mockResolvedValue([TWO_LANDLORDS[0]!]);
    await act(async () => appStateListener()('active'));
    expect(mockTenancies).toHaveBeenCalledTimes(2);
    expect(await screen.findAllByTestId('landlord-group')).toHaveLength(1);
  });
});

describe('TL-12 one landlord never sees another landlord’s tenancy', () => {
  it('keeps each landlord’s tenancies in a box of their own', async () => {
    await render(<Home />);
    const [agency, landlord] = await screen.findAllByTestId('landlord-group');
    expect(agency).toHaveAccessibleName('Rented from Osu Ridge Property Managers');
    expect(landlord).toHaveAccessibleName('Rented from Kwabena Owusu');
    expect(within(agency!).queryByText('TEM-EST-B1-01')).not.toBeOnTheScreen();
    expect(within(agency!).queryByText('Kwabena Owusu')).not.toBeOnTheScreen();
    expect(within(landlord!).queryByText('ACC-ELG-B1-05')).not.toBeOnTheScreen();
    expect(within(landlord!).queryByText('Osu Ridge Property Managers')).not.toBeOnTheScreen();
    expect(within(agency!).getAllByTestId('tenancy-card')).toHaveLength(1);
    expect(within(landlord!).getAllByTestId('tenancy-card')).toHaveLength(1);
  });
});

describe('TL-07 to sign on the home screen', () => {
  it('shows what is waiting for the tenant’s signature and opens To sign', async () => {
    mockSigning.mockResolvedValue([signingItem()]);
    await render(<Home />);
    const entry = await screen.findByTestId('to-sign-entry');
    expect(entry).toHaveTextContent(/1 lease is waiting for your signature/);
    await fireEvent.press(within(entry).getByTestId('open-to-sign'));
    expect(mockPush).toHaveBeenCalledWith('/to-sign');
  });

  it('says the others are still to sign once the tenant has signed', async () => {
    mockSigning.mockResolvedValue([signedItem()]);
    await render(<Home />);
    expect(await screen.findByTestId('to-sign-entry')).toHaveTextContent(
      /waiting for the others to sign/,
    );
  });

  it('shows no entry when nothing is out for signature', async () => {
    await render(<Home />);
    await screen.findAllByTestId('landlord-group');
    expect(screen.queryByTestId('to-sign-entry')).not.toBeOnTheScreen();
  });

  it('still shows the tenancies when the signing list cannot be loaded', async () => {
    mockSigning.mockRejectedValue(apiError(500, 'INTERNAL_SERVER_ERROR'));
    await render(<Home />);
    expect(await screen.findAllByTestId('landlord-group')).toHaveLength(2);
    expect(await screen.findByTestId('to-sign-error')).toHaveTextContent(/could not check/);
  });
});
