import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SignIn from '../app/sign-in';

const mockReplace = jest.fn();
const mockSendOtp = jest.fn();
const mockVerify = jest.fn();
const mockRefresh = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));
jest.mock('../src/session', () => ({ useSession: () => ({ refresh: mockRefresh }) }));
jest.mock('../src/auth-client', () => ({
  authClient: {
    phoneNumber: {
      sendOtp: (...args: unknown[]) => mockSendOtp(...args),
      verify: (...args: unknown[]) => mockVerify(...args),
    },
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSendOtp.mockResolvedValue({ data: { message: 'code sent' }, error: null });
  mockVerify.mockResolvedValue({ data: { status: true }, error: null });
});

describe('AD-06 tenant phone sign-in screen', () => {
  it('refuses a number that is not valid, without calling the API', async () => {
    await render(<SignIn />);
    await fireEvent.changeText(screen.getByTestId('phone-input'), '12345');
    await fireEvent.press(screen.getByTestId('send-code'));
    expect(await screen.findByTestId('error')).toHaveTextContent(/valid|phone number/i);
    expect(mockSendOtp).not.toHaveBeenCalled();
  });

  it('sends the code to the E.164 number, then signs in with the code', async () => {
    await render(<SignIn />);
    await fireEvent.changeText(screen.getByTestId('phone-input'), '024 412 3456');
    await fireEvent.press(screen.getByTestId('send-code'));
    await waitFor(() => expect(mockSendOtp).toHaveBeenCalledWith({ phoneNumber: '+233244123456' }));

    await fireEvent.changeText(await screen.findByTestId('code-input'), '12 34 56');
    await fireEvent.press(screen.getByTestId('verify-code'));
    await waitFor(() =>
      expect(mockVerify).toHaveBeenCalledWith({ phoneNumber: '+233244123456', code: '123456' }),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('explains a wrong or expired code and stays on the code step', async () => {
    mockVerify.mockResolvedValue({ data: null, error: { status: 400 } });
    await render(<SignIn />);
    await fireEvent.changeText(screen.getByTestId('phone-input'), '0244123456');
    await fireEvent.press(screen.getByTestId('send-code'));
    await fireEvent.changeText(await screen.findByTestId('code-input'), '000000');
    await fireEvent.press(screen.getByTestId('verify-code'));
    expect(await screen.findByTestId('error')).toHaveTextContent(/not right|expired/i);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
