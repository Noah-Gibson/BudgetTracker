"use client";

import { SessionProvider } from "next-auth/react";
import { PrimeReactProvider } from "primereact/api";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <SessionProvider><PrimeReactProvider value={{ ripple: true }}>{children}</PrimeReactProvider></SessionProvider>;
}
