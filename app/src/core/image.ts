// Attachment preparation. Phone photos (2-6 MB) are downscaled to 1600 px JPEG (~150-400 KB)
// before encryption, which is what made the v1 app hit its storage limit.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 1600;
const QUALITY = 0.82;

export interface Prepared { bytes: Uint8Array<ArrayBuffer>; mime: string; name: string; width?: number; height?: number }

export class AttachmentError extends Error { constructor(msg: string) { super(msg); this.name = "AttachmentError"; } }

async function toCanvasJpeg(bitmap: ImageBitmap): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return { blob: await c.convertToBlob({ type: "image/jpeg", quality: QUALITY }), width, height };
  }
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", QUALITY));
  return { blob, width, height };
}

/** Compress an image (bytes + mime). Non-images and undecodable images are returned unchanged. */
export async function prepareBytes(bytes: Uint8Array<ArrayBuffer>, mime: string, name = "attachment"): Promise<Prepared> {
  const isRaster = /^image\/(jpeg|png|webp|bmp|heic|heif|avif)$/i.test(mime);
  if (isRaster && typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: "from-image" });
      const { blob, width, height } = await toCanvasJpeg(bitmap);
      bitmap.close?.();
      const out = new Uint8Array(await blob.arrayBuffer());
      if (out.length < bytes.length || bytes.length > 1_500_000 || !/jpeg/i.test(mime)) {
        return { bytes: out, mime: "image/jpeg", name: name.replace(/\.[^.]+$/, "") + ".jpg", width, height };
      }
      return { bytes, mime, name, width, height };
    } catch { /* fall through: keep original if it's within limits */ }
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError("That file is larger than 10 MB. Attach a smaller file or a photo of it.");
  return { bytes, mime: mime || "application/octet-stream", name };
}

export async function prepareFile(file: File): Promise<Prepared> {
  if (file.size > 40 * 1024 * 1024) throw new AttachmentError("That file is too large to attach.");
  return prepareBytes(new Uint8Array(await file.arrayBuffer()), file.type || "application/octet-stream", file.name || "attachment");
}

export function isImage(mime: string): boolean { return /^image\//i.test(mime); }

export function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
