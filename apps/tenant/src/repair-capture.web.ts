import { MEDIA_RULES } from '@rent/domain/maintenance';
import { mediaTypeOf, type ChosenMedia } from './repair-rules';

// Photos, videos and voice notes for a repair request on the web build (MI-01; M8 decision 3).
// The browser's own file picker, which on a phone also offers the camera. A voice note is chosen
// as a file: recording in a browser gives formats the server does not take (decision 2). Same
// exports as repair-capture.ts.

export type Capture =
  | { readonly status: 'chosen'; readonly media: readonly ChosenMedia[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'denied' };

export interface VoiceRecorder {
  readonly supported: boolean;
  readonly recording: boolean;
  readonly seconds: number;
  start(): Promise<'started' | 'denied' | 'failed'>;
  stop(): Promise<ChosenMedia | null>;
}

export const canUseCamera = typeof document !== 'undefined';
export const canRecordVoice = false;
export const voiceFileInput = typeof document !== 'undefined';
export const VOICE_SECONDS = MEDIA_RULES.audio.maxSeconds ?? 180;

const VISUAL = [...MEDIA_RULES.image.contentTypes, ...MEDIA_RULES.video.contentTypes].join(',');
const AUDIO = [...MEDIA_RULES.audio.contentTypes, '.m4a', '.aac', '.mp3', '.ogg', '.amr'].join(',');

/** Opens the browser's file picker; resolves with none when the person cancels. */
function pick(accept: string, max: number, capture?: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = max > 1;
    if (capture) input.setAttribute('capture', capture);
    input.addEventListener('change', () => resolve(Array.from(input.files ?? []).slice(0, max)));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** How long a video or a voice note is, as the browser reads it; null when it cannot. */
function durationOf(file: File, kind: 'audio' | 'video'): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(kind);
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 5_000);
    element.preload = 'metadata';
    element.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      done(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null);
    });
    element.addEventListener('error', () => {
      clearTimeout(timer);
      done(null);
    });
    element.src = url;
  });
}

async function toMedia(files: File[]): Promise<ChosenMedia[]> {
  return Promise.all(
    files.map(async (file, index) => {
      const contentType = mediaTypeOf(file.type, file.name);
      const kind = contentType.startsWith('video/')
        ? 'video'
        : contentType.startsWith('audio/')
          ? 'audio'
          : null;
      return {
        name: file.name || `file-${index + 1}`,
        contentType,
        sizeBytes: file.size,
        durationSeconds: kind ? await durationOf(file, kind) : null,
        part: file,
      };
    }),
  );
}

const chosen = async (files: File[]): Promise<Capture> =>
  files.length === 0 ? { status: 'cancelled' } : { status: 'chosen', media: await toMedia(files) };

/** Call each straight from the tap: browsers open a file picker only while a tap is handled. */
export async function takeWithCamera(): Promise<Capture> {
  return chosen(await pick(VISUAL, 1, 'environment'));
}

export async function chooseFromLibrary(max: number): Promise<Capture> {
  if (max <= 0) return { status: 'cancelled' };
  return chosen(await pick(VISUAL, max));
}

export async function chooseVoiceFile(): Promise<Capture> {
  return chosen(await pick(AUDIO, 1));
}

const NONE: VoiceRecorder = {
  supported: false,
  recording: false,
  seconds: 0,
  start: async () => 'failed',
  stop: async () => null,
};

export function useVoiceRecorder(): VoiceRecorder {
  return NONE;
}
