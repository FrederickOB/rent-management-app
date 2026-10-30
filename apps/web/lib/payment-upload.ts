import { paymentsContract } from '@rent/contracts';
import type { ApiClient } from '@rent/contracts/client';
import { api } from './api';
import { fileTypesLabel, sendToStorage, type UploadRule } from './upload';

// Files for money records (BC-05, P07, P28): a photo of the receipt-book page or the cheque, a
// transfer proof, and a banking slip. They go straight to storage with a presigned POST
// (CLAUDE.md section 10); the record then names the upload.

type UploadInput = Parameters<ApiClient['payments']['createUpload']>[0];
export type PaymentUploadPurpose = UploadInput['purpose'];
type PaymentUploadType = UploadInput['contentType'];

/** The types and size `POST /payment-uploads` accepts, read from its contract, which the API checks. */
function paymentUploadRule(): UploadRule {
  const input = paymentsContract.createUpload['~orpc'].inputSchema;
  const maxBytes = input?.shape.sizeBytes.maxValue;
  if (!input || !maxBytes || !Number.isFinite(maxBytes))
    throw new Error('The payment-upload contract has no file types or size limit');
  return { types: input.shape.contentType.options, maxBytes };
}

/** A transfer proof or a banking slip: a screenshot, a photo or a PDF statement. */
export const PAYMENT_PROOF_UPLOAD: UploadRule = paymentUploadRule();

/** The photo of the receipt-book page or the cheque, taken with the phone's camera. */
export const CASH_PHOTO_UPLOAD: UploadRule = {
  types: PAYMENT_PROOF_UPLOAD.types.filter((type) => type.startsWith('image/')),
  maxBytes: PAYMENT_PROOF_UPLOAD.maxBytes,
  noun: 'a photo (JPEG or PNG)',
};

const isPaymentUploadType = (type: string): type is PaymentUploadType =>
  PAYMENT_PROOF_UPLOAD.types.includes(type);

/** Sends one file to storage and returns the upload id the money endpoints take. */
export async function uploadPaymentFile(
  file: File,
  purpose: PaymentUploadPurpose,
): Promise<string> {
  if (!isPaymentUploadType(file.type))
    throw new Error(`Choose a ${fileTypesLabel(PAYMENT_PROOF_UPLOAD)} file.`);
  const slot = await api().payments.createUpload({
    purpose,
    contentType: file.type,
    sizeBytes: file.size,
  });
  await sendToStorage(slot, file);
  return slot.uploadId;
}

export interface UploadOnce {
  /** The upload id for this file: uploaded the first time, the same id after that. */
  readonly idFor: (file: File, purpose: PaymentUploadPurpose) => Promise<string>;
  /** Forgets a file's upload, so the next attempt sends it again. */
  readonly forget: (file: File) => void;
}

/**
 * One upload per chosen file. A retry after a dropped connection sends the same upload id, so the
 * money write is the same request with the same Idempotency-Key and is never recorded twice.
 */
export function uploadOnce(
  upload: (file: File, purpose: PaymentUploadPurpose) => Promise<string> = uploadPaymentFile,
): UploadOnce {
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
