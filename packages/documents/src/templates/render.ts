import { renderToStaticMarkup } from 'react-dom/server';
import { brandingSchema, type Branding } from './branding';
import { templates } from './catalog';
import { DocumentError, describeIssues } from './errors';
import { DOCUMENT_FONT_FAMILY, fontFaceCss } from './fonts';
import type { Template, TemplateRegistry } from './registry';

/**
 * Nothing outside the document may load: images and fonts are data URIs and no script runs. The
 * PDF renderer also blocks the network; this keeps an on-screen preview just as closed.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

/** A4 print styles shared by every template. Brand colours arrive as CSS variables. */
const DOCUMENT_CSS = `
@page { size: A4; margin: 18mm 16mm 20mm; }
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: '${DOCUMENT_FONT_FAMILY}', sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1f2937; }
h1 { margin: 0 0 3mm; font-size: 16pt; line-height: 1.25; color: var(--brand-primary); }
h2 { margin: 6mm 0 2mm; font-size: 12pt; color: var(--brand-primary); }
p { margin: 0 0 3mm; }
table { width: 100%; margin: 4mm 0; border-collapse: collapse; }
th, td { padding: 2mm 0; border-bottom: 0.3mm solid #e5e7eb; text-align: left; vertical-align: top; }
th { width: 40%; font-weight: 700; }
tr, img { break-inside: avoid; }
.amount { font-variant-numeric: tabular-nums; white-space: nowrap; }
.small { font-size: 8.5pt; color: #6b7280; }
.letterhead { display: flex; align-items: center; gap: 6mm; padding-bottom: 4mm; }
.letterhead .logo { max-width: 50mm; max-height: 18mm; object-fit: contain; }
.letterhead .sender { font-size: 14pt; font-weight: 700; color: var(--brand-primary); }
.accent-rule { height: 1.2mm; margin-bottom: 8mm; background: var(--brand-accent); }
@media screen {
  body { background: #f3f4f6; }
  .document { width: 210mm; min-height: 297mm; margin: 8mm auto; padding: 18mm 16mm 20mm; background: #fff; }
}
`;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Validates the data and branding and renders a complete HTML document: the template as static
 * markup, the fonts inlined as base64 and A4 print CSS. The same HTML serves preview and PDF.
 */
export function renderHtml(template: Template, data: unknown, branding: Branding): string {
  const parsedBranding = brandingSchema.safeParse(branding);
  if (!parsedBranding.success) {
    throw new DocumentError(
      'invalid_branding',
      'Branding is not valid',
      describeIssues(parsedBranding.error),
    );
  }
  const body = renderToStaticMarkup(template.element(data, parsedBranding.data));
  return [
    '<!doctype html>',
    '<html lang="en-GB">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
    `<title>${escapeHtml(template.title)}</title>`,
    `<style>\n${fontFaceCss()}\n${DOCUMENT_CSS}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

/** Renders a registered template by key and version, as stored with each document. */
export function renderTemplateHtml(
  key: string,
  version: number,
  data: unknown,
  branding: Branding,
  registry: TemplateRegistry = templates,
): string {
  return renderHtml(registry.get(key, version), data, branding);
}
