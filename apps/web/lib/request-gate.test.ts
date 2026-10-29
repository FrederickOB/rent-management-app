import { describe, expect, it } from 'vitest';
import { requestGate } from './request-gate';

describe('AD-05 and TL-01 a late reply never replaces a newer one', () => {
  it('keeps only the newest request, so a slow "Waiting" list cannot fill the "Closed" tab', () => {
    const gate = requestGate();
    const waiting = gate.begin();
    const closed = gate.begin();
    // The "Waiting" reply arrives last, but a newer request has started: it is dropped.
    expect(waiting()).toBe(false);
    expect(closed()).toBe(true);
  });

  it('drops every reply still on its way when the screen moves on', () => {
    const gate = requestGate();
    const search = gate.begin();
    gate.cancel();
    expect(search()).toBe(false);
    expect(gate.begin()()).toBe(true);
  });

  it('gives each screen a gate of its own', () => {
    const tenants = requestGate();
    const leases = requestGate();
    const list = tenants.begin();
    leases.begin();
    expect(list()).toBe(true);
  });
});
