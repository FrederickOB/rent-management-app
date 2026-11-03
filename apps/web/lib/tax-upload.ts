import { rentTaxContract } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { api } from './api';
import { fileTypesLabel, sendToStorage, type UploadRule } from './upload';

// Files for the tax records (TX-03, TX-04, P13, P33): GRA's receipt for rent tax or VAT paid, a
// withholding tax certificate, and the proof of a refund paid to a tenant. They go straight to
// storage with a presigned POST (CLAUDE.md section 10); the record then names the upload.

/** GRA's receipt and the certificate (`POST /tax-uploads`); the refund's proof has its own. */
export type TaxUploadPurpose =
  Parameters<ApiClient['rentTax']['createUpload']>[0]['purpose'] | 'refund_proof';
type TaxUploadType = Parameters<ApiClient['rentTax']['createUpload']>[0]['contentType'];

/** The types and size `POST /tax-uploads` accepts, read from its contract, which the API checks. */
function taxUploadRule(): UploadRule {
  const input = rentTaxContract.createUpload['~orpc'].inputSchema;
  const maxBytes = input?.shape.sizeBytes.maxValue;
  if (!input || !maxBytes || !Number.isFinite(maxBytes))
    throw new Error('The tax-upload contract has no file types or size limit');
  return { types: input.shape.contentType.options, maxBytes };
}

export const TAX_FILE_UPLOAD: UploadRule = taxUploadRule();

const isTaxUploadType = (type: string): type is TaxUploadType =>
  TAX_FILE_UPLOAD.types.includes(type);

/** Each kind of file goes to the upload endpoint of the record it belongs to. */
function slotFor(
  purpose: TaxUploadPurpose,
  file: { contentType: TaxUploadType; sizeBytes: number },
) {
  return purpose === 'refund_proof'
    ? api().earlyTermination.createUpload(file)
    : api().rentTax.createUpload({ purpose, ...file });
}

/** Sends one file to storage and returns the upload id the tax endpoints take. */
export async function uploadTaxFile(file: File, purpose: TaxUploadPurpose): Promise<string> {
  if (!isTaxUploadType(file.type))
    throw new Error(`Choose a ${fileTypesLabel(TAX_FILE_UPLOAD)} file.`);
  const slot = await slotFor(purpose, { contentType: file.type, sizeBytes: file.size });
  await sendToStorage(slot, file);
  return slot.uploadId;
}

export interface TaxUploadOnce {
  readonly idFor: (file: File, purpose: TaxUploadPurpose) => Promise<string>;
  readonly forget: (file: File) => void;
}

/**
 * One upload per chosen file, as for the money forms (lib/payment-upload): a retry sends the same
 * upload id, so the write stays the same request; only a refusal of the upload itself forgets it.
 */
export function taxUploadOnce(
  upload: (file: File, purpose: TaxUploadPurpose) => Promise<string> = uploadTaxFile,
): TaxUploadOnce {
  const done = new WeakMap<File, string>();
  return {
    async idFor(file, purpose) {
      const known = done.get(file);
      if (known) return known;
      const id = await upload(file, purpose);
      done.set(file, id);
      return id;
    },
    forget(file) {
      done.delete(file);
    },
  };
}
