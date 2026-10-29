import type { ReactNode } from 'react';

/** Signed-out and set-up screens: the platform's own colours, one narrow column. */
export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-brand text-brand-contrast">
        <div className="mx-auto max-w-md px-4 py-4 text-base font-semibold">Rent Platform</div>
      </header>
      <main id="main" className="mx-auto w-full max-w-md flex-1 space-y-6 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
