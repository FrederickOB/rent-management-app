// Fingerprints, templates and PDF assembly. The PDF renderer is `@rent/documents/render`, so
// importing this package never loads Playwright.
export * from './fingerprint';
export * from './pdf/append';
export * from './pdf/normalise';
export * from './templates';
