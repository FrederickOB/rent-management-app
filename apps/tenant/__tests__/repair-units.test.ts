import {
  checkRepairFile,
  clockLabel,
  fileLabel,
  mediaTypeOf,
  secondsLabel,
  stepLabel,
  typeFromBytes,
} from '../src/repair-rules';

// MI-01 (M8 decision 2): what a tenant may attach to a repair request, before upload. The limits
// are the domain's MEDIA_RULES; the server checks every file again from its first bytes.

describe('MI-01 repair attachments: types, limits and words', () => {
  it('reads a file’s type as given, with the usual aliases, or from its name', () => {
    expect(mediaTypeOf('image/jpg', null)).toBe('image/jpeg');
    expect(mediaTypeOf('audio/x-m4a', 'a.m4a')).toBe('audio/mp4');
    expect(mediaTypeOf('audio/mp3', null)).toBe('audio/mpeg');
    expect(mediaTypeOf('video/quicktime; codecs=hvc1', null)).toBe('video/quicktime');
    expect(mediaTypeOf(null, 'IMG_0001.MOV')).toBe('video/quicktime');
    expect(mediaTypeOf(undefined, 'file:///x/voice-note.aac')).toBe('audio/aac');
    expect(mediaTypeOf(undefined, 'clip.3gp')).toBe('video/3gpp');
    expect(mediaTypeOf(undefined, 'noextension')).toBe('application/octet-stream');
  });

  it('takes the type the first bytes show, as the server will', () => {
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);
    expect(typeFromBytes(id3, 'audio/mp4')).toBe('audio/mpeg');
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(typeFromBytes(jpeg, 'image/png')).toBe('image/jpeg');
    // Bytes that show nothing this product takes leave the declared type, for the server to refuse.
    expect(typeFromBytes(new Uint8Array([1, 2, 3, 4]), 'video/mp4')).toBe('video/mp4');
    expect(typeFromBytes(null, 'video/mp4')).toBe('video/mp4');
  });

  it('keeps decision 2’s limits: photos 10 MB, video 50 MB and 90 s, voice notes 10 MB and 3 minutes', () => {
    expect(
      checkRepairFile({ contentType: 'image/jpeg', sizeBytes: 10_000_000, durationSeconds: null }),
    ).toEqual({ ok: true, kind: 'image' });
    expect(
      checkRepairFile({ contentType: 'image/jpeg', sizeBytes: 10_000_001, durationSeconds: null }),
    ).toEqual({ ok: false, problem: 'That photo is too big: at most 10 MB.' });
    expect(
      checkRepairFile({ contentType: 'video/mp4', sizeBytes: 40_000_000, durationSeconds: 89.5 }),
    ).toEqual({ ok: true, kind: 'video' });
    expect(
      checkRepairFile({ contentType: 'video/mp4', sizeBytes: 50_000_001, durationSeconds: 30 }),
    ).toEqual({ ok: false, problem: 'That video is too big: at most 50 MB.' });
    expect(
      checkRepairFile({ contentType: 'video/quicktime', sizeBytes: 1_000, durationSeconds: 91 }),
    ).toEqual({ ok: false, problem: 'That video is too long: at most 90 seconds.' });
    expect(
      checkRepairFile({ contentType: 'audio/mp4', sizeBytes: 1_000, durationSeconds: 181 }),
    ).toEqual({ ok: false, problem: 'That voice note is too long: at most 3 minutes.' });
    expect(
      checkRepairFile({ contentType: 'audio/aac', sizeBytes: 1_000, durationSeconds: null }),
    ).toEqual({
      ok: false,
      problem: 'We could not tell how long that voice note is. Choose it again.',
    });
    expect(
      checkRepairFile({ contentType: 'image/png', sizeBytes: 0, durationSeconds: null }),
    ).toEqual({ ok: false, problem: 'That photo is empty. Choose another.' });
    for (const contentType of ['image/heic', 'image/gif', 'application/pdf', 'audio/webm'])
      expect(checkRepairFile({ contentType, sizeBytes: 1_000, durationSeconds: 5 })).toMatchObject({
        ok: false,
        problem: expect.stringMatching(/cannot be sent/),
      });
  });

  it('names files and steps in words', () => {
    expect(fileLabel({ kind: 'image', sizeBytes: 2_400_000, durationSeconds: null })).toBe(
      'Photo (2.4 MB)',
    );
    expect(fileLabel({ kind: 'image', sizeBytes: 812_000, durationSeconds: null })).toBe(
      'Photo (812 KB)',
    );
    expect(fileLabel({ kind: 'audio', sizeBytes: 50_000, durationSeconds: 65.4 })).toBe(
      'Voice note (1:05)',
    );
    expect(fileLabel({ kind: 'video', sizeBytes: 9_000_000, durationSeconds: 12 })).toBe(
      'Video (0:12)',
    );
    expect(clockLabel(180)).toBe('3:00');
    expect(secondsLabel(90)).toBe('90 seconds');
    expect(secondsLabel(60)).toBe('1 minute');
    expect(stepLabel({ kind: 'work_done', at: '2026-11-05T14:20:00.000Z' })).toBe(
      'Work done, 5 Nov 2026, 14:20 GMT (Africa/Accra)',
    );
  });
});
