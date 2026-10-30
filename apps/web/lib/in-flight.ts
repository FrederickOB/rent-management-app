import { useEffect } from 'react';

// A money write on its way keeps the person on the form (M4a review, item 12). Leaving before the
// answer would leave nobody to see it, and someone who came back could not tell whether the money
// was recorded. Closing or reloading the tab asks first; links on the page do nothing until the
// answer arrives. The form's own Cancel is disabled meanwhile.

/** The two event targets the hold listens on: the window and the document. */
export interface PageEvents {
  addEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
}

interface MaybeElement {
  readonly closest?: (selector: string) => unknown;
}

/** Holds the page until the returned release is called. */
export function holdPage(win: PageEvents, doc: PageEvents): () => void {
  const onBeforeUnload = (event: Event) => {
    event.preventDefault();
    // Some browsers ask only when returnValue is set as well.
    (event as BeforeUnloadEvent).returnValue = '';
  };
  const onClick = (event: Event) => {
    const target = event.target as MaybeElement | null;
    if (typeof target?.closest !== 'function' || !target.closest('a[href]')) return;
    event.preventDefault();
    // Before React sees it, so a client-side link does not navigate either.
    event.stopPropagation();
  };
  win.addEventListener('beforeunload', onBeforeUnload);
  doc.addEventListener('click', onClick, true);
  return () => {
    win.removeEventListener('beforeunload', onBeforeUnload);
    doc.removeEventListener('click', onClick, true);
  };
}

/** Holds the page while `sending` is true. */
export function useHoldWhileSending(sending: boolean): void {
  useEffect(() => (sending ? holdPage(window, document) : undefined), [sending]);
}
