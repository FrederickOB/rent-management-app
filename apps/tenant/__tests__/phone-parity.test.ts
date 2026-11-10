import { tryNormalisePhone } from '@rent/domain/phone';
import { signInPhone } from '../src/phone';

// M11 review: the sign-in screen's phone check, made smaller in M11 (Ghana's rules first, every
// country's only for a number that names another country), reads every number exactly as the
// check before M11 did: libphonenumber's full rules with Ghana as the default country, which is
// tryNormalisePhone in @rent/domain and what the API uses. The review found "+44 (0)7400 123456"
// read as +4407400123456; trunk zeros, extensions and tel: links are here for that reason.

const FORMATS = [
  // Ghana, local and international.
  '024 412 3456',
  '0244123456',
  '+233 24 412 3456',
  '00233244123456',
  ' 0302 123 456 ',
  '+233 (0)24 412 3456',
  '+233-24-412-3456',
  '(024) 412-3456',
  '024.412.3456',
  '233244123456',
  '+233244123456 ext. 12',
  'tel:+233-24-412-3456',
  // The United Kingdom, with its trunk zero, an extension and a tel: link.
  '+44 7400 123456',
  '+44 (0)7400 123456',
  '+44 07400 123456',
  '0044 7400 123456',
  '0044 (0)7400 123456',
  '+44-7400-123456',
  '+44.7400.123456',
  '+44 (7400) 123456',
  '+447400123456',
  '+44 7400 123456 ext. 12',
  '+44 7400 123456 x12',
  'tel:+44-7400-123456',
  '＋44 7400 123456',
  // Elsewhere.
  '+1 (202) 555-0143',
  '+1 202-555-0143',
  '001 202 555 0143',
  '+1.202.555.0143',
  '+234 803 123 4567',
  '+234 (0)803 123 4567',
  '+234 0803 123 4567',
  '+49 (0)30 123456',
  '+49 030 123456',
  '+33 (0)6 12 34 56 78',
  '+27 (0)82 123 4567',
  '+39 06 1234 5678',
  '+225 07 12 34 56 78',
  '+228 90 12 34 56',
  '+221 77 123 45 67',
  '+86 138 0013 8000',
  '+91 98765 43210',
  '+971 50 123 4567',
  // Not numbers.
  '12345',
  '024 412',
  '0999 999 999',
  '+233 99 999 9999',
  '+44 12',
  '+1234567890123456',
  '7400 123456',
  'abc',
  '',
];

describe('AD-06 the sign-in phone check reads numbers as before M11 (M11 review)', () => {
  it.each(FORMATS)('%j', async (input) => {
    await expect(signInPhone(input)).resolves.toBe(tryNormalisePhone(input));
  });

  it('the review’s example reads as the UK mobile it is', async () => {
    await expect(signInPhone('+44 (0)7400 123456')).resolves.toBe('+447400123456');
  });
});
