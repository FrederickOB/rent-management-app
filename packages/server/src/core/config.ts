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
  /**
   * The key apps/links sends with every links API call (M3 plan 4.15). Required in production;
   * elsewhere a shared development key stands in (DEV_LINKS_API_KEY).
   */
  LINKS_API_KEY: z.string().min(32).optional(),
  // M4b payments (plan decisions 3 to 5). Secrets come from the secrets manager, never the repo.
  /** Paystack's secret key: a test key everywhere until live collection is enabled (OQ-03). */
  PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
  /** Live rent collection waits for counsel's opinion on Bank of Ghana licensing (OQ-03). */
  LIVE_RENT_COLLECTION: z.enum(['enabled', 'disabled']).default('disabled'),
  /** Who enabled live collection, from the deployment's configuration; the startup log names them. */
  LIVE_RENT_COLLECTION_ENABLED_BY: z.string().min(1).max(200).optional(),
  /** The platform-owned domain for the per-tenant customer email Paystack requires (OQ-06). */
  PAYMENTS_CUSTOMER_EMAIL_DOMAIN: z.string().min(3).max(253).optional(),
  /** The fake provider's secret key (apps/fake-providers), for its API and its webhooks. */
  FAKE_PAYMENTS_SECRET_KEY: z.string().optional(),
  // M6 messaging (plan decisions 1 to 5). Secrets come from the secrets manager, never the repo.
  /** Meta's system-user token for the Cloud API; WhatsApp runs on the fake provider without it. */
  META_ACCESS_TOKEN: z.string().min(1).optional(),
  /** Signs Meta's webhooks (X-Hub-Signature-256). The fake provider's dev secret stands in locally. */
  META_APP_SECRET: z.string().min(1).optional(),
  /** What Meta's webhook verification sends as hub.verify_token. */
  META_VERIFY_TOKEN: z.string().min(1).optional(),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v23.0'),
  /** The shared platform number's phone number id: the default sender. */
  META_SHARED_PHONE_NUMBER_ID: z
    .string()
    .regex(/^\d{5,30}$/)
    .optional(),
  /** Hubtel SMS (decision 1): API ID, API Key and the approved sender ID. */
  HUBTEL_CLIENT_ID: z.string().min(1).optional(),
  HUBTEL_CLIENT_SECRET: z.string().min(1).optional(),
  HUBTEL_SENDER_ID: z
    .string()
    .regex(/^[A-Za-z0-9 ]{1,11}$/)
    .optional(),
  /** Our secrets on Hubtel's delivery and inbound callback URLs (Hubtel signs nothing). */
  SMS_STATUS_WEBHOOK_SECRET: z.string().min(16).optional(),
  SMS_INBOUND_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Postmark (decision 2): the server token; Mailpit over SMTP locally without it. */
  POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
  /** Our secrets on Postmark's inbound and delivery webhook URLs (Basic password or ?secret=). */
  EMAIL_INBOUND_WEBHOOK_SECRET: z.string().min(16).optional(),
  EMAIL_EVENTS_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** The domain of email reply addresses (CM-10), `reply+<token>@EMAIL_INBOUND_DOMAIN`. */
  EMAIL_INBOUND_DOMAIN: z.string().min(3).max(253).optional(),
  /** Expo push (decision 5): an access token when the project requires one. */
  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  /**
   * M10: the API's test controls for the web e2e specs (`POST /_test/subscriptions/...`), for
   * platform admins only. Never in production: the config refuses it there.
   */
  E2E_TEST_CONTROLS: z.enum(['on', 'off']).default('off'),
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
  if (config.NODE_ENV === 'production' && config.E2E_TEST_CONTROLS === 'on') {
    throw new Error('E2E_TEST_CONTROLS cannot be turned on in production');
  }
  if (
    config.NODE_ENV === 'production' &&
    (!config.LINKS_API_KEY || config.LINKS_API_KEY === DEV_LINKS_API_KEY)
  ) {
    throw new Error('LINKS_API_KEY must be set to a secret of its own in production');
  }
  // Decision 3 (OQ-03): no live rent collection until counsel's written opinion is in hand.
  if (
    config.PAYSTACK_SECRET_KEY?.startsWith('sk_live_') &&
    config.LIVE_RENT_COLLECTION !== 'enabled'
  )
    throw new Error(
      'A live Paystack key is set but LIVE_RENT_COLLECTION is not enabled: live rent collection waits for counsel (OQ-03)',
    );
  if (config.LIVE_RENT_COLLECTION === 'enabled' && !config.LIVE_RENT_COLLECTION_ENABLED_BY)
    throw new Error('LIVE_RENT_COLLECTION_ENABLED_BY must name who enabled live rent collection');
  if (
    config.NODE_ENV === 'production' &&
    config.PAYSTACK_SECRET_KEY &&
    !config.PAYMENTS_CUSTOMER_EMAIL_DOMAIN
  )
    throw new Error('PAYMENTS_CUSTOMER_EMAIL_DOMAIN must be set where payments are taken (OQ-06)');
  if (config.NODE_ENV === 'production') {
    // M6: real providers only, each with what it needs to verify its webhooks.
    if (
      config.META_ACCESS_TOKEN &&
      (!config.META_APP_SECRET || !config.META_SHARED_PHONE_NUMBER_ID)
    )
      throw new Error(
        'META_APP_SECRET and META_SHARED_PHONE_NUMBER_ID must be set with META_ACCESS_TOKEN',
      );
    if (
      config.HUBTEL_CLIENT_ID &&
      (!config.SMS_STATUS_WEBHOOK_SECRET || !config.SMS_INBOUND_WEBHOOK_SECRET)
    )
      throw new Error(
        'SMS_STATUS_WEBHOOK_SECRET and SMS_INBOUND_WEBHOOK_SECRET must be set with the Hubtel keys',
      );
    if (
      config.POSTMARK_SERVER_TOKEN &&
      (!config.EMAIL_EVENTS_WEBHOOK_SECRET ||
        !config.EMAIL_INBOUND_WEBHOOK_SECRET ||
        !config.EMAIL_INBOUND_DOMAIN)
    )
      throw new Error(
        'EMAIL_EVENTS_WEBHOOK_SECRET, EMAIL_INBOUND_WEBHOOK_SECRET and EMAIL_INBOUND_DOMAIN must be set with POSTMARK_SERVER_TOKEN',
      );
  }
  return config;
}

