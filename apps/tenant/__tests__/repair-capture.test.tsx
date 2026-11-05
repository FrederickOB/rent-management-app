import { act, renderHook } from '@testing-library/react-native';
import {
  chooseFromLibrary,
  takeWithCamera,
  useVoiceRecorder,
  VOICE_PRESET,
} from '../src/repair-capture';
import { forgetAllRepairFiles, keepFile, keptFilePart } from '../src/repair-files';

// MI-01 on iOS and Android (M8 decision 3): the camera and the microphone are asked for only when
// first used; voice notes are recorded in a format the server reads from its first bytes; files
// are kept on the phone until the request is sent. expo-image-picker, expo-audio and
// expo-file-system are mocked.

jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  UIImagePickerControllerQualityType: { High: 0, Medium: 1, Low: 2 },
  UIImagePickerPreferredAssetRepresentationMode: {
    Automatic: 'automatic',
    Compatible: 'compatible',
    Current: 'current',
  },
}));
/** An in-memory file system with expo-file-system's shape: path to bytes. */
const mockDisk = new Map<string, Uint8Array>();
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
    getRecordingPermissionsAsync: jest.fn(),
    requestRecordingPermissionsAsync: jest.fn(),
    setAudioModeAsync: jest.fn(async () => undefined),
    useAudioRecorder: jest.fn(() => recorder),
    RecordingPresets: {
      LOW_QUALITY: {
        extension: '.m4a',
        sampleRate: 44100,
        numberOfChannels: 2,
        bitRate: 64000,
        android: { extension: '.3gp', outputFormat: '3gp', audioEncoder: 'amr_nb' },
        ios: { audioQuality: 0, outputFormat: 'aac ' },
      },
    },
  };
});
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
  return { Directory, File, Paths: { document: new Directory('file:///docs') } };
});

type Recorder = {
  currentTime: number;
  uri: string | null;
  prepareToRecordAsync: jest.Mock;
  record: jest.Mock;
  stop: jest.Mock;
};
const mockPicker = jest.requireMock('expo-image-picker') as {
  getCameraPermissionsAsync: jest.Mock;
  requestCameraPermissionsAsync: jest.Mock;
  launchCameraAsync: jest.Mock;
  launchImageLibraryAsync: jest.Mock;
};
const mockAudio = jest.requireMock('expo-audio') as {
  __recorder: Recorder;
  getRecordingPermissionsAsync: jest.Mock;
  requestRecordingPermissionsAsync: jest.Mock;
  setAudioModeAsync: jest.Mock;
  useAudioRecorder: jest.Mock;
  RecordingPresets: { LOW_QUALITY: { ios: unknown } };
};
const mockRecorder = mockAudio.__recorder;

beforeEach(() => {
  jest.clearAllMocks();
  mockDisk.clear();
  mockRecorder.currentTime = 0;
  mockRecorder.uri = null;
});

describe('MI-01 the camera and the photo library (decision 3)', () => {
  it('asks for the camera the first time only, then takes a photo or a video of up to 90 s', async () => {
    mockPicker.getCameraPermissionsAsync.mockResolvedValueOnce({
      granted: false,
      canAskAgain: true,
    });
    mockPicker.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: true });
    mockPicker.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/v.mov',
          type: 'video',
          mimeType: 'video/quicktime',
          fileName: 'v.mov',
          fileSize: 8_000_000,
          duration: 12_500,
        },
      ],
    });
    const first = await takeWithCamera();
    expect(mockPicker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockPicker.launchCameraAsync).toHaveBeenCalledWith({
      mediaTypes: ['images', 'videos'],
      quality: 0.7,
      exif: false,
      videoMaxDuration: 90,
      videoQuality: 1,
    });
    expect(first).toEqual({
      status: 'chosen',
      media: [
        {
          name: 'v.mov',
          contentType: 'video/quicktime',
          sizeBytes: 8_000_000,
          durationSeconds: 12.5,
          part: { uri: 'file:///tmp/v.mov', name: 'v.mov', type: 'video/quicktime' },
        },
      ],
    });

    mockPicker.getCameraPermissionsAsync.mockResolvedValueOnce({ granted: true });
    await takeWithCamera();
    expect(mockPicker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('a refused camera is said as such, and nothing opens', async () => {
    mockPicker.getCameraPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    expect(await takeWithCamera()).toEqual({ status: 'denied' });
    expect(mockPicker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(mockPicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('chooses photos and videos from the library, up to the room left, without location', async () => {
    mockPicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/p.jpg',
          type: 'image',
          mimeType: 'image/jpeg',
          fileName: null,
          fileSize: 900_000,
          duration: null,
        },
      ],
    });
    const chosen = await chooseFromLibrary(4);
    expect(mockPicker.launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ['images', 'videos'],
      quality: 0.7,
      exif: false,
      allowsMultipleSelection: true,
      selectionLimit: 4,
      preferredAssetRepresentationMode: 'compatible',
    });
    expect(chosen).toMatchObject({
      status: 'chosen',
      media: [{ name: 'photo-1.jpg', durationSeconds: null }],
    });
    expect(await chooseFromLibrary(0)).toEqual({ status: 'cancelled' });
    mockPicker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await chooseFromLibrary(2)).toEqual({ status: 'cancelled' });
  });
});

