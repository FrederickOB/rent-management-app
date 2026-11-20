import { fireEvent, render, screen } from '@testing-library/react-native';
import SignIn from '../app/sign-in';

// M11 (identity work): the API's limits on phone sign-in, each said by its code alone.
// - Sending codes: the short limit (429 TOO_MANY_CODES) passes in minutes; the daily cap
//   (429 DAILY_CODES_EXCEEDED) passes tomorrow.
// - Checking codes: five wrong tries end one code (403 TOO_MANY_ATTEMPTS), so a new code helps;
//   the daily cap on wrong codes (403 DAILY_ATTEMPTS_EXCEEDED) passes tomorrow.
// The API's messages are deliberately left out: the screen never reads them.

const mockSendOtp = jest.fn();
const mockVerify = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));
jest.mock('../src/session', () => ({ useSession: () => ({ refresh: jest.fn() }) }));
jest.mock('../src/auth-client', () => ({
  authClient: {
    phoneNumber: {
      sendOtp: (...args: unknown[]) => mockSendOtp(...args),
      verify: (...args: unknown[]) => mockVerify(...args),
    },
  },
}));

const refused = (status: number, code: string) => ({ data: null, error: { status, code } });

async function askForCode() {
  await render(<SignIn />);
  await fireEvent.changeText(screen.getByTestId('phone-input'), '024 412 3456');
  await fireEvent.press(screen.getByTestId('send-code'));
}

async function tryCode() {
  await askForCode();
  await fireEvent.changeText(await screen.findByTestId('code-input'), '000000');
  await fireEvent.press(screen.getByTestId('verify-code'));
  return screen.findByTestId('error');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendOtp.mockResolvedValue({ data: { message: 'code sent' }, error: null });
});

describe('AD-06 phone sign-in limits', () => {
  it('the daily cap on sending codes says to try again tomorrow', async () => {
    mockSendOtp.mockResolvedValue(refused(429, 'DAILY_CODES_EXCEEDED'));
    await askForCode();
    expect(await screen.findByTestId('error')).toHaveTextContent(
      'Too many codes requested today; try again tomorrow.',
    );
  });

  it('the short limit on sending codes says to wait a few minutes', async () => {
    mockSendOtp.mockResolvedValue(refused(429, 'TOO_MANY_CODES'));
    await askForCode();
    expect(await screen.findByTestId('error')).toHaveTextContent(
      'Too many codes requested. Try again in a few minutes.',
    );
  });

  it('the daily cap on wrong codes says to try again tomorrow', async () => {
    mockVerify.mockResolvedValue(refused(403, 'DAILY_ATTEMPTS_EXCEEDED'));
    expect(await tryCode()).toHaveTextContent('Too many attempts today; try again tomorrow.');
  });

  it('a code that has had its five tries still says to ask for a new one', async () => {
    mockVerify.mockResolvedValue(refused(403, 'TOO_MANY_ATTEMPTS'));
    expect(await tryCode()).toHaveTextContent('Too many attempts. Request a new code.');
  });
});
