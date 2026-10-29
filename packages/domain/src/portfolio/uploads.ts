/**
 * Upload limits for the register (PR-04, PR-08; M2 plan 4.7 and 4.8). The API, its contracts and
 * the screens all read them from here, so a limit is changed in one place.
 */
export const PROPERTY_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PROPERTY_PHOTO_MAX_BYTES = 10_000_000;

export const PROPERTY_PAPER_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const PROPERTY_PAPER_MAX_BYTES = 20_000_000;

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const REGISTER_IMPORT_MAX_BYTES = 5_000_000;
