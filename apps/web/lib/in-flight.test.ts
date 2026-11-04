import { describe, expect, it } from 'vitest';
import { holdPage, type PageEvents } from './in-flight';

type Listener = (event: Event) => void;

/** An event target that records its listeners, so a test can call them directly. */
function target(): PageEvents & { readonly listeners: Map<string, Listener[]> } {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
  };
}

function event(targetElement: unknown) {
  const state = { prevented: false, stopped: false };
  const fake = {
    target: targetElement,
    preventDefault: () => {
      state.prevented = true;
    },
    stopPropagation: () => {
      state.stopped = true;
    },
  } as unknown as Event;
  return { fake, state };
}

describe('BC-05 and plan 4.15 a money write on its way keeps the person on the form', () => {
  it('asks before the tab is closed or reloaded', () => {
    const win = target();
    const doc = target();
    holdPage(win, doc);
    const { fake, state } = event(null);
    for (const listener of win.listeners.get('beforeunload') ?? []) listener(fake);
    expect(state.prevented).toBe(true);
  });

  it('stops links on the page, and nothing else', () => {
    const win = target();
    const doc = target();
    holdPage(win, doc);
    const click = (element: unknown) => {
      const { fake, state } = event(element);
      for (const listener of doc.listeners.get('click') ?? []) listener(fake);
      return state;
    };
    const insideLink = { closest: (selector: string) => (selector === 'a[href]' ? {} : null) };
    const button = { closest: () => null };
    expect(click(insideLink)).toEqual({ prevented: true, stopped: true });
    expect(click(button)).toEqual({ prevented: false, stopped: false });
    expect(click({})).toEqual({ prevented: false, stopped: false });
  });

  it('lets go once the answer has come', () => {
    const win = target();
    const doc = target();
    const release = holdPage(win, doc);
    release();
    expect(win.listeners.get('beforeunload')).toEqual([]);
    expect(doc.listeners.get('click')).toEqual([]);
  });
});
