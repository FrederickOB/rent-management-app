/** Errors the API maps to HTTP responses. `code` is stable and safe to show to clients. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Facts a client can act on, such as a free code to use instead. Never personal data. */
    readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notAuthenticated = (message = 'Sign in to continue') =>
  new AppError(401, 'not_authenticated', message);
export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (
  code: string,
  message: string,
  details?: Readonly<Record<string, string>>,
) => new AppError(409, code, message, details);
export const invalid = (code: string, message: string) => new AppError(400, code, message);

/** M11 decision 6: an upload whose malware scan has not finished (contracts' DOCUMENT_SCAN_ERRORS). */
export const documentScanPending = () =>
  new AppError(
    409,
    'document_scan_pending',
    'This file is still being checked for viruses. Try again in a minute.',
  );
/** M11 decision 6: an upload the scan found malware in; quarantined and never served. */
export const documentQuarantined = () =>
  new AppError(
    410,
    'document_quarantined',
    'This file was found to contain a virus and has been quarantined. Ask for it to be sent again.',
  );
