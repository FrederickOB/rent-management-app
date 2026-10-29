/** Dependency-injection tokens. Every constructor parameter uses @Inject(TOKEN) explicitly. */
export const CONFIG = Symbol('CONFIG');
export const DATABASE = Symbol('DATABASE');
export const LOGGER = Symbol('LOGGER');
export const CLOCK = Symbol('CLOCK');
export const SMS_PORT = Symbol('SMS_PORT');
export const EMAIL_PORT = Symbol('EMAIL_PORT');
export const WHATSAPP_PORT = Symbol('WHATSAPP_PORT');
export const PUSH_PORT = Symbol('PUSH_PORT');
export const PAYMENTS_PORT = Symbol('PAYMENTS_PORT');
export const IDENTITY_VERIFICATION_PORT = Symbol('IDENTITY_VERIFICATION_PORT');
export const ADDRESS_LOOKUP_PORT = Symbol('ADDRESS_LOOKUP_PORT');
export const KMS_PORT = Symbol('KMS_PORT');
export const FIELD_CIPHER = Symbol('FIELD_CIPHER');
export const STORAGE_PORT = Symbol('STORAGE_PORT');
export const ALERT_PORT = Symbol('ALERT_PORT');
export const AUTH = Symbol('AUTH');
export const JOBS = Symbol('JOBS');
