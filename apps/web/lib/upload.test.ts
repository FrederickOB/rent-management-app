import {
  PROPERTY_PAPER_MAX_BYTES,
  PROPERTY_PHOTO_MAX_BYTES,
  REGISTER_IMPORT_MAX_BYTES,
  XLSX_CONTENT_TYPE,
} from '@rent/domain/portfolio';
import { describe, expect, it } from 'vitest';
import {
  acceptFor,
  fileProblem,
  fileTypesLabel,
  PAPER_UPLOAD,
  PHOTO_UPLOAD,
  REGISTER_IMPORT_UPLOAD,
  sendToStorage,
  sizeLabel,
  StorageUploadError,
} from './upload';

describe('PR-04 uploads go straight to storage', () => {
  it('posts the signed fields first and the file last, without cookies', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const send = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const file = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    await sendToStorage(
      {
        url: 'http://storage.test/bucket',
        fields: { key: 'uploads/x', 'Content-Type': 'application/pdf' },
      },
      file,
      send,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://storage.test/bucket');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'omit' });
    const body = calls[0]?.init.body as FormData;
    expect([...body.keys()]).toEqual(['key', 'Content-Type', 'file']);
  });

  it('reports a refusal from storage', async () => {
    const send = (async () => new Response('denied', { status: 403 })) as typeof fetch;
    await expect(
      sendToStorage({ url: 'http://storage.test/bucket', fields: {} }, new Blob(['x']), send),
    ).rejects.toBeInstanceOf(StorageUploadError);
  });
});

describe('PR-04 and PR-08 upload limits on screen', () => {
  it('describes each kind of upload from the limits in packages/domain', () => {
    expect(fileTypesLabel(PHOTO_UPLOAD)).toBe('JPEG, PNG or WebP');
    expect(fileTypesLabel(PAPER_UPLOAD)).toBe('PDF, JPEG or PNG');
    expect(fileTypesLabel(REGISTER_IMPORT_UPLOAD)).toBe('Excel (.xlsx)');
    expect(sizeLabel(PROPERTY_PHOTO_MAX_BYTES)).toBe('10 MB');
    expect(sizeLabel(PROPERTY_PAPER_MAX_BYTES)).toBe('20 MB');
    expect(sizeLabel(REGISTER_IMPORT_MAX_BYTES)).toBe('5 MB');
    expect(acceptFor(PHOTO_UPLOAD)).toBe('image/jpeg,image/png,image/webp');
    expect(acceptFor(REGISTER_IMPORT_UPLOAD)).toBe(`.xlsx,${XLSX_CONTENT_TYPE}`);
  });

  it('refuses a wrong type, an empty file or one over the limit before anything is sent', () => {
    const file = (name: string, type: string, size: number) => ({ name, type, size });
    expect(fileProblem(file('front.jpg', 'image/jpeg', 1_000), PHOTO_UPLOAD)).toBeNull();
    expect(fileProblem(file('deed.pdf', 'application/pdf', 1_000), PHOTO_UPLOAD)).toBe(
      'Choose a JPEG, PNG or WebP file.',
    );
    expect(fileProblem(file('deed.pdf', 'application/pdf', 1_000), PAPER_UPLOAD)).toBeNull();
    expect(
      fileProblem(file('deed.pdf', 'application/pdf', PROPERTY_PAPER_MAX_BYTES + 1), PAPER_UPLOAD),
    ).toBe('The file must be 20 MB or smaller.');
    expect(fileProblem(file('front.png', 'image/png', 0), PHOTO_UPLOAD)).toBe(
      'That file is empty.',
    );
  });

  it('judges an import file by its name, as some systems give .xlsx no type', () => {
    expect(
      fileProblem({ name: 'Register.XLSX', type: '', size: 4_000 }, REGISTER_IMPORT_UPLOAD),
    ).toBeNull();
    expect(
      fileProblem({ name: 'register.csv', type: 'text/csv', size: 4_000 }, REGISTER_IMPORT_UPLOAD),
    ).toBe('Choose an Excel workbook (.xlsx).');
    expect(
      fileProblem(
        { name: 'register.xlsx', type: XLSX_CONTENT_TYPE, size: REGISTER_IMPORT_MAX_BYTES + 1 },
        REGISTER_IMPORT_UPLOAD,
      ),
    ).toBe('The file must be 5 MB or smaller.');
  });
});
