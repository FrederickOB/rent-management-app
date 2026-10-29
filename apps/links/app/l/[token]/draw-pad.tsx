'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A drawn signature (signature_pad), on the drawing step only: the library loads when this
 * mounts, never on the rest of the page (M3 plan 4.8 budget). The drawing goes into a hidden
 * form field as a PNG data URL when each stroke ends, so the form posts it with the code.
 */
export function DrawPad({ name }: { name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const pad = useRef<{ clear(): void; isEmpty(): boolean; off(): void } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import('signature_pad').then(({ default: SignaturePad }) => {
      const element = canvas.current;
      if (cancelled || !element) return;
      // At most twice the CSS size: sharp enough to read, small enough to send over 3G.
      const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      element.width = element.offsetWidth * ratio;
      element.height = element.offsetHeight * ratio;
      element.getContext('2d')?.scale(ratio, ratio);
      const signature = new SignaturePad(element, {
        penColor: '#111111',
        backgroundColor: 'rgb(255, 255, 255)',
      });
      signature.addEventListener('endStroke', () => {
        if (field.current)
          field.current.value = signature.isEmpty() ? '' : signature.toDataURL('image/png');
      });
      pad.current = signature;
      setReady(true);
    });
    return () => {
      cancelled = true;
      pad.current?.off();
    };
  }, []);

  return (
    <div className="pad">
      <canvas id="pad" ref={canvas} aria-label="Draw your signature here" />
      <input type="hidden" name={name} ref={field} />
      <div className="row">
        <span className="small">{ready ? 'Sign with your finger or mouse.' : 'Loading…'}</span>
        <button
          className="secondary"
          type="button"
          disabled={!ready}
          onClick={() => {
            pad.current?.clear();
            if (field.current) field.current.value = '';
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
