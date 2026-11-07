import { z } from 'zod';

// Strict formats: these values end up inside CSS and attributes, so nothing else may get through.
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
// Logos are re-encoded to PNG on upload (docs/plans/M1.md section 4.13). Data URIs only: the
// renderer loads nothing from the network.
const LOGO_DATA_URI = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i;

/** A company's letterhead (AD-01): logo, primary and accent colours and sender name. */
export const brandingSchema = z.strictObject({
  senderName: z.string().min(1).max(120),
  primaryColour: z.string().regex(HEX_COLOUR, 'Expected a colour such as #0F766E'),
  accentColour: z.string().regex(HEX_COLOUR, 'Expected a colour such as #F59E0B'),
  logoDataUri: z
    .string()
    .max(2_000_000)
    .regex(LOGO_DATA_URI, 'Expected a PNG, JPEG or WebP data URI')
    .optional(),
  /**
   * M8 (decision 11): photo thumbnails a template shows, by document id. The renderer reads them
   * from storage by the ids in the data, so the frozen data holds ids and fingerprints, never
   * images. Data URIs only, as the logo.
   */
  images: z
    .record(
      z.string().uuid(),
      z.string().max(2_000_000).regex(LOGO_DATA_URI, 'Expected a PNG, JPEG or WebP data URI'),
    )
    .optional(),
});

export type Branding = z.infer<typeof brandingSchema>;
