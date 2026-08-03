/**
 * Converts a picked/pasted image File into raw bytes ready for content-addressed storage
 * (idbAssetStore, since a browser guest has no local vault/filesystem the way Editor.tsx's
 * fsAssetStore does) and P2P sync as an asset key rather than embedded inline (see assetSync.ts
 * and imageSchemaExtensions.ts's `mime` attr).
 *
 * Raster formats (jpeg/png/webp) get downscaled/recompressed when larger than MAX_DIMENSION - an
 * unresized phone photo would otherwise be multiple MB every peer that doesn't have it yet has to
 * transfer. gif (animation would be destroyed by a canvas re-encode) and svg (already text-sized,
 * and rasterizing it would lose its vector nature) are stored as-is.
 */

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;
const RECOMPRESSIBLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface UploadableImage {
  bytes: Uint8Array;
  mime: string;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't decode that image"));
    img.src = url;
  });
}

function canvasToBytes(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Couldn't encode that image"));
          return;
        }
        blob
          .arrayBuffer()
          .then((buffer) => resolve(new Uint8Array(buffer)))
          .catch(reject);
      },
      mime,
      quality,
    );
  });
}

export async function fileToUploadableImage(file: File): Promise<UploadableImage> {
  const mime = file.type || "application/octet-stream";
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  if (!RECOMPRESSIBLE_TYPES.has(mime)) return { bytes: originalBytes, mime };

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(objectUrl);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale >= 1) return { bytes: originalBytes, mime };

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return { bytes: originalBytes, mime };
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const bytes = await canvasToBytes(canvas, "image/jpeg", JPEG_QUALITY);
    return { bytes, mime: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
