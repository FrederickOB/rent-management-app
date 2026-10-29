/** Links that look like buttons, at the touch size buttons use (44 px). */
const base =
  'inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-medium';

export const primaryLink = `${base} bg-brand text-brand-contrast hover:opacity-90`;
export const secondaryLink = `${base} border border-slate-300 bg-white text-slate-900 hover:bg-slate-100`;
/** A plain text link with the tap height of a button. */
export const textLink =
  'inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2';
