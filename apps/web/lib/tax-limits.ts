import { earlyTerminationContract, rentTaxContract, withholdingContract } from '@rent/contracts';

// The limits the M5 forms check before sending, read from the API's contract (packages/contracts),
// which the API checks again, so a form never refuses what the API would take or the reverse.

function need(value: number | null | undefined, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`The contract gives no limit for ${what}`);
  return value;
}

const gra = rentTaxContract.recordGraPayment['~orpc'].inputSchema?.shape;
const certificate = withholdingContract.uploadCertificate['~orpc'].inputSchema?.shape;
const refundPaid = earlyTerminationContract.recordRefundPaid['~orpc'].inputSchema?.shape;
const termination = earlyTerminationContract.request['~orpc'].inputSchema?.shape;

export const TAX_LIMITS = {
  /** GRA's receipt number on a rent tax or VAT payment. */
  graReceiptNumberMax: need(gra?.graReceiptNumber.maxLength, 'the GRA receipt number'),
  noteMax: need(gra?.note.unwrap().unwrap().maxLength, 'a note'),
  certificateNumberMax: need(
    certificate?.certificateNumber.unwrap().unwrap().maxLength,
    'the certificate number',
  ),
  refundReferenceMin: need(refundPaid?.reference.minLength, 'the refund reference'),
  refundReferenceMax: need(refundPaid?.reference.maxLength, 'the refund reference'),
  /** What an agreed charge or deduction is for. */
  descriptionMin: need(
    termination?.charges.unwrap().element.shape.description.minLength,
    'a charge’s description',
  ),
  descriptionMax: need(
    termination?.charges.unwrap().element.shape.description.maxLength,
    'a charge’s description',
  ),
} as const;
