import type { z } from 'zod';

export type DocumentErrorCode =
  | 'invalid_template'
  | 'template_exists'
  | 'template_not_found'
  | 'invalid_data'
  | 'invalid_branding';

/** A template or its input was wrong. Issues name the fields, never their values. */
export class DocumentError extends Error {
  override readonly name = 'DocumentError';
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length === 0 ? message : `${message}: ${issues.join('; ')}`);
  }
}

/** Field paths and zod's messages, which describe what was expected rather than what was sent. */
export const describeIssues = (error: z.ZodError): string[] =>
  error.issues.map(
    (issue) =>
      `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`,
  );
