/**
 * Browser-only file helpers. Documents are served by short-lived links issued after a policy
 * check (CLAUDE.md section 10); these open or save them without keeping them anywhere.
 */

/** Saves a downloaded file, such as the import template, under its own name. */
export function saveFile(file: Blob, fileName: string): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before the object URL goes.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Opens a link that has to be fetched first (a 5-minute download link) in a new tab. The tab is
 * opened during the click, before the request, so phone browsers do not block it as a pop-up;
 * the new tab gets no handle on this page. If the request fails, the tab is closed again.
 */
export async function openFetchedLink(load: () => Promise<string>): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const url = await load();
    if (!/^https?:\/\//i.test(url)) throw new Error('unexpected link');
    if (tab) tab.location.replace(url);
    else window.location.assign(url);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/**
 * Starts the download of a short-lived signed link served as an attachment (a dashboard export):
 * the browser saves the file and the page stays where it is. No tab is opened, so none is left
 * empty behind the download.
 */
export function startDownload(url: string): void {
  if (!/^https?:\/\//i.test(url)) throw new Error('unexpected link');
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}
