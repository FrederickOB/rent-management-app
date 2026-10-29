/** Errors the API maps to HTTP responses. `code` is stable and safe to show to clients. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const invalid = (code: string, message: string) => new AppError(400, code, message);
