import { invoiceV1, receiptV1 } from './billing';
import { leaseV1 } from './lease';
import { noticeV1, servicePackV1 } from './notice';
import { signingCertificateV1, signingCertificateV2 } from './signing-certificate';
import { TemplateRegistry } from './registry';
import { systemSampleV1 } from './system-sample';
import { statementV1 } from './statement';
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
  statementV1,
  // M7: legal notices and their physical service pack.
  noticeV1,
  servicePackV1,
  // M7 review: the certificate with the full evidence, for notices and leases alike.
  signingCertificateV2,
]);
