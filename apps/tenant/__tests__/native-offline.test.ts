import { NETWORK_MESSAGE, toProblem } from '../src/problems';

// M11 device test (TL-01, MI-01, BC-06 offline): on iOS and Android the app's fetch is Expo's,
// which fails with a FetchError ("fetch failed: …"), never the TypeError a browser gives. Offline,
// the app did not know it, so Home, the repair form and the payments kept nothing they had cached.

/** As expo/fetch's FetchError: an Error, named Error, with its message prefixed. */
class FetchError extends Error {
  constructor(message: string) {
    super(`fetch failed: ${message}`);
  }
}

describe('NFR-OFFLINE a lost connection on iOS and Android is known as one', () => {
  it('Expo’s fetch failing, as the browser’s TypeError, is a lost connection', () => {
    for (const error of [
      new FetchError('Unable to resolve host "10.0.2.2": No address associated with hostname'),
      new FetchError('The Internet connection appears to be offline.'),
      new TypeError('Network request failed'),
    ])
      expect(toProblem(error)).toEqual({ status: null, code: 'network', message: NETWORK_MESSAGE });
  });

  it('an aborted request, or any other error, is not', () => {
    expect(toProblem(new FetchError('The operation was aborted.')).code).toBeNull();
    expect(toProblem(new Error('fetch went wrong')).code).toBeNull();
  });
});
