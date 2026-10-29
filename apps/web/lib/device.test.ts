import { describe, expect, it } from 'vitest';
import { describeDevice } from './device';

describe('AD-06 device list', () => {
  it('names common browsers and systems from their user agents', () => {
    expect(
      describeDevice(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
    expect(
      describeDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(
      describeDevice(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
    expect(
      describeDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
      ),
    ).toBe('Edge on Windows');
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice('curl/8.0')).toBe('Unknown device');
  });
});
