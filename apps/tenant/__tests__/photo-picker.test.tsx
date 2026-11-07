import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import Thread from '../app/messages/[companyId]';
import { forgetOutbox } from '../src/outbox';
import { canPickPhotos, contentTypeOf, pickPhotos } from '../src/photo-picker';
import { photoProblem } from '../src/upload';
import { AGENCY, ME } from './fixtures';
import { CONVERSATIONS, message, STORAGE_URL, THREAD, UPLOAD_ID } from './message-fixtures';

// Photo attachments in the iOS and Android builds (M6 plan 4.10), through expo-image-picker
// (founder-approved 2026-11-04), mocked here. The limits are the contract's: JPEG, PNG or WebP,
// at most 10 MB, checked before upload.

const mockLaunch = jest.fn();
const mockMessages = jest.fn();
const mockConversations = jest.fn();
const mockSend = jest.fn();
const mockCreateUpload = jest.fn();
const mockParams: { companyId?: string } = {};
const mockSession = { me: ME, loading: false, ended: false, expire: jest.fn() };

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunch(...args),
  UIImagePickerPreferredAssetRepresentationMode: {
    Automatic: 'automatic',
    Compatible: 'compatible',
    Current: 'current',
  },
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('../src/session', () => ({ useSession: () => mockSession }));
jest.mock('../src/api', () => ({
  api: {
    tenantMessaging: {
      conversations: (...args: unknown[]) => mockConversations(...args),
      messages: (...args: unknown[]) => mockMessages(...args),
      send: (...args: unknown[]) => mockSend(...args),
      createPhotoUpload: (...args: unknown[]) => mockCreateUpload(...args),
    },
  },
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const asset = (overrides: Record<string, unknown> = {}) => ({
  uri: 'file:///var/mobile/photos/leak.jpg',
  fileName: 'leak.jpg',
  mimeType: 'image/jpeg',
  fileSize: 2_400_000,
  width: 4032,
  height: 3024,
  ...overrides,
});

/** React Native's FormData takes a file as `{ uri, name, type }`; this records what is added. */
class PhoneFormData {
  readonly parts: [string, unknown][] = [];
  append(name: string, value: unknown) {
    this.parts.push([name, value]);
  }
}

const realFetch = globalThis.fetch;
const realFormData = globalThis.FormData;
const storage = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  for (const mock of [
    mockLaunch,
    mockMessages,
    mockConversations,
    mockSend,
    mockCreateUpload,
    storage,
  ])
    mock.mockReset();
  forgetOutbox();
  mockConversations.mockResolvedValue(CONVERSATIONS);
  mockMessages.mockResolvedValue(THREAD);
  mockSend.mockImplementation(async (input: { body: string }) =>
    message({ direction: 'inbound', fromLandlord: false, body: input.body }),
  );
  storage.mockResolvedValue({ ok: true, status: 204 });
  globalThis.fetch = storage as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.FormData = realFormData;
});

describe('CM-05 photo attachments on iOS and Android', () => {
  it('opens the system picker for images only, compressed, without location, up to the room left', async () => {
    expect(canPickPhotos).toBe(true);
    mockLaunch.mockResolvedValue({ canceled: false, assets: [asset()] });
    const photos = await pickPhotos(3);
    expect(mockLaunch).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      quality: 0.7,
      exif: false,
      base64: false,
      preferredAssetRepresentationMode: 'compatible',
      allowsMultipleSelection: true,
      selectionLimit: 3,
    });
    expect(photos).toEqual([
      {
        name: 'leak.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 2_400_000,
        part: { uri: 'file:///var/mobile/photos/leak.jpg', name: 'leak.jpg', type: 'image/jpeg' },
      },
    ]);

    await pickPhotos(1);
    expect(mockLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowsMultipleSelection: false, selectionLimit: 1 }),
    );
  });

  it('gives nothing when the tenant cancels, the picker fails, or there is no room left', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickPhotos(5)).toEqual([]);
    mockLaunch.mockRejectedValueOnce(new Error('picker unavailable'));
    expect(await pickPhotos(5)).toEqual([]);
    mockLaunch.mockClear();
    expect(await pickPhotos(0)).toEqual([]);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('reads the type from the file name when the picker gives none, and the size from the file', async () => {
    expect(contentTypeOf({ mimeType: 'image/jpg', fileName: null, uri: 'file:///a' })).toBe(
      'image/jpeg',
    );
    expect(contentTypeOf({ mimeType: undefined, fileName: 'IMG_1.PNG', uri: 'file:///b' })).toBe(
      'image/png',
    );
    expect(
      contentTypeOf({ mimeType: undefined, fileName: null, uri: 'file:///c/photo.webp' }),
    ).toBe('image/webp');
    expect(
      contentTypeOf({ mimeType: undefined, fileName: null, uri: 'file:///d/photo.heic' }),
    ).toBe('image/heic');

    storage.mockResolvedValueOnce({ blob: async () => ({ size: 812_000 }) });
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [
        asset({
          fileSize: undefined,
          mimeType: undefined,
          fileName: null,
          uri: 'file:///x/one.png',
        }),
      ],
    });
    const [photo] = await pickPhotos(1);
    expect(photo).toMatchObject({
      name: 'photo-1.png',
      contentType: 'image/png',
      sizeBytes: 812_000,
    });
    expect(storage).toHaveBeenCalledWith('file:///x/one.png');
  });

  it('keeps the limits: a HEIC or GIF photo, or one over 10 MB, is refused before upload', () => {
    expect(photoProblem({ contentType: 'image/heic', sizeBytes: 1_000 })).toMatch(
      /JPEG, PNG or WebP/,
    );
    expect(photoProblem({ contentType: 'image/gif', sizeBytes: 1_000 })).toMatch(
      /JPEG, PNG or WebP/,
    );
    expect(photoProblem({ contentType: 'image/jpeg', sizeBytes: 10_000_001 })).toMatch(/too big/);
    expect(photoProblem({ contentType: 'image/jpeg', sizeBytes: 0 })).toMatch(/empty/);
    expect(photoProblem({ contentType: 'image/webp', sizeBytes: 10_000_000 })).toBeNull();
  });

  it('in the thread: a chosen photo is posted to storage as the phone’s file, then sent with the message', async () => {
    globalThis.FormData = PhoneFormData as unknown as typeof FormData;
    mockLaunch.mockResolvedValue({ canceled: false, assets: [asset()] });
    mockCreateUpload.mockResolvedValue({
      uploadId: UPLOAD_ID,
      url: STORAGE_URL,
      fields: { key: 'uploads/messages/abc', policy: 'cG9saWN5' },
      expiresAt: '2026-11-04T12:10:00.000Z',
    });
    mockParams.companyId = AGENCY.companyId;
    await render(<Thread />);
    await fireEvent.press(await screen.findByTestId('add-photo'));
    expect(await screen.findByTestId('photo-chip')).toHaveTextContent(/^Photo 1 \(2\.4 MB\)/);
    expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({ selectionLimit: 5 }));

    await fireEvent.changeText(screen.getByTestId('message-input'), 'Water under the sink.');
    await fireEvent.press(screen.getByTestId('send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(mockCreateUpload).toHaveBeenCalledWith({
      companyId: AGENCY.companyId,
      contentType: 'image/jpeg',
      sizeBytes: 2_400_000,
    });
    const [url, init] = storage.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(STORAGE_URL);
    const form = init.body as unknown as PhoneFormData;
    expect(form.parts.map(([name]) => name)).toEqual(['key', 'policy', 'file']);
    expect(form.parts[2]![1]).toEqual({
      uri: 'file:///var/mobile/photos/leak.jpg',
      name: 'leak.jpg',
      type: 'image/jpeg',
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Water under the sink.', uploadIds: [UPLOAD_ID] }),
    );
    globalThis.FormData = realFormData;
  });

  it('in the thread: a photo over 10 MB, or not JPEG, PNG or WebP, is refused with a message', async () => {
    mockLaunch.mockResolvedValue({
      canceled: false,
      assets: [
        asset({ fileSize: 12_000_000 }),
        asset({ mimeType: 'image/heic', fileName: 'a.heic' }),
      ],
    });
    mockParams.companyId = AGENCY.companyId;
    await render(<Thread />);
    await fireEvent.press(await screen.findByTestId('add-photo'));
    await waitFor(() => expect(screen.getByTestId('composer-error')).toBeOnTheScreen());
    expect(screen.queryByTestId('photo-chip')).not.toBeOnTheScreen();
    expect(mockCreateUpload).not.toHaveBeenCalled();
  });
});
