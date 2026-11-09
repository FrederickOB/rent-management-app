import { invoiceV1, receiptV1 } from './billing';
import { leaseV1 } from './lease';
import { finalStatementV1, moveInReportV1 } from './moveout';
import { noticeV1, servicePackV1 } from './notice';
import { dashboardV1, dashboardV2 } from './reporting-dashboard';
import { ownerStatementV1 } from './reporting-statement';
import { signingCertificateV1, signingCertificateV2 } from './signing-certificate';
import { TemplateRegistry } from './registry';
import { systemSampleV1 } from './system-sample';
import { statementV1 } from './statement';
import { subscriptionInvoiceV1, subscriptionReceiptV1 } from './subscription';
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
  // M8: the move-in report every party signs, and the final statement at move-out.
  moveInReportV1,
  finalStatementV1,
  // M9: the portfolio dashboard's PDF export (DA-06).
  dashboardV1,
  // M9 review: the dashboard export names its snapshot and live figures apart.
  dashboardV2,
  // M9: the monthly owner statement (AC-04).
  ownerStatementV1,
  // M10: the platform's subscription invoice and receipt (PB-07).
  subscriptionInvoiceV1,
  subscriptionReceiptV1,
]);
