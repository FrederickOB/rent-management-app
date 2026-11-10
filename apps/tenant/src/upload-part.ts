import type * as FileSystemModule from 'expo-file-system';

/**
 * A file on the phone as an upload's form part (M11 device test). On iOS and Android the app's
 * `fetch` is Expo's (expo/fetch replaces React Native's), which does not read React Native's
 * `{ uri, name, type }` parts: it refused them ("Unsupported FormDataPart implementation"), so no
 * photo, video or voice note ever reached storage from a phone. It reads a part's `bytes()`
 * instead. The part keeps its address, name and type; the file is read only when the form is sent.
 * The web build's parts are Blobs already (src/upload-part.web.ts).
 */
export function uploadPart(part: unknown): unknown {
  const uri = (part as { uri?: unknown } | null)?.uri;
  if (typeof uri !== 'string') return part;
  // The reader is a method, not part of the part's data: it is not enumerable, so the part still
  // reads, compares and serialises as { uri, name, type }. Expo's fetch finds it all the same.
  return Object.defineProperty({ ...(part as object) }, 'bytes', {
    enumerable: false,
    value: async (): Promise<Uint8Array> => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded when a file is sent
      const { File } = require('expo-file-system') as typeof FileSystemModule;
      return new File(uri).bytes();
    },
  });
}
