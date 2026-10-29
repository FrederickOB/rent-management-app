'use client';

import { useState } from 'react';
import { Button } from './ui/button';

/**
 * Backup codes, shown once (AD-06). The server keeps them encrypted and never shows them
 * again, so people can copy or download them here.
 */
export function BackupCodeList({ codes }: { readonly codes: readonly string[] }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rent-platform-backup-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <ul
        data-testid="backup-codes"
        aria-label="Backup codes"
        className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-sm sm:grid-cols-3"
      >
        {codes.map((code) => (
          <li key={code} className="tracking-wider">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={copy}>
          Copy codes
        </Button>
        <Button variant="secondary" size="sm" onClick={download}>
          Download codes
        </Button>
        {copied ? (
          <span role="status" className="text-sm text-emerald-800">
            Copied
          </span>
        ) : null}
      </div>
    </div>
  );
}
