import { describe, expect, it } from 'vitest';
import { RenderFailed, RenderTimeout, waitForRender, type RenderCheck } from './render-wait';

const sequence = (...results: RenderCheck[]) => {
  let i = 0;
  return () => Promise.resolve(results[Math.min(i++, results.length - 1)]!);
};
const noWait = () => Promise.resolve();

describe('TX-03 the rent tax report’s PDF is fetched once the worker has rendered it', () => {
  it('waits while it renders, then gives its link', async () => {
    await expect(
      waitForRender(
        sequence(
          { status: 'rendering' },
          { status: 'rendering' },
          { status: 'ready', url: 'https://s/x.pdf' },
        ),
        { wait: noWait },
      ),
    ).resolves.toBe('https://s/x.pdf');
  });

  it('says so when rendering failed, or takes too long', async () => {
    await expect(
      waitForRender(sequence({ status: 'failed' }), { wait: noWait }),
    ).rejects.toBeInstanceOf(RenderFailed);
    await expect(
      waitForRender(sequence({ status: 'rendering' }), { wait: noWait, attempts: 3 }),
    ).rejects.toBeInstanceOf(RenderTimeout);
  });
});
