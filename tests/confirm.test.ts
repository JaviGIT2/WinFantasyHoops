import { describe, expect, it } from 'vitest';
import { answerConfirm, confirmAction, useConfirms } from '../src/components/confirm';

describe('confirmation dialog', () => {
  it('answers requests one at a time, in order', async () => {
    const first = confirmAction({ title: 'One?' });
    const second = confirmAction({ title: 'Two?', danger: true });
    expect(useConfirms.getState().queue.map((r) => r.title)).toEqual(['One?', 'Two?']);

    answerConfirm(true);
    expect(await first).toBe(true);
    expect(useConfirms.getState().queue.map((r) => r.title)).toEqual(['Two?']);

    answerConfirm(false);
    expect(await second).toBe(false);
    expect(useConfirms.getState().queue).toEqual([]);

    answerConfirm(true); // nothing on screen: ignored
    expect(useConfirms.getState().queue).toEqual([]);
  });
});
