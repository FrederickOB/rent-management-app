import { typeFromBytes, type ChosenMedia } from './repair-rules';

// The web build keeps a repair request's files in memory only (M8 decision 3): a request written
// offline keeps them while the tab stays open; once the page reloads they are gone, and the
// request says so. Same exports as repair-files.ts, which keeps them on the phone.

export const filesSurvive = false;

async function headOf(part: unknown): Promise<Uint8Array | null> {
  try {
    if (part instanceof Blob) return new Uint8Array(await part.slice(0, 64).arrayBuffer());
  } catch {
    // The browser could not read it.
  }
  return null;
}

export async function keepFile(
  _personId: string,
  _clientId: string,
  media: ChosenMedia,
  index: number,
): Promise<ChosenMedia & { readonly keptName: string }> {
  return {
    ...media,
    keptName: `${index}-${media.name}`,
    contentType: typeFromBytes(await headOf(media.part), media.contentType),
  };
}

export function keptFilePart(
  _personId: string,
  _clientId: string,
  _keptName: string,
  _name: string,
  _type: string,
): null {
  return null;
}

export function forgetRequestFiles(_personId: string, _clientId: string): void {}

export function forgetAllRepairFiles(): void {}
