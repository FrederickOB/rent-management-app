import { describe, expect, it } from 'vitest';
import {
  checkInspectionRooms,
  checkInspectionSubmittable,
  conditionWorsened,
  defaultInspectionRooms,
} from './inspections';
import {
  autoCloseDue,
  dueSlaWarnings,
  MAINTENANCE_JOB_TRANSITIONS,
  MAINTENANCE_TARGET_DEFAULTS,
  maintenanceSettingsOf,
  nextMaintenanceStatus,
} from './jobs';
import { checkDeclaredMedia, checkStagedMedia, sniffContentType } from './media';

/** M8 plan section 6: the job machine, MI-06's evidence, SLAs, media and inspections. */
const HOUR = 3_600_000;
const bytes = (...values: (number | string)[]) =>
  new Uint8Array(
    values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])),
  );

describe('MI-06 the job state machine', () => {
  it('walks Reported to Closed, with the disputes, declines and cancellations of architecture section 7', () => {
    let s = nextMaintenanceStatus('reported', 'triage', {
      priority: 'urgent',
      category: 'plumbing',
    });
    expect(s).toBe('triaged');
    s = nextMaintenanceStatus(s, 'assign');
    expect(nextMaintenanceStatus(s, 'unassign')).toBe('triaged');
    s = nextMaintenanceStatus(s, 'start', { beforePhotos: 1 });
    s = nextMaintenanceStatus(s, 'complete', {
      afterPhotos: 1,
      completionNote: 'Replaced the tap',
    });
    expect(nextMaintenanceStatus(s, 'dispute', { reason: 'Still leaking' })).toBe('in_progress');
    expect(nextMaintenanceStatus(s, 'confirm')).toBe('closed');
    expect(nextMaintenanceStatus(s, 'auto_close')).toBe('closed');
    expect(nextMaintenanceStatus('triaged', 'cancel', { reason: 'Duplicate' })).toBe('cancelled');
    expect(() => nextMaintenanceStatus('closed', 'dispute', { reason: 'x y z' })).toThrow(
      expect.objectContaining({ code: 'maintenance.transition' }),
    );
    expect(() => nextMaintenanceStatus('in_progress', 'cancel', { reason: 'abc' })).toThrow();
    expect(MAINTENANCE_JOB_TRANSITIONS).toContainEqual(['work_done', 'in_progress']);
  });

  it('★ cannot mark work done without an after photo and a completion note', () => {
    expect(() =>
      nextMaintenanceStatus('in_progress', 'complete', { afterPhotos: 0, completionNote: 'Done' }),
    ).toThrow(expect.objectContaining({ code: 'maintenance.after_photo_required' }));
    expect(() =>
      nextMaintenanceStatus('in_progress', 'complete', { afterPhotos: 2, completionNote: ' ' }),
    ).toThrow(expect.objectContaining({ code: 'maintenance.completion_note_required' }));
  });

  it('starts work only with a before photo or a recorded reason', () => {
    expect(() => nextMaintenanceStatus('assigned', 'start', {})).toThrow(
      expect.objectContaining({ code: 'maintenance.before_photo_required' }),
    );
    expect(
      nextMaintenanceStatus('assigned', 'start', { beforePhotoReason: 'Emergency: no time' }),
    ).toBe('in_progress');
  });
});

describe('MI-02 targets and SLA warnings', () => {
  const base = {
    jobId: 'j',
    status: 'triaged' as const,
    priority: 'emergency' as const,
    reportedAt: new Date('2026-11-09T10:00:00Z'),
    respondedAt: null,
    workDoneAt: null,
    target: MAINTENANCE_TARGET_DEFAULTS.emergency,
    sent: new Set<string>(),
  };
  it('warns when a target is about to be missed and when it is missed, once each', () => {
    const at = (h: number) => new Date(base.reportedAt.getTime() + h * HOUR);
    expect(dueSlaWarnings({ ...base, now: at(1) })).toEqual([]);
    const soon = dueSlaWarnings({ ...base, now: at(1.6) });
    expect(soon.map((w) => [w.target, w.stage])).toEqual([['respond', 'due_soon']]);
    expect(dueSlaWarnings({ ...base, now: at(1.6), sent: new Set([soon[0]!.key]) })).toEqual([]);
    expect(dueSlaWarnings({ ...base, now: at(2) }).map((w) => w.stage)).toEqual(['missed']);
    // Responded: only completion is watched.
    expect(
      dueSlaWarnings({ ...base, respondedAt: at(1), now: at(25) }).map((w) => [w.target, w.stage]),
    ).toEqual([['complete', 'missed']]);
    expect(dueSlaWarnings({ ...base, status: 'closed', now: at(30) })).toEqual([]);
  });

  it('applies a company’s own targets and auto-close days, the defaults elsewhere', () => {
    const s = maintenanceSettingsOf({
      maintenanceTargets: { routine: { respondHours: 48, completeHours: 240 } },
    });
    expect(s.targets.routine).toEqual({ respondHours: 48, completeHours: 240 });
    expect(s.targets.emergency).toEqual(MAINTENANCE_TARGET_DEFAULTS.emergency);
    expect(s.autoCloseDays).toBe(7);
    const done = new Date('2026-11-01T10:00:00Z');
    expect(autoCloseDue(done, new Date('2026-11-08T09:59:00Z'), 7)).toBe(false);
    expect(autoCloseDue(done, new Date('2026-11-08T10:00:00Z'), 7)).toBe(true);
  });
});

