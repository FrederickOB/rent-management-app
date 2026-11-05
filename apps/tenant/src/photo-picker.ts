import * as ImagePicker from 'expo-image-picker';
import type { PickedPhoto } from './upload';

/**
 * Choosing photos on iOS and Android (M6 plan 4.10), through expo-image-picker (founder-approved
 * 2026-11-04). The web build has its own picker (photo-picker.web.ts); the upload and send flow is
 * shared, and the type and size limits are checked before upload (upload.ts `photoProblem`), then
 * again by the server.
 *
 * - **The system's photo picker,** which asks no permission on iOS 14+ and Android 13+; the app
 *   reads only the photos the tenant chooses. No camera, no video.
 * - **Small enough to send:** JPEG at quality 0.7, which keeps a typical phone photo of 12 to 48
 *   megapixels well under 10 MB. iOS hands over its "compatible" form, so a HEIC photo arrives as
 *   JPEG. The module cannot resize; a photo still over the limit is refused with a message.
 * - **No location:** EXIF is not asked for.
 */
export const canPickPhotos = true;

export const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  quality: 0.7,
  exif: false,
  base64: false,
  preferredAssetRepresentationMode:
    ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

const BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
};

/** The photo's type: the picker's, or from its file name, `image/jpg` read as JPEG. */
export function contentTypeOf(
  asset: Pick<ImagePicker.ImagePickerAsset, 'mimeType' | 'fileName' | 'uri'>,
): string {
  const given = asset.mimeType?.toLowerCase();
  if (given) return given === 'image/jpg' ? 'image/jpeg' : given;
  const extension = /\.([a-z0-9]+)(?:[?#]|$)/i
    .exec(asset.fileName ?? asset.uri)?.[1]
    ?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || 'application/octet-stream';
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The photo's size in bytes: the picker's, or read from the file; 0 when it cannot be known. */
async function sizeOf(asset: ImagePicker.ImagePickerAsset): Promise<number> {
  if (typeof asset.fileSize === 'number' && asset.fileSize > 0) return asset.fileSize;
  try {
    return (await (await fetch(asset.uri)).blob()).size;
  } catch {
    return 0;
  }
}

/**
 * Opens the photo picker for up to `max` photos; none when the tenant cancels or the picker cannot
 * open. Each comes as a file on the phone (`{ uri, name, type }`), which React Native's FormData
 * posts as the file.
 */
export async function pickPhotos(max: number): Promise<PickedPhoto[]> {
  if (max <= 0) return [];
  let result: ImagePicker.ImagePickerResult;
  try {
    result = await ImagePicker.launchImageLibraryAsync({
      ...PICKER_OPTIONS,
      allowsMultipleSelection: max > 1,
      selectionLimit: max,
    });
  } catch {
    return [];
  }
  if (result.canceled) return [];
  const chosen = (result.assets ?? []).slice(0, max);
  return Promise.all(
    chosen.map(async (asset, index): Promise<PickedPhoto> => {
      const contentType = contentTypeOf(asset);
      const name = asset.fileName || `photo-${index + 1}.${EXTENSIONS[contentType] ?? 'jpg'}`;
      return {
        name,
        contentType,
        sizeBytes: await sizeOf(asset),
        part: { uri: asset.uri, name, type: contentType },
      };
    }),
  );
}
