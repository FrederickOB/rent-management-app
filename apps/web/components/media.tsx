'use client';

import type { MediaKind } from '@rent/domain/maintenance';
import { MEDIA_MAX_FILES_PER_REQUEST } from '@rent/domain/maintenance';
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { openFetchedLink } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { formatTime } from '@/lib/format';
import { durationText, mediaAccept, mediaHint } from '@/lib/maintenance';
import { declareMedia, MediaRefused } from '@/lib/media-upload';
import { sizeLabel } from '@/lib/upload';
import { useApp } from './app-context';
import { Alert } from './ui/alert';
import { Button } from './ui/button';

// Photos, videos and voice notes on screen (M8 decision 2): shown with the browser's own players,
// each opened by a short-lived link fetched after a policy check (CLAUDE.md section 10). Nothing
// is kept in the page beyond the link while it is shown.

export interface PickedFile {
  readonly key: string;
  readonly file: File;
  /** Why the rules refuse it, or null. */
  readonly problem: string | null;
}

let nextKey = 0;

/** The files on a form that can be sent: none refused, and no more than the rules allow. */
export const usableFiles = (files: readonly PickedFile[]): File[] =>
  files.filter((f) => f.problem === null).map((f) => f.file);

export const anyRefused = (files: readonly PickedFile[]): boolean =>
  files.some((f) => f.problem !== null);

/**
 * A file picker that keeps a list of the files chosen, each checked by the domain's rules as it is
 * chosen (kind, size and, for video and voice notes, length), so a wrong file is said at once.
 */
