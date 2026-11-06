import { MEDIA_RULES } from '@rent/domain/maintenance';
import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { mediaTypeOf, type ChosenMedia } from './repair-rules';

// Photos, videos and voice notes for a repair request on iOS and Android (MI-01; M8 decision 3).
// The camera and the microphone are asked for only when the tenant first uses them, with the
// words in app.json. The web build uses repair-capture.web.ts.

export type Capture =
  | { readonly status: 'chosen'; readonly media: readonly ChosenMedia[] }
  | { readonly status: 'cancelled' }
  /** The phone refused the camera or the microphone. */
  | { readonly status: 'denied' };

export interface VoiceRecorder {
  readonly supported: boolean;
  readonly recording: boolean;
  /** How long the recording is so far. */
  readonly seconds: number;
  start(): Promise<'started' | 'denied' | 'failed'>;
  /** Stops, and answers the voice note (null when nothing was recorded). */
  stop(): Promise<ChosenMedia | null>;
}

export const canUseCamera = true;
export const canRecordVoice = true;
/** The web build offers a voice note as a file instead of recording one. */
export const voiceFileInput = false;

const VIDEO_SECONDS = MEDIA_RULES.video.maxSeconds ?? 90;
export const VOICE_SECONDS = MEDIA_RULES.audio.maxSeconds ?? 180;

/**
 * Voice notes the server takes from their first bytes (decision 2): AAC in an M4A file on iOS,
 * and on Android an AAC (ADTS) stream, since Android's MPEG-4 files read as video.
 */
export const VOICE_PRESET: RecordingOptions = {
  ...RecordingPresets.LOW_QUALITY,
  extension: '.m4a',
  android: {
    extension: '.aac',
    outputFormat: 'aac_adts',
    audioEncoder: 'aac',
    sampleRate: 22050,
  },
};
const VOICE_TYPE = Platform.OS === 'android' ? 'audio/aac' : 'audio/mp4';
const VOICE_NAME = Platform.OS === 'android' ? 'voice-note.aac' : 'voice-note.m4a';

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
};

function toMedia(asset: ImagePicker.ImagePickerAsset, index: number): ChosenMedia {
  const video = asset.type === 'video';
  const contentType = mediaTypeOf(asset.mimeType, asset.fileName ?? asset.uri);
  const name =
    asset.fileName ||
    `${video ? 'video' : 'photo'}-${index + 1}.${EXTENSIONS[contentType] ?? (video ? 'mp4' : 'jpg')}`;
  return {
    name,
    contentType,
    // Unknown here: read from the kept file (repair-files.ts).
    sizeBytes: asset.fileSize ?? 0,
    durationSeconds: video && asset.duration ? asset.duration / 1000 : null,
    part: { uri: asset.uri, name, type: contentType },
  };
}

function fromResult(result: ImagePicker.ImagePickerResult, max: number): Capture {
  if (result.canceled) return { status: 'cancelled' };
  return { status: 'chosen', media: (result.assets ?? []).slice(0, max).map(toMedia) };
}

/** What the camera takes: Android's camera opens for one or the other, never both. */
export type CameraKind = 'photo' | 'video';

const CAMERA_MEDIA: Readonly<Record<CameraKind, ImagePicker.MediaType[]>> = {
  photo: ['images'],
  video: ['videos'],
};

/**
 * Takes a photo or records a video with the camera, asking for the camera the first time. The
 * screen offers the two as separate actions (M8 review LT 4): asked for both, Android opens the
 * photo camera only. With no kind, the camera offers both where the phone can (iOS).
 */
export async function takeWithCamera(kind?: CameraKind): Promise<Capture> {
  try {
    let permission = await ImagePicker.getCameraPermissionsAsync();
    if (!permission.granted && permission.canAskAgain)
      permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { status: 'denied' };
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: kind ? CAMERA_MEDIA[kind] : ['images', 'videos'],
      quality: 0.7,
      exif: false,
      videoMaxDuration: VIDEO_SECONDS,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    });
    return fromResult(result, 1);
  } catch {
    return { status: 'cancelled' };
  }
}

/** Chooses photos and videos from the phone's library: the system picker, which asks nothing. */
export async function chooseFromLibrary(max: number): Promise<Capture> {
  if (max <= 0) return { status: 'cancelled' };
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.7,
      exif: false,
      allowsMultipleSelection: max > 1,
      selectionLimit: max,
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    return fromResult(result, max);
  } catch {
    return { status: 'cancelled' };
  }
}

/** The web build's voice note file; the phone apps record instead. */
export async function chooseVoiceFile(): Promise<Capture> {
  return { status: 'cancelled' };
}

/**
 * Records a voice note, asking for the microphone the first time; it stops by itself at the
 * longest a voice note may be (3 minutes), and then hands the note to `onAutoStop` (M8 review
 * LT 5), as `stop()` hands it to whoever stops it. Each note goes to one of them only: a stop
 * that comes while another is under way answers null.
 */
export function useVoiceRecorder(onAutoStop?: (note: ChosenMedia | null) => void): VoiceRecorder {
  const recorder = useAudioRecorder(VOICE_PRESET);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const stopping = useRef<Promise<ChosenMedia | null> | null>(null);
  const autoStopped = useRef(onAutoStop);
  useEffect(() => {
    autoStopped.current = onAutoStop;
  }, [onAutoStop]);

  const stop = useCallback(async (): Promise<ChosenMedia | null> => {
    if (stopping.current) return stopping.current.then(() => null);
    const run = (async () => {
      const length = recorder.currentTime;
      try {
        await recorder.stop();
      } catch {
        // Already stopped.
      }
      setRecording(false);
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      const uri = recorder.uri;
      if (!uri || !(length > 0)) return null;
      return {
        name: VOICE_NAME,
        contentType: VOICE_TYPE,
        sizeBytes: 0,
        durationSeconds: Math.min(length, VOICE_SECONDS),
        part: { uri, name: VOICE_NAME, type: VOICE_TYPE },
      };
    })();
    stopping.current = run;
    try {
      return await run;
    } finally {
      stopping.current = null;
    }
  }, [recorder]);

  const start = useCallback(async () => {
    try {
      let permission = await getRecordingPermissionsAsync();
      if (!permission.granted && permission.canAskAgain)
        permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) return 'denied' as const;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setSeconds(0);
      setRecording(true);
      return 'started' as const;
    } catch {
      return 'failed' as const;
    }
  }, [recorder]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const now = recorder.currentTime;
      setSeconds(now);
      if (now >= VOICE_SECONDS)
        void stop().then((note) => {
          if (note) autoStopped.current?.(note);
        });
    }, 250);
    return () => clearInterval(timer);
  }, [recording, recorder, stop]);

  return { supported: true, recording, seconds, start, stop };
}
