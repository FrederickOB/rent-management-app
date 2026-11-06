/**
 * How many repair requests a session's end removed from this phone since the last sign-in (M8
 * review LT 9), for the sign-in screen to say so. A module of its own, with nothing to load, so
 * the sign-in screen does not load the queue.
 */
let dropped = 0;

export const droppedRepairs = (): number => dropped;

export function noteDroppedRepairs(count: number): void {
  dropped += count;
}

/** Signed in again: the sign-in screen has said it. */
export function clearDroppedRepairs(): void {
  dropped = 0;
}
