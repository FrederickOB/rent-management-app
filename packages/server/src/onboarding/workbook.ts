import {
  ONBOARDING_WORKBOOKS,
  type OnboardingBatchKind,
  type OnboardingSheetKey,
  type OnboardingSheetRows,
} from '@rent/domain/onboarding';
import type { ImportIssue } from '@rent/domain/portfolio';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { mapSheet } from '../portfolio/register-import.service';
import { declaredUncompressedSize, inflatedSize } from '../portfolio/zip-guard';

/**
 * The onboarding workbooks as files (M11 decision 2; plan 4.1), on PR-08's machinery: the zip
 * guard before unpacking, read-excel-file, each sheet's header mapped to its columns, and a
 * generated template with a Lists sheet. The sheets and their headers come from the domain's
 * `ONBOARDING_WORKBOOKS`, so the template, the reader and the e2e specs cannot drift.
 */

/** An .xlsx is a zip; refuse one that would unpack to more than this (zip bombs), as PR-08 does. */
const MAX_UNCOMPRESSED_BYTES = 50_000_000;

export interface ReadWorkbook {
  /** Each sheet the file has, by its key; a missing sheet is absent. */
  readonly sheets: Partial<Record<OnboardingSheetKey, OnboardingSheetRows>>;
  /** Problems with the file itself, or a missing required column. */
  readonly issues: ImportIssue[];
}

/** Reads a tenancies, balances or adjustment workbook. Never throws on a bad file. */
export async function readWorkbook(file: Buffer, kind: OnboardingBatchKind): Promise<ReadWorkbook> {
  const issues: ImportIssue[] = [];
  const whole = (message: string): ReadWorkbook => {
    issues.push({ sheet: 'File', row: null, column: null, message });
    return { sheets: {}, issues };
  };
  const tooLarge = 'This workbook is too large once unpacked';
  const size = declaredUncompressedSize(file);
  if (size === null) return whole('This is not an Excel workbook (.xlsx)');
  if (size > MAX_UNCOMPRESSED_BYTES) return whole(tooLarge);
  const inflated = inflatedSize(file, MAX_UNCOMPRESSED_BYTES);
  if (!inflated.ok)
    return whole(inflated.problem === 'too_large' ? tooLarge : 'This workbook could not be read');
  let workbook: { sheet: string; data: unknown[][] }[];
  try {
    workbook = (await readXlsxFile(file)) as unknown as { sheet: string; data: unknown[][] }[];
  } catch {
    return whole('This workbook could not be read');
  }
  const find = (name: string) =>
    workbook.find((s) => s.sheet.trim().toLowerCase() === name.toLowerCase())?.data ?? null;
  const sheets: Partial<Record<OnboardingSheetKey, OnboardingSheetRows>> = {};
  for (const s of ONBOARDING_WORKBOOKS[kind]) {
    const data = find(s.sheet);
    if (!data) continue;
    const mapped = mapSheet(s.sheet, data, s.columns);
    issues.push(...mapped.issues);
    sheets[s.key] = mapped.rows;
  }
  if (Object.keys(sheets).length === 0)
    whole(
      `The workbook needs at least one of these sheets: ${ONBOARDING_WORKBOOKS[kind]
        .map((s) => `"${s.sheet}"`)
        .join(', ')}`,
    );
  return { sheets, issues };
}

/**
 * A workbook's template: its sheets with their headers in order, and a Lists sheet of the allowed values (dropdown sources) the caller gives.
 */
export async function workbookTemplate(
  kind: OnboardingBatchKind,
  lists: readonly (readonly [string, readonly string[]])[],
): Promise<Buffer> {
  const bold = (value: string) => ({ value, fontWeight: 'bold' as const });
  const sheets = ONBOARDING_WORKBOOKS[kind].map((s) => ({
    sheet: s.sheet,
    // Headers only: an example row would be imported as a real record if left in.
    data: [s.columns.map((c) => bold(c.header))],
    stickyRowsCount: 1,
  }));
  const depth = Math.max(1, ...lists.map(([, values]) => values.length));
  const listRows = [
    lists.map(([title]) => bold(title)),
    ...Array.from({ length: depth }, (_, i) =>
      lists.map(([, values]) => (values[i] === undefined ? null : { value: values[i]! })),
    ),
  ];
  return writeXlsxFile([
    ...sheets,
    { sheet: 'Lists', data: listRows, stickyRowsCount: 1 },
  ]).toBuffer();
}
