import { z } from 'zod';

const minutes = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/**
 * Process configuration from the environment, validated at start-up. Secrets come from the
 * secrets manager in deployed environments and from `.env` locally (CLAUDE.md section 10).
 */
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).default('Rent Platform'),
  DATABASE_URL: z.string().url(),
  API_BASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  LINKS_ORIGIN: z.string().url(),
  TENANT_WEB_ORIGIN: z.string().url(),
  TENANT_APP_SCHEME: z.string().default('rentplatform'),
  BETTER_AUTH_SECRET: z.string().min(32),
  FAKE_PROVIDERS_URL: z.string().url().optional(),
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('Rent Platform <no-reply@rent.local>'),
  OPS_ALERT_EMAIL: z.string().email().default('ops@rent.local'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET_FILES: z.string().default('rent-files'),
  S3_BUCKET_EVIDENCE: z.string().default('rent-evidence'),
  LOCAL_KMS_MASTER_KEY: z.string().optional(),
  BLIND_INDEX_MASTER_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Session limits (AD-06; docs/plans/M1.md section 4.5). Security settings, not law.
  STAFF_IDLE_MINUTES: minutes(30),
  STAFF_ABSOLUTE_MINUTES: minutes(12 * 60),
  PLATFORM_ADMIN_IDLE_MINUTES: minutes(15),
  TENANT_IDLE_MINUTES: minutes(30 * 24 * 60),
  TENANT_ABSOLUTE_MINUTES: minutes(180 * 24 * 60),
  ENROLMENT_ABSOLUTE_MINUTES: minutes(60),
  /** Better Auth's per-IP limits. Tests that sign in many times from one address turn them off. */
  AUTH_RATE_LIMITS: z.enum(['on', 'off']).default('on'),
  OTP_SENDS_PER_PHONE: z.coerce.number().int().positive().default(3),
  OTP_SEND_WINDOW_MINUTES: minutes(15),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const config = result.data;
  if (config.NODE_ENV === 'production' && config.FAKE_PROVIDERS_URL) {
    throw new Error('FAKE_PROVIDERS_URL must not be set in production');
  }
  if (config.NODE_ENV === 'production' && config.AUTH_RATE_LIMITS === 'off') {
    throw new Error('AUTH_RATE_LIMITS cannot be turned off in production');
  }
  return config;
}
