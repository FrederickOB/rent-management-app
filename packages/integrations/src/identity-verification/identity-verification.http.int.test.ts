import { fakeIdNumbers, fakeProvidersContext, identityVerificationContract } from '../testing';
import { FakeProvidersIdentityVerification } from './identity-verification';

identityVerificationContract('fake-providers over HTTP', () => ({
  port: new FakeProvidersIdentityVerification(fakeProvidersContext().baseUrl),
  idNumbers: fakeIdNumbers,
}));
