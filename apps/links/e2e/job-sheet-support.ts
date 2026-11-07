import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { expect, type APIRequestContext } from '@playwright/test';
import { freshPhone, ok, smsTo } from './signing-support';

/**
 * Helpers for the job-sheet specs made in the M8 review round (after job-sheet.spec.ts): a new
 * room, a new artisan with SMS consent, and a job given to them, whose job sheet link arrives by
 * SMS. Every run makes its own, so nothing depends on an earlier run.
 */
export const SHEET_PATH = /\/j\/[A-Za-z0-9_-]{43}/;

export interface JobSheetJob {
  readonly jobId: string;
  readonly ticket: string;
  readonly artisanPhone: string;
  /** The job sheet's path on this host, `/j/<token>`. */
  readonly path: string;
}

/** A property of one single room for the agency's owner OWN-01, made through the API. */
async function newRoom(staff: APIRequestContext) {
  const owners = await ok<{ id: string; reference: string }[]>(
    await staff.get('/owners'),
    'owners',
  );
  const owner = owners.find((o) => o.reference === 'OWN-01');
  if (!owner) throw new Error('No OWN-01: run pnpm db:seed');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const part = Array.from({ length: 4 }, () =>
      String.fromCharCode(65 + Math.trunc(Math.random() * 26)),
    ).join('');
    const response = await staff.post('/properties', {
      data: {
        areaCode: 'ACC',
        propertyPart: part,
        name: `Job sheet photo rooms ${part} (e2e)`,
        propertyType: 'compound_house',
        use: 'residential',
        ownerId: owner.id,
        address: { region: 'Greater Accra', town: 'Madina' },
        units: [{ unitType: 'single_room', count: 1 }],
      },
    });
    if (response.status() === 409) continue;
    const property = await ok<{ id: string; blocks: { units: { id: string }[] }[] }>(
      response,
      'create a property',
    );
    return { propertyId: property.id, unitId: property.blocks.flatMap((b) => b.units)[0]!.id };
  }
  throw new Error('no free property code');
}

/** The newest SMS to a phone since `after` that matches, waiting for the worker to send it. */
export async function smsSince(
  phone: string,
  pattern: RegExp,
  after: number,
  what: string,
): Promise<string> {
  let found = '';
  await expect
    .poll(
      async () => {
        const message = (await smsTo(phone)).find(
          (m) => pattern.test(m.body) && Date.parse(m.at) >= after - 1_000,
        );
        found = message?.body ?? '';
        return found !== '';
      },
      { message: `${what} reaches the artisan by SMS`, timeout: 45_000 },
    )
    .toBe(true);
  return found;
}

/** A triaged repair on a new room, given to a new artisan; their job sheet link, from the SMS. */
export async function jobForNewArtisan(
  staff: APIRequestContext,
  description: string,
): Promise<JobSheetJob> {
  const room = await newRoom(staff);
  const artisanPhone = freshPhone();
  const artisan = await ok<{ id: string }>(
    await staff.post('/artisans', {
      data: {
        name: 'Esi Fixes-Many (e2e)',
        phone: artisanPhone,
        trades: ['plumbing'],
        consent: { whatsapp: false, sms: true },
      },
    }),
    'add an artisan',
  );
  const reported = await ok<{ id: string; ticket: string }>(
    await staff.post('/maintenance-jobs', {
      data: { propertyId: room.propertyId, unitId: room.unitId, description },
    }),
    'log a repair',
  );
  await ok(
    await staff.post(`/maintenance-jobs/${reported.id}/triage`, {
      data: { priority: 'routine', category: 'plumbing' },
    }),
    'triage the job',
  );
  const assignedAt = Date.now();
  await ok(
    await staff.post(`/maintenance-jobs/${reported.id}/assign`, {
      data: { assignee: { kind: 'artisan', artisanId: artisan.id } },
    }),
    'give the job to the artisan',
  );
  const sms = await smsSince(artisanPhone, SHEET_PATH, assignedAt, 'the job sheet link');
  return {
    jobId: reported.id,
    ticket: reported.ticket,
    artisanPhone,
    path: SHEET_PATH.exec(sms)![0],
  };
}

const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A valid PNG of about `bytes`: a 1-by-1 image with a private ancillary chunk (`teSt`) of random
 * bytes before its end, which decoders skip. Large photos without a large fixture file.
 */
export function largePng(bytes: number): Buffer {
  const data = randomBytes(Math.max(0, bytes - PNG_PIXEL.length - 12));
  const type = Buffer.from('teSt', 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const end = PNG_PIXEL.length - 12;
  return Buffer.concat([
    PNG_PIXEL.subarray(0, end),
    length,
    type,
    data,
    crc,
    PNG_PIXEL.subarray(end),
  ]);
}
