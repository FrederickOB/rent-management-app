import type { PickedPhoto } from './upload';

/**
 * Choosing photos on iOS and Android needs a picker module (expo-image-picker), which M6 has not
 * added yet: the brief allowed one new dependency, expo-notifications. Until it is added, the
 * attach button stays hidden on the phone apps; the web build has its own picker
 * (photo-picker.web.ts), and the upload and send flow is shared.
 */
export const canPickPhotos = false;

export async function pickPhotos(_max: number): Promise<PickedPhoto[]> {
  return [];
}
