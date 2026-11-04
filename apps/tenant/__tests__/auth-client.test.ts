import { sessionCookieHeader } from '../src/auth-client';

// M6 review round: on iOS and Android the API client sends the session as a cookie header, read
// from the Expo plugin's getCookie, which answers a promise. Used as a string, the header was
// "[object Promise]", so every native call went unauthenticated (the web build uses the browser's
// cookie, so the e2e specs never saw it).

const mockGetCookie = jest.fn();

jest.mock('better-auth/react', () => ({
  createAuthClient: () => ({ getCookie: (...args: unknown[]) => mockGetCookie(...args) }),
}));
jest.mock('better-auth/client/plugins', () => ({ phoneNumberClient: () => ({}) }));
jest.mock('@better-auth/expo/client', () => ({ expoClient: () => ({}) }));
jest.mock('expo-secure-store', () => ({}));

describe('AD-06 the tenant app’s session on iOS and Android', () => {
  it('sends the stored session cookie, awaited, with every API call', async () => {
    mockGetCookie.mockResolvedValue('rent.session_token=abc.def');
    await expect(sessionCookieHeader()).resolves.toEqual({ cookie: 'rent.session_token=abc.def' });
  });

  it('sends no cookie header when nobody is signed in', async () => {
    mockGetCookie.mockResolvedValue('');
    await expect(sessionCookieHeader()).resolves.toEqual({});
  });
});
