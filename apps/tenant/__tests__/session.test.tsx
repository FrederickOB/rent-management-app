import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import SignIn from '../app/sign-in';
import { SessionProvider, useSession } from '../src/session';
import { guardError, ME } from './fixtures';

const mockMe = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('../src/api', () => ({ api: { me: { get: (...args: unknown[]) => mockMe(...args) } } }));
jest.mock('../src/auth-client', () => ({
  authClient: {
    signOut: jest.fn(() => Promise.resolve()),
    phoneNumber: { sendOtp: jest.fn(), verify: jest.fn() },
  },
}));

/** Stands in for a screen whose request the API refused with a 401. */
function Refused() {
  const { me, loading, expire } = useSession();
  if (loading) return null;
  return (
    <Text testID="refused" onPress={expire}>
      {me ? `Signed in as ${me.name}` : 'Not signed in'}
    </Text>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AD-06 an ended session sends the tenant to sign in', () => {
  it('forgets a session the API refuses and says so on the sign-in screen', async () => {
    mockMe.mockResolvedValue(ME);
    await render(
      <SessionProvider>
        <Refused />
        <SignIn />
      </SessionProvider>,
    );
    expect(await screen.findByText('Signed in as Abena Mensah')).toBeOnTheScreen();
    expect(screen.queryByTestId('session-ended')).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('refused'));
    expect(await screen.findByText('Not signed in')).toBeOnTheScreen();
    expect(screen.getByTestId('session-ended')).toHaveTextContent(/session has ended/);
  });

  it('does not call a refusal before sign-in an ended session', async () => {
    mockMe.mockRejectedValue(guardError(401, 'not_authenticated', 'Sign in to continue'));
    await render(
      <SessionProvider>
        <Refused />
        <SignIn />
      </SessionProvider>,
    );
    await fireEvent.press(await screen.findByTestId('refused'));
    expect(screen.getByText('Not signed in')).toBeOnTheScreen();
    expect(screen.queryByTestId('session-ended')).not.toBeOnTheScreen();
  });
});
