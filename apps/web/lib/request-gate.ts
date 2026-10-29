import { useState } from 'react';

/**
 * Keeps only the newest request's reply. Each `begin()` starts a request and returns a check that
 * stays true only while no newer request has started, so a slow reply that arrives after a newer
 * one (a tab switched, a filter changed, a poll overtaken by a refresh) is dropped, never shown.
 */
export interface RequestGate {
  readonly begin: () => () => boolean;
  /** Drops every reply still on its way, for example when the screen closes. */
  readonly cancel: () => void;
}

export function requestGate(): RequestGate {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      const mine = latest;
      return () => mine === latest;
    },
    cancel() {
      latest += 1;
    },
  };
}

/** One gate for the life of a component. */
export function useRequestGate(): RequestGate {
  const [gate] = useState(requestGate);
  return gate;
}