describe('MI-01 media types by their first bytes (decision 2)', () => {
  it('recognises each type this product takes, and nothing else', () => {
    expect(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffContentType(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffContentType(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp');
    expect(sniffContentType(bytes(0, 0, 0, 0x18, 'ftyp', 'isom'))).toBe('video/mp4');
    expect(sniffContentType(bytes(0, 0, 0, 0x14, 'ftyp', 'qt  '))).toBe('video/quicktime');
    expect(sniffContentType(bytes(0, 0, 0, 0x14, 'ftyp', '3gp5'))).toBe('video/3gpp');
    expect(sniffContentType(bytes(0, 0, 0, 0x20, 'ftyp', 'M4A '))).toBe('audio/mp4');
    expect(sniffContentType(bytes('ID3', 4, 0))).toBe('audio/mpeg');
    expect(sniffContentType(bytes(0xff, 0xfb, 0x90))).toBe('audio/mpeg');
    expect(sniffContentType(bytes(0xff, 0xf1, 0x50))).toBe('audio/aac');
    expect(sniffContentType(bytes('OggS', 0))).toBe('audio/ogg');
    expect(sniffContentType(bytes('#!AMR\n'))).toBe('audio/amr');
    expect(sniffContentType(bytes('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffContentType(bytes('MZ', 0x90, 0))).toBeNull();
    expect(sniffContentType(bytes(0, 0, 0, 0x18, 'ftyp', 'heic'))).toBe('image/heic');
  });

  it('refuses a renamed file, a type the purpose does not take, and files over the limits', () => {
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0);
    expect(() =>
      checkStagedMedia({ kinds: ['video'], declaredType: 'video/mp4', head: jpeg, sizeBytes: 10 }),
    ).toThrow(expect.objectContaining({ code: 'media.type_mismatch' }));
    expect(() =>
      checkStagedMedia({
        kinds: ['image', 'video'],
        declaredType: 'video/mp4',
        head: jpeg,
        sizeBytes: 10,
      }),
    ).toThrow(expect.objectContaining({ code: 'media.type_mismatch' }));
    expect(
      checkStagedMedia({ kinds: ['image'], declaredType: 'image/png', head: jpeg, sizeBytes: 10 }),
    ).toEqual({ kind: 'image', contentType: 'image/jpeg' });
    expect(() =>
      checkDeclaredMedia({
        kinds: ['video'],
        contentType: 'video/mp4',
        sizeBytes: 60_000_000,
        durationSeconds: 10,
      }),
    ).toThrow(expect.objectContaining({ code: 'media.too_large' }));
    expect(() =>
      checkDeclaredMedia({
        kinds: ['video'],
        contentType: 'video/mp4',
        sizeBytes: 1000,
        durationSeconds: 91,
      }),
    ).toThrow(expect.objectContaining({ code: 'media.too_long' }));
    expect(() =>
      checkDeclaredMedia({
        kinds: ['audio'],
        contentType: 'audio/amr',
        sizeBytes: 1000,
        durationSeconds: 181,
      }),
    ).toThrow(expect.objectContaining({ code: 'media.too_long' }));
    expect(() =>
      checkDeclaredMedia({ kinds: ['image'], contentType: 'image/heic', sizeBytes: 1000 }),
    ).toThrow(expect.objectContaining({ code: 'media.type_not_allowed' }));
  });
});

describe('MI-10 inspections', () => {
  it('builds default rooms by unit type, with stable keys', () => {
    const flat = defaultInspectionRooms('apartment', 3);
    expect(flat.map((r) => r.key)).toEqual([
      'living_room',
      'bedroom_1',
      'bedroom_2',
      'bedroom_3',
      'kitchen',
      'bathroom',
      'compound',
      'meters_and_keys',
    ]);
    expect(checkInspectionRooms(flat)).toHaveLength(8);
    expect(defaultInspectionRooms('shop').map((r) => r.key)).toContain('main_space');
    expect(() =>
      checkInspectionRooms([
        { key: 'a', label: 'A', items: [{ key: 'x', label: 'X' }] },
        { key: 'a', label: 'B', items: [{ key: 'y', label: 'Y' }] },
      ]),
    ).toThrow(/own short key/);
  });

  it('submits only when every item has a condition, and compares move-out with move-in', () => {
    expect(() =>
      checkInspectionSubmittable([
        { roomKey: 'r', itemKey: 'a', condition: 'good' },
        { roomKey: 'r', itemKey: 'b', condition: null },
      ]),
    ).toThrow(/1 still have none/);
    expect(conditionWorsened('good', 'damaged')).toBe(true);
    expect(conditionWorsened('poor', 'poor')).toBe(false);
    expect(conditionWorsened(null, 'missing')).toBe(true);
    expect(conditionWorsened('fair', 'not_applicable')).toBe(false);
  });
});
