import { smsContract } from '../testing';
import { InMemorySms } from './sms';

smsContract('in-memory', () => {
  const port = new InMemorySms();
  return { port, sent: async () => port.sent };
});
