import type * as FileSystemModule from 'expo-file-system';
import { typeFromBytes, type ChosenMedia } from './repair-rules';

// Files of repair requests kept on the phone (M8 decision 3), with expo-file-system: a photo,
// video or voice note is copied into the app's own documents folder when it is chosen, so a
// request written offline keeps its files until it is sent, even if the app closes. Each request
// has a folder of its own, per person; signing out deletes them all.
//
// The camera, the photo picker and the recorder first write their own copies into the app's
// cache (expo-image-picker's `ImagePicker`, expo-audio's `ExpoAudio` on iOS and `Audio` on
// Android). Each copy is deleted once it is kept, and signing out empties those folders too (M8
// review LT 7), so nothing of the person stays on a shared phone. The web build uses
// repair-files.web.ts, which keeps files in memory only.

type FileSystem = typeof FileSystemModule;

let loaded: FileSystem | null = null;
/** Loaded on first use, so screens (and tests) that never touch repairs never load it. */
const fileSystem = (): FileSystem =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on first use (above)
  (loaded ??= require('expo-file-system') as FileSystem);

/** Whether a kept file outlives the app: here yes, on the web no. */
export const filesSurvive = true;

const ROOT = 'repairs';
/** Where expo-image-picker and expo-audio put what they take, inside the app's cache. */
const CAPTURE_CACHES = ['ImagePicker', 'ExpoAudio', 'Audio'] as const;

function captureCaches(): FileSystemModule.Directory[] {
  const { Directory, Paths } = fileSystem();
  return CAPTURE_CACHES.map((name) => new Directory(Paths.cache, name));
}

/** Whether a file is one of those copies: only those are ever deleted, never a library photo. */
function inCaptureCache(uri: string): boolean {
  try {
    return captureCaches().some((folder) =>
      uri.startsWith(folder.uri.endsWith('/') ? folder.uri : `${folder.uri}/`),
    );
  } catch {
    return false;
  }
}

/** A name safe for the file system: letters, digits, dots and dashes. */
const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';

function requestFolder(personId: string, clientId: string) {
  const { Directory, Paths } = fileSystem();
  return new Directory(Paths.document, ROOT, safe(personId), safe(clientId));
}

/** The first bytes of a kept file, which tell its real type (the server reads the same). */
async function headOf(file: FileSystemModule.File): Promise<Uint8Array | null> {
  try {
    const handle = file.open();
    try {
      return await handle.readBytes(64);
    } finally {
      handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Copies a chosen file into the request's folder on the phone. Answers the kept file's name (its
 * place in the folder), its size and its type as its first bytes show it.
 */
export async function keepFile(
  personId: string,
  clientId: string,
  media: ChosenMedia,
  index: number,
): Promise<ChosenMedia & { readonly keptName: string }> {
  const { File } = fileSystem();
  const folder = requestFolder(personId, clientId);
  folder.create({ intermediates: true, idempotent: true });
  const keptName = `${index}-${safe(media.name)}`;
  const target = new File(folder, keptName);
  if (target.exists) target.delete();
  const uri = (media.part as { uri?: string }).uri;
  if (!uri) throw new Error('A file on the phone has no address');
  await new File(uri).copy(target);
  if (inCaptureCache(uri)) {
    try {
      new File(uri).delete();
    } catch {
      // Best effort: signing out empties the folder.
    }
  }
  const contentType = typeFromBytes(await headOf(target), media.contentType);
  return {
    ...media,
    keptName,
    contentType,
    sizeBytes: target.size || media.sizeBytes,
    part: { uri: target.uri, name: media.name, type: contentType },
  };
}

/** Where a kept file is now, from its name, after the app opened again. */
export function keptFilePart(
  personId: string,
  clientId: string,
  keptName: string,
  name: string,
  type: string,
): { uri: string; name: string; type: string } | null {
  try {
    const { File } = fileSystem();
    const file = new File(requestFolder(personId, clientId), keptName);
    return file.exists ? { uri: file.uri, name, type } : null;
  } catch {
    return null;
  }
}

/** Deletes one request's files: it was sent, discarded, or never sent. */
export function forgetRequestFiles(personId: string, clientId: string): void {
  try {
    const folder = requestFolder(personId, clientId);
    if (folder.exists) folder.delete();
  } catch {
    // Best effort: the folder is the app's own and goes with it.
  }
}

/**
 * Deletes every repair file on the phone, and every copy the camera, the picker or the recorder
 * left in the cache: sign-out, or a session that ended.
 */
export function forgetAllRepairFiles(): void {
  try {
    const { Directory, Paths } = fileSystem();
    const root = new Directory(Paths.document, ROOT);
    if (root.exists) root.delete();
  } catch {
    // As above.
  }
  for (const name of CAPTURE_CACHES) {
    try {
      const { Directory, Paths } = fileSystem();
      const folder = new Directory(Paths.cache, name);
      if (folder.exists) folder.delete();
    } catch {
      // As above.
    }
  }
}
