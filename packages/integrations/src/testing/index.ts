/**
 * Contract suites: the behaviour every adapter of a port must have. Each runs against the
 * in-memory fake in unit tests and against `apps/fake-providers` (or Mailpit) in integration
 * tests, so the fakes stay honest; real adapters run them too when they arrive.
 */
export * from './fixtures';
export * from './sms.contract';
export * from './whatsapp.contract';
export * from './email.contract';
export * from './push.contract';
export * from './payments.contract';
export * from './identity-verification.contract';
export * from './address-lookup.contract';
export * from './alert.contract';
export * from './fake-providers-http';
