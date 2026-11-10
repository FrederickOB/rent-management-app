import type * as AuthClient from '../src/auth-client';

// M11 (identity work): on iOS and Android the Expo plugin keeps only the cookies whose names start
// with its cookie prefix. Ours are `rent.*` in development and e2e and `__Host-rent.*` in
// production (packages/server/src/identity/auth.ts). The plugin's default prefix, `better-auth`,
// matched neither, so a phone never stored its session and every reopen asked for a new code.
// These run the real Better Auth client and Expo plugin; only the network and SecureStore are fakes.

const mockSecureStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItem: (key: string) => mockSecureStore.get(key) ?? null,
  setItem: (key: string, value: string) => void mockSecureStore.set(key, value),
  getItemAsync: async (key: string) => mockSecureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void mockSecureStore.set(key, value),
  deleteItemAsync: async (key: string) => void mockSecureStore.delete(key),
}));
// The app's own deep-link origin, which the plugin sends as `expo-origin`.
jest.mock('expo-linking', () => ({ createURL: (path: string) => `rentplatform://${path}` }));

/** The API. Better Auth's client keeps the `fetch` it finds when it is created, so this one is
 * in place before the client is loaded, and each test sets what it answers. */
let answer: (path: string) => Response = () => new Response(null, { status: 500 });
let sent: { path: string; cookie: string | null }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(typeof input === 'string' ? input : String(input)).pathname;
  sent.push({ path, cookie: new Headers(init?.headers).get('cookie') });
  return answer(path);
}) as typeof fetch;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the fake fetch
const { authClient, sessionCookieHeader } = require('../src/auth-client') as typeof AuthClient;

const user = { id: 'u1', name: 'Ama', phoneNumber: '+233244123456', phoneNumberVerified: true };
const session = { id: 's1', userId: 'u1', expiresAt: '2099-01-01T00:00:00.000Z', token: 't' };
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The phone-number sign-in answers with `setCookie`; every other call answers the session. */
function signInSets(setCookie: string) {
  answer = (path) =>
    path.endsWith('/phone-number/verify')
      ? json({ status: true, token: 't', user }, { 'set-cookie': setCookie })
      : json({ session, user });
}

beforeEach(() => {
  mockSecureStore.clear();
  sent = [];
});

describe('AD-06 the tenant app keeps its session on iOS and Android, under our cookie names', () => {
  it.each([
    ['development and e2e', 'rent.session_token', ''],
    ['production', '__Host-rent.session_token', '; Secure'],
  ])(
    '%s: the session cookie (%s) is stored at sign-in and sent with later calls',
    async (_, name, secure) => {
      signInSets(`${name}=abc.def; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax${secure}`);

      await authClient.phoneNumber.verify({ phoneNumber: '+233244123456', code: '123456' });

      // Stored: the API client's cookie header (src/api.ts) carries it.
      await expect(sessionCookieHeader()).resolves.toEqual({ cookie: `${name}=abc.def` });
      // Sent: the auth client's own calls carry it too.
      await authClient.getSession();
      expect(sent.at(-1)).toEqual({ path: '/api/auth/get-session', cookie: `${name}=abc.def` });
    },
  );

  it('a cookie that is not ours is not kept', async () => {
    signInSets('tracker=1; Max-Age=604800; Path=/');
    await authClient.phoneNumber.verify({ phoneNumber: '+233244123456', code: '123456' });
    await expect(sessionCookieHeader()).resolves.toEqual({});
  });
});
