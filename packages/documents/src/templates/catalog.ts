import { invoiceV1, receiptV1 } from './billing';
import { leaseV1 } from './lease';
import { signingCertificateV1 } from './signing-certificate';
import { TemplateRegistry } from './registry';
import { systemSampleV1 } from './system-sample';
import { rentTaxReportV1, rentTaxReportV2 } from './tax';

/** Every template the product renders. Old versions stay, so stored documents keep theirs. */
export const templates = new TemplateRegistry([
  systemSampleV1,
  leaseV1,
  signingCertificateV1,
  invoiceV1,
  receiptV1,
  rentTaxReportV1,
  rentTaxReportV2,
]);
