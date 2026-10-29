import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-md space-y-4 px-4 py-12">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-slate-700">The page you asked for does not exist or has moved.</p>
      <Link href="/" className="text-sm font-medium underline underline-offset-2">
        Go to the home page
      </Link>
    </main>
  );
}
