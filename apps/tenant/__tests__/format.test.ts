import {
  formatDate,
  formatMoney,
  formatTime,
  noticeLabel,
  optionalMoney,
  rentLabel,
  termLabel,
} from '../src/format';

describe('TL-01 lease terms in words', () => {
  it('formats integer pesewas without rounding', () => {
    expect(formatMoney(220_000)).toBe('GH₵2,200.00');
    expect(formatMoney(450_050)).toBe('GH₵4,500.50');
    expect(formatMoney(7)).toBe('GH₵0.07');
    expect(formatMoney(123_456_789)).toBe('GH₵1,234,567.89');
    expect(rentLabel(180_000, 'quarterly')).toBe('GH₵1,800.00 a month, paid quarterly');
    expect(optionalMoney(null)).toBe('None');
    expect(optionalMoney(15_000, ' a month')).toBe('GH₵150.00 a month');
    expect(noticeLabel(30)).toBe('30 days');
    expect(noticeLabel(1)).toBe('1 day');
  });

  it('shows business dates as written, whatever the phone’s time zone', () => {
    const zone = process.env.TZ;
    try {
      // West of Greenwich, `new Date('2026-03-01')` is still 28 February in local time.
      process.env.TZ = 'America/Los_Angeles';
      expect(formatDate('2026-03-01')).toBe('1 March 2026');
      expect(termLabel('2026-01-01', '2026-12-31')).toBe('1 January 2026 to 31 December 2026');
      process.env.TZ = 'Pacific/Kiritimati';
      expect(formatDate('2026-12-31')).toBe('31 December 2026');
    } finally {
      process.env.TZ = zone;
    }
  });

  it('names the time zone with every time (DO-04)', () => {
    expect(formatTime('2026-10-29T17:05:00.000Z')).toBe('29 Oct 2026, 17:05 GMT (Africa/Accra)');
    expect(formatTime('2026-10-29T17:05:00.000Z', 'Europe/London')).toBe(
      '29 Oct 2026, 17:05 GMT (Europe/London)',
    );
  });
});
