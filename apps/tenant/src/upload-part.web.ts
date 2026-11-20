/** On the web a picked file is a Blob, which fetch sends as it is (src/upload-part.ts). */
export const uploadPart = (part: unknown): unknown => part;
