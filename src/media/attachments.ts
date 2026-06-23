/**
 * Inbound attachments (images, PDFs) the user sends along with, or instead of, a
 * text message. The Telegram channel downloads the bytes and hands the agent a
 * base64 payload; the agent turns these into content blocks so the model sees the
 * image or document as context. Handy for a coach: meal photos, food labels, a
 * gym machine, or a progress picture.
 */

export interface Attachment {
  /** MIME type, e.g. "image/jpeg" or "application/pdf". */
  mediaType: string;
  /** Base64-encoded bytes (no data: URI prefix). */
  data: string;
}

/** An Anthropic user-message content block (text, image, or PDF document). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

/** Image types Claude accepts as vision input. */
const SUPPORTED_IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** True if a MIME type can be sent to the model as context. */
export function isSupportedAttachment(mediaType: string): boolean {
  return SUPPORTED_IMAGE.has(mediaType) || mediaType === "application/pdf";
}

/** Map one attachment to its content block, or null if the type is unsupported. */
export function attachmentBlock(att: Attachment): ContentBlock | null {
  if (SUPPORTED_IMAGE.has(att.mediaType)) {
    return {
      type: "image",
      source: { type: "base64", media_type: att.mediaType, data: att.data },
    };
  }
  if (att.mediaType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: att.mediaType, data: att.data },
    };
  }
  return null;
}

/**
 * Build the `content` for a user message. Returns a plain string when there are
 * no usable attachments (the common path), or a blocks array combining the text
 * with each image or PDF. Unsupported attachment types are dropped.
 */
export function buildUserContent(
  text: string,
  attachments?: Attachment[],
): string | ContentBlock[] {
  const blocks = (attachments ?? [])
    .map(attachmentBlock)
    .filter((b): b is ContentBlock => b !== null);
  if (blocks.length === 0) return text;

  const content: ContentBlock[] = [];
  if (text.trim()) content.push({ type: "text", text });
  content.push(...blocks);
  return content;
}