export function MediaPicker({
  label,
  kinds,
  files,
  onChange,
  error,
  disabled,
  note,
  capture,
}: {
  readonly label: string;
  readonly kinds: readonly MediaKind[];
  readonly files: readonly PickedFile[];
  readonly onChange: (files: PickedFile[]) => void;
  readonly error?: string | null;
  readonly disabled?: boolean;
  /** What the files must show, read with the field (for example "Both are required"). */
  readonly note?: string;
  /**
   * On a phone, also offer "Take a photo", which opens the camera directly (review WEB 7: the
   * picker itself keeps the gallery). It is one file input either way.
   */
  readonly capture?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [checking, setChecking] = useState(false);
  const latest = useRef(files);
  latest.current = files;

  /** Opens the camera: the same input, with `capture` set only for this one choice. */
  function takePhoto() {
    const element = input.current;
    if (!element) return;
    element.setAttribute('capture', 'environment');
    element.click();
    // The chooser reads `capture` as it opens; the next tap on the picker offers the gallery.
    window.setTimeout(() => element.removeAttribute('capture'), 0);
  }

  async function chosen(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    event.target.removeAttribute('capture');
    if (picked.length === 0) return;
    setChecking(true);
    const checked = await Promise.all(
      picked.map(async (file): Promise<PickedFile> => {
        try {
          await declareMedia(file, kinds);
          return { key: `f${(nextKey += 1)}`, file, problem: null };
        } catch (failure) {
          return {
            key: `f${(nextKey += 1)}`,
            file,
            problem: failure instanceof MediaRefused ? failure.message : toProblem(failure).message,
          };
        }
      }),
    );
    setChecking(false);
    onChange([...latest.current, ...checked]);
  }

  const tooMany = usableFiles(files).length > MEDIA_MAX_FILES_PER_REQUEST;
  const errorId = error || tooMany ? `${id}-error` : undefined;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {note ? <p className="text-sm font-medium text-slate-900">{note}</p> : null}
      <input
        ref={input}
        id={id}
        type="file"
        multiple
        accept={mediaAccept(kinds)}
        disabled={disabled || checking}
        aria-describedby={[`${id}-hint`, errorId].filter(Boolean).join(' ')}
        aria-invalid={error || tooMany ? true : undefined}
        onChange={(event) => void chosen(event)}
        className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
      />
      {capture ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || checking}
          onClick={takePhoto}
          className="sm:hidden"
        >
          Take a photo
        </Button>
      ) : null}
      <p id={`${id}-hint`} className="text-sm text-slate-600">
        {mediaHint(kinds)}
      </p>
      {checking ? (
        <p role="status" className="text-sm text-slate-600">
          Checking the files…
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className="space-y-1 text-sm" aria-label={`${label}: chosen`}>
          {files.map((f) => (
            <li
              key={f.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-2 py-1"
              data-testid="picked-file"
            >
              <span className="min-w-0 break-all">
                {f.file.name || 'Unnamed file'}{' '}
                <span className="text-slate-600">({sizeLabel(f.file.size)})</span>
                {f.problem ? (
                  <span className="block font-medium text-red-700">{f.problem}</span>
                ) : null}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-label={`Remove ${f.file.name || 'this file'}`}
                onClick={() => onChange(files.filter((other) => other.key !== f.key))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error || tooMany ? (
        <p id={errorId} className="text-sm font-medium text-red-700">
          {tooMany ? `Choose at most ${MEDIA_MAX_FILES_PER_REQUEST} files at a time.` : error}
        </p>
      ) : null}
    </div>
  );
}

export type ViewerKind = 'image' | 'video' | 'audio' | 'link';

/**
 * One file, shown with the browser's own player. A photo loads its link at once; a video or
 * voice note only when asked, so a page of them costs nothing on 3G until one is played. A link
 * that has expired (they last minutes) is fetched again on request.
 */
export function MediaView({
  kind,
  name,
  durationSeconds,
  load,
  when,
}: {
  readonly kind: ViewerKind;
  /** "Photo 2, after the work": the accessible name and the button's words. */
  readonly name: string;
  readonly durationSeconds?: number | null;
  readonly load: () => Promise<string>;
  /**
   * Review WEB 5: the server's time the file was taken or added, shown with the time zone (the
   * photo's own date is never trusted).
   */
  readonly when?: { readonly label: 'Taken' | 'Added'; readonly at: string } | null;
}) {
  const { timeZone } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  async function fetchLink() {
    setLoading(true);
    setProblem(null);
    setBroken(false);
    try {
      const link = await loadRef.current();
      if (!/^https?:\/\//i.test(link)) throw new Error('unexpected link');
      setUrl(link);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (kind !== 'image') return;
    let current = true;
    void loadRef.current().then(
      (link) => {
        if (current && /^https?:\/\//i.test(link)) setUrl(link);
      },
      (failure: unknown) => {
        if (current) setProblem(toProblem(failure).message);
      },
    );
    return () => {
      current = false;
    };
  }, [kind]);

  const length = durationText(durationSeconds ?? null);
  const again = (
    <Button size="sm" variant="secondary" pending={loading} onClick={() => void fetchLink()}>
      Load {name.toLowerCase()} again
    </Button>
  );

  if (kind === 'link') {
    return (
      <div className="space-y-1">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void openFetchedLink(loadRef.current).catch((failure: unknown) =>
              setProblem(toProblem(failure).message),
            )
          }
        >
          Open {name.toLowerCase()}
        </Button>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
      </div>
    );
  }

  return (
    <figure className="space-y-1" data-testid="media-view" data-kind={kind}>
      {url && !broken ? (
        kind === 'image' ? (
          // A short-lived signed link, so a plain img: next/image would cache it past its expiry.
          <img
            src={url}
            alt={name}
            loading="lazy"
            onError={() => setBroken(true)}
            className="max-h-64 w-auto max-w-full rounded-md border border-slate-200 object-contain"
          />
        ) : kind === 'video' ? (
          <video
            src={url}
            controls
            preload="metadata"
            aria-label={name}
            onError={() => setBroken(true)}
            className="w-full max-w-md rounded-md border border-slate-200"
          />
        ) : (
          <audio
            src={url}
            controls
            preload="metadata"
            aria-label={name}
            onError={() => setBroken(true)}
            className="w-full max-w-md"
          />
        )
      ) : null}
      {!url && kind !== 'image' ? (
        <Button size="sm" variant="secondary" pending={loading} onClick={() => void fetchLink()}>
          Play {name.toLowerCase()}
          {length ? ` (${length})` : ''}
        </Button>
      ) : null}
      {!url && kind === 'image' && !problem ? (
        <p role="status" className="text-sm text-slate-600">
          Loading {name.toLowerCase()}…
        </p>
      ) : null}
      <figcaption className="text-xs text-slate-600">
        {name}
        {length && url ? ` · ${length}` : ''}
        {when ? (
          <span data-testid="media-when">
            {' · '}
            {when.label.toLowerCase()}{' '}
            <time dateTime={when.at}>{formatTime(when.at, timeZone)}</time>
          </span>
        ) : null}
        {url && !broken ? (
          <>
            {' · '}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Open in a new tab
            </a>
          </>
        ) : null}
      </figcaption>
      {broken ? (
        <div className="space-y-1">
          <p className="text-sm text-slate-700">
            The link has expired, or the file could not play here.
          </p>
          {again}
        </div>
      ) : null}
      {problem ? (
        <div className="space-y-1">
          <Alert tone="error">{problem}</Alert>
          {again}
        </div>
      ) : null}
    </figure>
  );
}