/** Whether the API mounts its e2e test controls (M10): switched on, and never in production. */
export function testControlsEnabled(config: AppConfig): boolean {
  return config.E2E_TEST_CONTROLS === 'on' && config.NODE_ENV !== 'production';
}

/**
 * The secret Meta's webhooks are signed with: the configured one, or the fake provider's dev
 * secret outside production (apps/fake-providers DEFAULT_WHATSAPP_APP_SECRET). Never in production.
 */
export const DEV_WHATSAPP_APP_SECRET = 'fake-providers-whatsapp-app-secret-dev-only';
export function whatsappAppSecretOf(config: AppConfig): string | null {
  if (config.META_APP_SECRET) return config.META_APP_SECRET;
  return config.NODE_ENV === 'production' ? null : DEV_WHATSAPP_APP_SECRET;
}

/** Webhook secrets for Hubtel and Postmark: the configured one, or a dev stand-in locally. */
export const DEV_WEBHOOK_SECRET = 'dev-only-messaging-webhook-secret';
export function messagingWebhookSecretOf(
  config: AppConfig,
  which: 'sms_status' | 'sms_inbound' | 'email_inbound' | 'email_events',
): string | null {
  const configured = {
    sms_status: config.SMS_STATUS_WEBHOOK_SECRET,
    sms_inbound: config.SMS_INBOUND_WEBHOOK_SECRET,
    email_inbound: config.EMAIL_INBOUND_WEBHOOK_SECRET,
    email_events: config.EMAIL_EVENTS_WEBHOOK_SECRET,
  }[which];
  if (configured) return configured;
  return config.NODE_ENV === 'production' ? null : DEV_WEBHOOK_SECRET;
}

/** The reply-address domain (CM-10): the configured one, or a reserved test domain locally. */
export function emailInboundDomainOf(config: AppConfig): string {
  return config.EMAIL_INBOUND_DOMAIN ?? 'inbound.rent.invalid';
}

/** The customer-email domain: the configured one, or a reserved test domain outside production. */
export function customerEmailDomainOf(config: AppConfig): string {
  return config.PAYMENTS_CUSTOMER_EMAIL_DOMAIN ?? 'pay.rent.invalid';
}

/**
 * The development stand-in for LINKS_API_KEY, which apps/links uses when it has none. It is not
 * a secret: production refuses it, so a links app deployed without its key fails closed.
 */
export const DEV_LINKS_API_KEY = 'dev-only-links-api-key-not-a-secret-000000';

/** The key the links API accepts: the configured one, or the development stand-in outside production. */
export function linksApiKeyOf(config: AppConfig): string {
  return config.LINKS_API_KEY ?? DEV_LINKS_API_KEY;
}
