import { ProviderError } from './http';

/** Checks shared by the adapters, so the in-memory fakes refuse what the providers refuse. */
export const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:".]+$/;
const LINE_BREAK = /[\r\n]/;

export const isE164 = (value: string): boolean => E164.test(value);
export const isEmailAddress = (value: string): boolean => value.length <= 254 && EMAIL.test(value);
export const hasLineBreak = (value: string): boolean => LINE_BREAK.test(value);

/** A request the provider would refuse. Never retried; the message never carries the value. */
export const invalidRequest = (provider: string, message: string): ProviderError =>
  new ProviderError(provider, message, false, 400);

export const notFound = (provider: string, what: string): ProviderError =>
  new ProviderError(provider, `${what} not found`, false, 404);

export const conflict = (provider: string, message: string): ProviderError =>
  new ProviderError(provider, message, false, 409);

/** A provider answered with a shape we do not understand: stop and let a person look. */
export const unexpectedResponse = (provider: string): ProviderError =>
  new ProviderError(provider, 'unexpected response', false);
