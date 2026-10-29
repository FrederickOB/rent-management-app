'use client';

import type { CompanyProfile, Me } from '@rent/contracts';
import { createContext, useContext, type ReactNode } from 'react';

export interface AppContextValue {
  readonly me: Me;
  /** Null when this session may not see the company profile (for example a platform admin). */
  readonly company: CompanyProfile | null;
  /** The company's time zone; every time on screen is shown in it, with its name (DO-04). */
  readonly timeZone: string;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  value,
  children,
}: {
  readonly value: AppContextValue;
  readonly children: ReactNode;
}) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp is used outside the app shell');
  return value;
}
