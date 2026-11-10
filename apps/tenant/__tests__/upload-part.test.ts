import { uploadToStorage } from '../src/upload';
import { uploadPart } from '../src/upload-part';

// M11 device test (MI-01, CM-05): on iOS and Android the app's fetch is Expo's, which refused React
// Native's `{ uri, name, type }` form parts ("Unsupported FormDataPart implementation"), so no
// photo, video or voice note reached storage from a phone. A part now also says how to read its
// bytes, which Expo's fetch uses; the file is read only when the form is sent.

const mockRead = jest.fn();
jest.mock('expo-file-system', () => ({
  File: class {
    mockUri: string;
    constructor(mockAddress: string) {
      this.mockUri = mockAddress;
    }
    bytes() {
      return mockRead(this.mockUri);
    }
  },
}));

const PART = { uri: 'file:///docs/repairs/p/c/0-tap.jpg', name: 'tap.jpg', type: 'image/jpeg' };

/** The form as Expo's fetch would read it: what was appended, under which name. */
class RecordingFormData {
  readonly parts: [string, unknown, string | undefined][] = [];
  append(name: string, value: unknown, filename?: string) {
    this.parts.push([name, value, filename]);
  }
}
const realFormData = globalThis.FormData;
beforeEach(() => {
  mockRead.mockReset();
  globalThis.FormData = RecordingFormData as unknown as typeof FormData;
});
afterEach(() => {
  globalThis.FormData = realFormData;
});

describe('MI-01 CM-05 a file on the phone goes to storage through Expo’s fetch (M11 device test)', () => {
  it('keeps its address, name and type, and reads its bytes from the file only when sent', async () => {
    const part = uploadPart(PART) as typeof PART & { bytes(): Promise<Uint8Array> };
    expect(part).toMatchObject(PART);
    expect(mockRead).not.toHaveBeenCalled();
    mockRead.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff]));
    await expect(part.bytes()).resolves.toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(mockRead).toHaveBeenCalledWith(PART.uri);
  });

  it('a Blob, as the web gives, is sent as it is', () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    expect(uploadPart(blob)).toBe(blob);
  });

  it('the storage post carries the readable part, after the policy fields', async () => {
    const post = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    await uploadToStorage(
      { url: 'https://storage.example.test/rent-uploads', fields: { key: 'k' } },
      { name: 'tap.jpg', contentType: 'image/jpeg', sizeBytes: 3, part: PART },
      post as unknown as typeof fetch,
    );
    const form = (post.mock.calls[0]![1] as { body: RecordingFormData }).body;
    expect(form.parts.map(([name]) => name)).toEqual(['key', 'file']);
    const [, file, filename] = form.parts[1]!;
    expect(filename).toBe('tap.jpg');
    expect(file).toEqual(PART);
    expect('bytes' in (file as object)).toBe(true);
    expect(JSON.stringify(file)).toBe(JSON.stringify(PART));
  });
});
