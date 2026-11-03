export { brandingSchema, type Branding } from './branding';
export { templates } from './catalog';
export { DocumentError, type DocumentErrorCode } from './errors';
export { DOCUMENT_FONT_FAMILY } from './fonts';
export { Letterhead } from './letterhead';
export {
  defineTemplate,
  TemplateRegistry,
  type Template,
  type TemplateDefinition,
  type TemplateProps,
} from './registry';
export { renderHtml, renderTemplateContent, renderTemplateHtml } from './render';
export {
  invoiceV1,
  receiptV1,
  type InvoiceDocumentData,
  type ReceiptDocumentData,
} from './billing';
export { leaseV1, type LeaseDocumentData } from './lease';
export { signingCertificateV1, type SigningCertificateData } from './signing-certificate';
export { systemSampleV1, type SystemSampleData } from './system-sample';
