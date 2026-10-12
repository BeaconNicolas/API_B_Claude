// Reads images and PDFs the user attaches and turns them into base64 for the API.
// Large images are scaled down first: the model sees at most ~1568px on the long edge
// anyway, so this saves tokens, upload time and browser storage.

import type { Attachment } from "./types";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const MAX_IMAGE_EDGE = 1568;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function stripPrefix(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function scaleImage(file: File, type: (typeof IMAGE_TYPES)[number]): Promise<{ blob: Blob; type: Attachment["mediaType"] }> {
  const img = await loadImage(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= MAX_IMAGE_EDGE && file.size <= MAX_IMAGE_BYTES) return { blob: file, type };
  const scale = Math.min(1, MAX_IMAGE_EDGE / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return { blob: file, type };
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const outType = type === "image/png" || type === "image/gif" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outType, 0.9));
  if (!blob) return { blob: file, type };
  return { blob, type: outType };
}

export async function readAttachment(file: File): Promise<Attachment> {
  const id = crypto.randomUUID();
  if ((IMAGE_TYPES as readonly string[]).includes(file.type)) {
    const { blob, type } = await scaleImage(file, file.type as (typeof IMAGE_TYPES)[number]);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is too large (images must be under 5 MB).`);
    return { id, name: file.name || "image", kind: "image", mediaType: type, data: stripPrefix(await readAsDataUrl(blob)), size: blob.size };
  }
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    if (file.size > MAX_PDF_BYTES) throw new Error(`${file.name} is too large (PDFs must be under 20 MB).`);
    return {
      id,
      name: file.name,
      kind: "pdf",
      mediaType: "application/pdf",
      data: stripPrefix(await readAsDataUrl(file)),
      size: file.size,
    };
  }
  throw new Error(`${file.name || "That file"} isn't supported. Attach images (PNG, JPEG, GIF, WebP) or PDFs.`);
}

export function attachmentUrl(a: Attachment): string {
  return `data:${a.mediaType};base64,${a.data}`;
}
