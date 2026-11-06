import { MESSAGE_PHOTO_CONTENT_TYPES } from './message-rules';
import type { PickedPhoto } from './upload';

/** The browser's own file picker; on a phone it offers the camera and the photo library. */
export const canPickPhotos = typeof document !== 'undefined';

/**
 * Opens the picker for up to `max` photos. Call it straight from the tap: browsers open a file
 * picker only while a tap is being handled. Resolves with none when the person cancels.
 */
export function pickPhotos(max: number): Promise<PickedPhoto[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = MESSAGE_PHOTO_CONTENT_TYPES.join(',');
    input.multiple = max > 1;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []).slice(0, max);
      resolve(
        files.map((file) => ({
          name: file.name || 'photo',
          contentType: file.type,
          sizeBytes: file.size,
          part: file,
        })),
      );
    });
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
