import { act, renderHook } from '@testing-library/react-native';
import { takeWithCamera, useVoiceRecorder } from '../src/repair-capture';
import { forgetAllRepairFiles, keepFile } from '../src/repair-files';

// The M8 review round on iOS and Android (MI-01; decision 3): the camera takes a photo or records
// a video as two actions, since Android's camera opens for one only (LT 4); a voice note that
// stops itself at 3 minutes is handed over, not lost (LT 5); the copies the camera, the picker and
// the recorder leave in the app's cache go once kept, and all of them at sign-out (LT 7).
// expo-image-picker, expo-audio and expo-file-system are mocked.

jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchImageLibraryAsync: jest.fn(),
  UIImagePickerControllerQualityType: { High: 0, Medium: 1, Low: 2 },
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
}));
jest.mock('expo-audio', () => {
  const recorder = {
    currentTime: 0,
    uri: null as string | null,
    prepareToRecordAsync: jest.fn(async () => undefined),
    record: jest.fn(),
    stop: jest.fn(async () => undefined),
  };
  return {
    __recorder: recorder,
    getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
    requestRecordingPermissionsAsync: jest.fn(),
    setAudioModeAsync: jest.fn(async () => undefined),
    useAudioRecorder: jest.fn(() => recorder),
    RecordingPresets: { LOW_QUALITY: { extension: '.m4a', android: {}, ios: {} } },
  };
});
/** An in-memory file system with expo-file-system's shape, with a documents and a cache folder. */
const mockDisk = new Map<string, Uint8Array>();
jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]) =>
    parts
      .map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri))
      .join('/')
      .replace(/\/+/g, '/')
      .replace('file:/', 'file:///');
  class Directory {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get exists() {
      return [...mockDisk.keys()].some((key) => key.startsWith(`${this.uri}/`));
    }
    create() {}
    delete() {
      for (const key of [...mockDisk.keys()])
        if (key.startsWith(`${this.uri}/`)) mockDisk.delete(key);
    }
  }
  class File {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get exists() {
      return mockDisk.has(this.uri);
    }
    get size() {
      return mockDisk.get(this.uri)?.length ?? 0;
    }
    delete() {
      mockDisk.delete(this.uri);
    }
    async copy(target: { uri: string }) {
      mockDisk.set(target.uri, mockDisk.get(this.uri) ?? new Uint8Array());
    }
    open() {
      const bytes = mockDisk.get(this.uri) ?? new Uint8Array();
      return { readBytes: async (n: number) => bytes.slice(0, n), close: () => undefined };
    }
  }
  return {
    Directory,
    File,
    Paths: { document: new Directory('file:///docs'), cache: new Directory('file:///cache') },
  };
});

const mockPicker = jest.requireMock('expo-image-picker') as { launchCameraAsync: jest.Mock };
const mockRecorder = (
  jest.requireMock('expo-audio') as {
    __recorder: { currentTime: number; uri: string | null; stop: jest.Mock };
  }
).__recorder;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

beforeEach(() => {
  jest.clearAllMocks();
  mockDisk.clear();
  mockRecorder.currentTime = 0;
  mockRecorder.uri = null;
});

describe('MI-01 the camera takes a photo or records a video, as two actions (review LT 4)', () => {
  it('asks the camera for a photo only, or for a video only', async () => {
    await takeWithCamera('photo');
    await takeWithCamera('video');
    const kinds = mockPicker.launchCameraAsync.mock.calls.map(
      ([options]) => (options as { mediaTypes: string[] }).mediaTypes,
    );
    expect(kinds).toEqual([['images'], ['videos']]);
    expect(mockPicker.launchCameraAsync.mock.calls[1]![0]).toMatchObject({
      videoMaxDuration: 90,
      exif: false,
    });
  });
});

describe('MI-01 a voice note that stops itself at 3 minutes is kept (review LT 5)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('hands the note over when the recording reaches 3 minutes; a stop after that gives nothing', async () => {
    const stopped = jest.fn();
    const { result } = await renderHook(() => useVoiceRecorder(stopped));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.recording).toBe(true);

    mockRecorder.currentTime = 180.2;
    mockRecorder.uri = 'file:///cache/ExpoAudio/recording-1.m4a';
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped.mock.calls[0]![0]).toMatchObject({
      contentType: 'audio/mp4',
      durationSeconds: 180,
      part: { uri: 'file:///cache/ExpoAudio/recording-1.m4a' },
    });
    expect(result.current.recording).toBe(false);
  });

  it('the tenant stopping it at the same moment does not add it twice', async () => {
    const stopped = jest.fn();
    let finish!: () => void;
    mockRecorder.stop.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const { result } = await renderHook(() => useVoiceRecorder(stopped));
    await act(async () => {
      await result.current.start();
    });
    mockRecorder.currentTime = 180;
    mockRecorder.uri = 'file:///cache/ExpoAudio/recording-2.m4a';
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    let byHand: unknown = 'not yet';
    const manual = result.current.stop().then((note) => (byHand = note));
    await act(async () => {
      finish();
      await manual;
    });
    expect(byHand).toBeNull();
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});

describe('MI-01 no copy of a file stays in the cache (review LT 7)', () => {
  it('a camera, picker or recorder copy goes once kept; a file elsewhere stays', async () => {
    mockDisk.set('file:///cache/ImagePicker/photo-1.jpg', JPEG);
    mockDisk.set('file:///gallery/DCIM/own.jpg', JPEG);
    const media = (uri: string) => ({
      name: 'photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 0,
      durationSeconds: null,
      part: { uri, name: 'photo.jpg', type: 'image/jpeg' },
    });
    const kept = await keepFile('p-1', 'c-1', media('file:///cache/ImagePicker/photo-1.jpg'), 1);
    expect(kept.part).toMatchObject({ uri: 'file:///docs/repairs/p-1/c-1/1-photo.jpg' });
    expect(mockDisk.has('file:///docs/repairs/p-1/c-1/1-photo.jpg')).toBe(true);
    expect(mockDisk.has('file:///cache/ImagePicker/photo-1.jpg')).toBe(false);

    await keepFile('p-1', 'c-1', media('file:///gallery/DCIM/own.jpg'), 2);
    expect(mockDisk.has('file:///gallery/DCIM/own.jpg')).toBe(true);
  });

  it('signing out empties the picker’s and the recorder’s cache folders, and nothing else', () => {
    for (const path of [
      'file:///cache/ImagePicker/left-1.jpg',
      'file:///cache/ExpoAudio/recording-9.m4a',
      'file:///cache/Audio/recording-9.aac',
      'file:///docs/repairs/p-1/c-1/1-photo.jpg',
      'file:///cache/other-library/keep.bin',
    ])
      mockDisk.set(path, JPEG);
    forgetAllRepairFiles();
    expect([...mockDisk.keys()]).toEqual(['file:///cache/other-library/keep.bin']);
  });
});
