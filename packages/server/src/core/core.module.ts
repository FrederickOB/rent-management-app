import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { createDatabase, type Database } from '@rent/db';
import {
  CallbackAlert,
  CompositeAlert,
  EmailAlert,
  FakeProvidersAddressLookup,
  FakeProvidersIdentityVerification,
  FakeProvidersSms,
  InMemoryIdentityVerification,
  InMemorySms,
  LocalKms,
  S3Storage,
  SmtpEmail,
  type AddressLookupPort,
  type AlertPort,
  type EmailPort,
  type IdentityVerificationPort,
  type KeyManagementPort,
  type SmsPort,
  type StoragePort,
} from '@rent/integrations';
import { systemClock, type Clock } from './clock';
import { loadConfig, type AppConfig } from './config';
import { DbKeyStore } from './crypto/db-key-store';
import { FieldCipher } from './crypto/field-cipher';
import { IdempotencyStore } from './idempotency';
import { createLogger, type AppLogger } from './logging/logger';
import {
  ADDRESS_LOOKUP_PORT,
  ALERT_PORT,
  CLOCK,
  CONFIG,
  DATABASE,
  EMAIL_PORT,
  FIELD_CIPHER,
  IDENTITY_VERIFICATION_PORT,
  KMS_PORT,
  LOGGER,
  SMS_PORT,
  STORAGE_PORT,
} from './tokens';

export interface CoreOptions {
  readonly config?: AppConfig;
  readonly database?: Database;
  readonly logger?: AppLogger;
  readonly clock?: Clock;
  readonly sms?: SmsPort;
  readonly email?: EmailPort;
  readonly storage?: StoragePort;
  readonly alerts?: AlertPort;
  /** Null switches lookups off; see addressLookupFor. */
  readonly addressLookup?: AddressLookupPort | null;
  /** Null switches identity checks off; see identityVerificationFor. */
  readonly identityVerification?: IdentityVerificationPort | null;
  readonly applicationName?: string;
}

function smsFor(config: AppConfig): SmsPort {
  if (config.FAKE_PROVIDERS_URL) return new FakeProvidersSms(config.FAKE_PROVIDERS_URL);
  if (config.NODE_ENV === 'production')
    throw new Error('No SMS gateway is configured (the real adapter arrives in M6)');
  return new InMemorySms();
}

/**
 * GhanaPost GPS lookups (PR-03, OQ-23). There is no licensed source yet, so lookups run only
 * against the fake provider; elsewhere they are off and addresses are typed by hand.
 */
function addressLookupFor(config: AppConfig): AddressLookupPort | null {
  return config.FAKE_PROVIDERS_URL
    ? new FakeProvidersAddressLookup(config.FAKE_PROVIDERS_URL)
    : null;
}

/**
 * Biometric identity checks (TL-02; OQ-22, OQ-39). No provider contract is signed yet, so checks
 * run against the fake provider locally and in memory in tests; in production they stay off
 * until the real adapter arrives, and staff see that checks are unavailable.
 */
function identityVerificationFor(config: AppConfig): IdentityVerificationPort | null {
  if (config.FAKE_PROVIDERS_URL)
    return new FakeProvidersIdentityVerification(config.FAKE_PROVIDERS_URL);
  if (config.NODE_ENV === 'production') return null;
  return new InMemoryIdentityVerification();
}

function storageFor(config: AppConfig): StoragePort {
  return new S3Storage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials:
      config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
}

function kmsFor(config: AppConfig): KeyManagementPort {
  if (!config.LOCAL_KMS_MASTER_KEY)
    throw new Error('No KMS is configured (AWS KMS arrives with the first deployment)');
  if (config.NODE_ENV === 'production')
    throw new Error('The local KMS stand-in must not be used in production');
  return new LocalKms(config.LOCAL_KMS_MASTER_KEY);
}

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}
  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}

/** Process-wide services every module may inject: config, database, logger, clock and ports. */
@Global()
@Module({})
export class CoreModule {
  static forRoot(options: CoreOptions = {}): DynamicModule {
    const config = options.config ?? loadConfig();
    const logger = options.logger ?? createLogger({ level: config.LOG_LEVEL });
    const providers: Provider[] = [
      { provide: CONFIG, useValue: config },
      { provide: CLOCK, useValue: options.clock ?? systemClock },
      { provide: LOGGER, useValue: logger },
      {
        provide: DATABASE,
        useFactory: () =>
          options.database ??
          createDatabase(config.DATABASE_URL, {
            applicationName: options.applicationName ?? 'rent',
          }),
      },
      { provide: SMS_PORT, useFactory: () => options.sms ?? smsFor(config) },
      {
        provide: EMAIL_PORT,
        useFactory: () => options.email ?? new SmtpEmail(config.SMTP_URL, config.MAIL_FROM),
      },
      { provide: STORAGE_PORT, useFactory: () => options.storage ?? storageFor(config) },
      {
        provide: ADDRESS_LOOKUP_PORT,
        useFactory: () =>
          options.addressLookup === undefined ? addressLookupFor(config) : options.addressLookup,
      },
      {
        provide: IDENTITY_VERIFICATION_PORT,
        useFactory: () =>
          options.identityVerification === undefined
            ? identityVerificationFor(config)
            : options.identityVerification,
      },
      { provide: KMS_PORT, useFactory: () => kmsFor(config) },
      {
        provide: IdempotencyStore,
        inject: [DATABASE],
        useFactory: (database: Database) => new IdempotencyStore(database),
      },
      {
        provide: FIELD_CIPHER,
        inject: [KMS_PORT, DATABASE],
        useFactory: (kms: KeyManagementPort, database: Database) => {
          if (!config.BLIND_INDEX_MASTER_KEY) throw new Error('BLIND_INDEX_MASTER_KEY is not set');
          return new FieldCipher(
            kms,
            new DbKeyStore(database),
            Buffer.from(config.BLIND_INDEX_MASTER_KEY, 'base64'),
          );
        },
      },
      {
        provide: ALERT_PORT,
        inject: [EMAIL_PORT],
        useFactory: (email: EmailPort) =>
          options.alerts ??
          new CompositeAlert([
            new CallbackAlert((alert) =>
              logger.error(
                { alert: { severity: alert.severity, code: alert.code, context: alert.context } },
                alert.message,
              ),
            ),
            new EmailAlert(email, config.OPS_ALERT_EMAIL),
          ]),
      },
    ];
    return {
      module: CoreModule,
      providers: [...providers, ...(options.database ? [] : [DatabaseLifecycle])],
      exports: [
        CONFIG,
        CLOCK,
        LOGGER,
        DATABASE,
        SMS_PORT,
        EMAIL_PORT,
        STORAGE_PORT,
        ADDRESS_LOOKUP_PORT,
        IDENTITY_VERIFICATION_PORT,
        KMS_PORT,
        FIELD_CIPHER,
        ALERT_PORT,
        IdempotencyStore,
      ],
    };
  }
}
