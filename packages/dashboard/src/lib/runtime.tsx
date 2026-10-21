'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { setApiBase } from './api.ts';
import type { AuthMode } from './auth-mode.ts';

/**
 * What the server decided at run time (lib/auth-mode.ts), for client
 * components: the sign-in mode and the control plane's URL. Without a
 * provider (and on the SaaS console) it is Clerk with the build-time API URL.
 */
export interface Runtime {
  auth: AuthMode;
  apiUrl?: string;
}

const Ctx = createContext<Runtime>({ auth: 'clerk' });

export function RuntimeProvider({ value, children }: { value: Runtime; children: ReactNode }) {
  // Before any child renders or fetches: the API client and error texts read it.
  if (value.apiUrl) setApiBase(value.apiUrl);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRuntime(): Runtime {
  return useContext(Ctx);
}
