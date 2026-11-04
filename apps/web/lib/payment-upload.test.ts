import { describe, expect, it } from 'vitest';
import {
  CASH_PHOTO_UPLOAD,
  fileAgainMessage,
  needsFileAgain,
  PAYMENT_PROOF_UPLOAD,
  uploadOnce,
} from './payment-upload';
import { acceptFor, fileProblem, fileTypesLabel, sizeLabel } from './upload';

const photo = (name = 'receipt-book.jpg') => new File(['jpeg'], name, { type: 'image/jpeg' });

describe('BC-05, P07 and P28 money files go straight to storage', () => {
  it('takes the types and size limit that POST /payment-uploads accepts', () => {
    expect(PAYMENT_PROOF_UPLOAD.types).toEqual(['image/jpeg', 'image/png', 'application/pdf']);
    expect(sizeLabel(PAYMENT_PROOF_UPLOAD.maxBytes)).toBe('10 MB');
    expect(fileTypesLabel(PAYMENT_PROOF_UPLOAD)).toBe('JPEG, PNG or PDF');
  });

  it('takes only a photo for cash and cheques, from the camera', () => {
    expect(acceptFor(CASH_PHOTO_UPLOAD)).toBe('image/jpeg,image/png');
    expect(
      fileProblem({ name: 'scan.pdf', type: 'application/pdf', size: 100 }, CASH_PHOTO_UPLOAD),
    ).toBe('Choose a photo (JPEG or PNG).');
    expect(
      fileProblem({ name: 'page.jpg', type: 'image/jpeg', size: 100 }, CASH_PHOTO_UPLOAD),
    ).toBeNull();
  });

  it('uploads a chosen file once, so a retry sends the same upload and the same request', async () => {
    const sent: string[] = [];
    const once = uploadOnce(async (file, purpose) => {
      sent.push(`${purpose}:${file.name}`);
      return `upload-${sent.length}`;
    });
    const page = photo();
    expect(await once.idFor(page, 'cash_photo')).toBe('upload-1');
    expect(await once.idFor(page, 'cash_photo')).toBe('upload-1');
    // Another photo is another upload.
    expect(await once.idFor(photo('second.jpg'), 'cash_photo')).toBe('upload-2');
    // After a refusal the file is sent again.
    once.forget(page);
    expect(await once.idFor(page, 'cash_photo')).toBe('upload-3');
    expect(sent).toEqual([
      'cash_photo:receipt-book.jpg',
      'cash_photo:second.jpg',
      'cash_photo:receipt-book.jpg',
    ]);
  });

  it('tries the upload again when it failed, rather than remembering a failure', async () => {
    let calls = 0;
    const once = uploadOnce(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return 'upload-ok';
    });
    const page = photo();
    await expect(once.idFor(page, 'banking_slip')).rejects.toThrow('Failed to fetch');
    expect(await once.idFor(page, 'banking_slip')).toBe('upload-ok');
  });
});

describe('BC-05, P07 and P28 a refused upload asks for the file again', () => {
  const refusal = (status: number, code: string) =>
    Object.assign(new Error('refused'), { status, code });

  it('asks again when the upload expired, never arrived or was not the file declared', () => {
    expect(needsFileAgain(refusal(400, 'UPLOAD_EXPIRED'))).toBe(true);
    expect(needsFileAgain(refusal(400, 'UPLOAD_MISSING'))).toBe(true);
    expect(needsFileAgain(refusal(400, 'UPLOAD_REJECTED'))).toBe(true);
    // As a guard's body carries it, in lower case.
    expect(
      needsFileAgain(
        Object.assign(new Error('refused'), {
          status: 400,
          data: { body: { code: 'upload_expired' } },
        }),
      ),
    ).toBe(true);
  });

  it('keeps the upload for any other answer: the same upload id is safe to send again', () => {
    expect(needsFileAgain(refusal(409, 'CASH_SHORT'))).toBe(false);
    expect(needsFileAgain(refusal(400, 'PAYER_NAME'))).toBe(false);
    expect(needsFileAgain(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('says plainly what to do', () => {
    expect(fileAgainMessage('photo')).toBe(
      'The photo did not reach us, or its upload expired before it was used. Choose the photo again, then send it.',
    );
  });
});
