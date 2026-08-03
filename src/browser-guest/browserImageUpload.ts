/**
 * Converts a picked/pasted image File into a data: URI suitable for embedding directly in the
 * note's synced content - a browser guest has no local vault/filesystem to write an attachment
 * file to the way Editor.tsx's writeAttachment does, so the image's bytes themselves become the
 * `src` (see imageView.ts's `isExternal` check, which already renders a `data:`/`http(s):` src
 * as-is on the desktop side too - so an image inserted here needs no changes there to display).
 *
 * Raster formats (jpeg/png/webp) get downscaled/recompressed when larger than MAX_DIMENSION,
 * since the image's bytes now live inside the real-time collab document (not a side file) -
 * an unresized phone photo would otherwise multiply the sync payload every guest has to receive.
 * gif (animation would be destroyed by a canvas re-encode) and svg (already text-sized, and
 * rasterizing it would lose its vector nature) are embedded as-is.
 */

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;
const RECOMPRESSIBLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read that file"));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't decode that image"));
    img.src = dataUri;
  });
}

export async function fileToUploadDataUri(file: File): Promise<string> {
  const original = await readFileAsDataUri(file);
  if (!RECOMPRESSIBLE_TYPES.has(file.type)) return original;

  const img = await loadImageElement(original);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale >= 1) return original;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return original;
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}
