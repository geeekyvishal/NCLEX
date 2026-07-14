/**
 * PDF upload validation and normalization.
 *
 * These are deliberately pure functions with no Fastify or I/O dependency so
 * the guards that protect LLM cost and object storage (mimetype, extension,
 * size) and the filename-to-title mapping are unit testable in isolation.
 */
import { randomUUID } from "node:crypto";

/** Hard cap on uploaded PDFs. Mirrors the multipart limit set in server.ts. */
export const MAX_PDF_BYTES = 30 * 1024 * 1024;

/**
 * Mimetypes browsers and tools use for PDFs. `application/pdf` is the standard;
 * the others show up from older Windows and Acrobat clients.
 */
export const ALLOWED_PDF_MIMETYPES = [
  "application/pdf",
  "application/x-pdf",
  "application/acrobat",
  "applications/vnd.pdf",
  "text/pdf",
  "text/x-pdf",
] as const;

/** Fallback title when a filename carries no usable text. */
export const DEFAULT_DECK_TITLE = "Untitled deck";

/** Upper bound on a derived deck title so one long filename cannot bloat the UI. */
export const MAX_DECK_TITLE_LENGTH = 120;

/** A validation failure that maps cleanly to an HTTP status code. */
export class UploadValidationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.statusCode = statusCode;
  }
}

/** Normalize a mimetype by dropping any parameters and lowercasing. */
function normalizeMimetype(mimetype: string | null | undefined): string {
  if (!mimetype) {
    return "";
  }
  return mimetype.split(";")[0]!.trim().toLowerCase();
}

/** True when the filename ends in a `.pdf` extension (case insensitive). */
export function hasPdfExtension(filename: string | null | undefined): boolean {
  if (!filename) {
    return false;
  }
  return /\.pdf$/i.test(filename.trim());
}

/** True when the mimetype is one we accept as a PDF. */
export function isAllowedPdfMimetype(mimetype: string | null | undefined): boolean {
  const normalized = normalizeMimetype(mimetype);
  return (ALLOWED_PDF_MIMETYPES as readonly string[]).includes(normalized);
}

/**
 * Derive a human deck title from an uploaded filename.
 *
 * Strips any path prefix and the `.pdf` extension, turns separators into
 * spaces, collapses whitespace, and truncates. Returns a stable fallback when
 * nothing usable remains so a deck always has a title.
 */
export function titleFromFilename(filename: string | null | undefined): string {
  if (!filename) {
    return DEFAULT_DECK_TITLE;
  }

  const base = filename.split(/[/\\]/).pop() ?? filename;
  const withoutExtension = base.replace(/\.pdf$/i, "");
  const cleaned = withoutExtension
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return DEFAULT_DECK_TITLE;
  }

  if (cleaned.length <= MAX_DECK_TITLE_LENGTH) {
    return cleaned;
  }

  return cleaned.slice(0, MAX_DECK_TITLE_LENGTH).trim();
}

export interface PdfUploadCandidate {
  filename?: string | null;
  mimetype?: string | null;
}

export interface ValidatedPdfUpload {
  filename: string;
  mimetype: string;
}

/**
 * Validate the metadata of an upload before we spend I/O reading its bytes.
 * Throws {@link UploadValidationError} with a client-safe message on failure.
 */
export function validatePdfUploadMetadata(candidate: PdfUploadCandidate): ValidatedPdfUpload {
  const filename = (candidate.filename ?? "").trim();
  if (!filename) {
    throw new UploadValidationError("A PDF file is required.");
  }
  if (!hasPdfExtension(filename)) {
    throw new UploadValidationError("Only .pdf files are supported.");
  }
  if (!isAllowedPdfMimetype(candidate.mimetype)) {
    throw new UploadValidationError("The uploaded file must be a PDF.");
  }

  return { filename, mimetype: normalizeMimetype(candidate.mimetype) };
}

/** Validate the size of the buffer once it has been read. */
export function assertPdfSizeWithinLimit(byteLength: number): void {
  if (byteLength <= 0) {
    throw new UploadValidationError("The uploaded PDF is empty.");
  }
  if (byteLength > MAX_PDF_BYTES) {
    throw new UploadValidationError(
      `The PDF exceeds the ${Math.floor(MAX_PDF_BYTES / (1024 * 1024))}MB limit.`,
      413,
    );
  }
}

/**
 * Build the object-storage key for a source PDF. Scoped by user so listings
 * and lifecycle purges can be reasoned about per owner, and randomized so two
 * uploads of the same filename never collide.
 */
export function buildSourceStorageKey(userId: string): string {
  return `sources/${userId}/${randomUUID()}.pdf`;
}