describe('MI-01 voice notes (decision 3)', () => {
  it('records in formats the server reads from their first bytes: M4A on iOS, AAC (ADTS) on Android', () => {
    expect(VOICE_PRESET.extension).toBe('.m4a');
    expect(VOICE_PRESET.android).toMatchObject({
      extension: '.aac',
      outputFormat: 'aac_adts',
      audioEncoder: 'aac',
    });
    expect(VOICE_PRESET.ios).toEqual(mockAudio.RecordingPresets.LOW_QUALITY.ios);
  });

  it('asks for the microphone the first time, records, and gives the voice note with its length', async () => {
    mockAudio.getRecordingPermissionsAsync.mockResolvedValueOnce({
      granted: false,
      canAskAgain: true,
    });
    mockAudio.requestRecordingPermissionsAsync.mockResolvedValueOnce({ granted: true });
    const { result } = await renderHook(() => useVoiceRecorder());
    let started = '';
    await act(async () => {
      started = await result.current.start();
    });
    expect(started).toBe('started');
    expect(mockAudio.useAudioRecorder).toHaveBeenCalledWith(VOICE_PRESET);
    expect(mockAudio.setAudioModeAsync).toHaveBeenCalledWith({
      allowsRecording: true,
      playsInSilentMode: true,
    });
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalled();
    expect(mockRecorder.record).toHaveBeenCalled();
    expect(result.current.recording).toBe(true);

    mockRecorder.currentTime = 42.3;
    mockRecorder.uri = 'file:///tmp/rec.m4a';
    let note: unknown = null;
    await act(async () => {
      note = await result.current.stop();
    });
    expect(note).toEqual({
      name: 'voice-note.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 0,
      durationSeconds: 42.3,
      part: { uri: 'file:///tmp/rec.m4a', name: 'voice-note.m4a', type: 'audio/mp4' },
    });
    expect(result.current.recording).toBe(false);
  });

  it('a refused microphone is said as such, and nothing records', async () => {
    mockAudio.getRecordingPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });
    const { result } = await renderHook(() => useVoiceRecorder());
    let started = '';
    await act(async () => {
      started = await result.current.start();
    });
    expect(started).toBe('denied');
    expect(mockRecorder.record).not.toHaveBeenCalled();
  });
});

describe('MI-01 files kept on the phone until sent (decision 3)', () => {
  it('copies a chosen file into the request’s own folder, with its size and its real type', async () => {
    mockDisk.set(
      'file:///tmp/rec.m4a',
      new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2]),
    );
    const kept = await keepFile(
      'person-1',
      'client-1',
      {
        name: 'voice note.m4a',
        contentType: 'audio/mp4',
        sizeBytes: 0,
        durationSeconds: 20,
        part: { uri: 'file:///tmp/rec.m4a', name: 'voice note.m4a', type: 'audio/mp4' },
      },
      3,
    );
    expect(kept.keptName).toBe('3-voice_note.m4a');
    expect(kept.sizeBytes).toBe(12);
    // Its first bytes are an MP3's: the type the server will read is what the app declares.
    expect(kept.contentType).toBe('audio/mpeg');
    expect(kept.part).toEqual({
      uri: 'file:///docs/repairs/person-1/client-1/3-voice_note.m4a',
      name: 'voice note.m4a',
      type: 'audio/mpeg',
    });
    expect(
      keptFilePart('person-1', 'client-1', '3-voice_note.m4a', 'voice note.m4a', 'audio/mpeg'),
    ).toEqual(kept.part);
    expect(keptFilePart('person-1', 'client-1', 'missing.jpg', 'x', 'image/jpeg')).toBeNull();

    forgetAllRepairFiles();
    expect(mockDisk.has('file:///docs/repairs/person-1/client-1/3-voice_note.m4a')).toBe(false);
    expect(mockDisk.has('file:///tmp/rec.m4a')).toBe(true);
  });
});
