import { describe, it, expect } from "vitest";
import {
  hasPdfExtension,
  isAllowedPdfMimetype,
  titleFromFilename,
  validatePdfUploadMetadata,
  assertPdfSizeWithinLimit,
  UploadValidationError,
  MAX_PDF_BYTES,
} from "./upload.js";

describe("hasPdfExtension", () => {
  it("returns true for .pdf extension case-insensitively", () => {
    expect(hasPdfExtension("test.pdf")).toBe(true);
    expect(hasPdfExtension("test.PDF")).toBe(true);
    expect(hasPdfExtension("test.Pdf")).toBe(true);
  });

  it("returns false for non-pdf extensions", () => {
    expect(hasPdfExtension("test.txt")).toBe(false);
    expect(hasPdfExtension("test.pdf.zip")).toBe(false);
    expect(hasPdfExtension(null)).toBe(false);
    expect(hasPdfExtension(undefined)).toBe(false);
    expect(hasPdfExtension("")).toBe(false);
  });
});

describe("isAllowedPdfMimetype", () => {
  it("returns true for allowed PDF mimetypes", () => {
    expect(isAllowedPdfMimetype("application/pdf")).toBe(true);
    expect(isAllowedPdfMimetype("application/x-pdf")).toBe(true);
    expect(isAllowedPdfMimetype("application/pdf; charset=utf-8")).toBe(true);
  });

  it("returns false for disallowed mimetypes", () => {
    expect(isAllowedPdfMimetype("image/png")).toBe(false);
    expect(isAllowedPdfMimetype("text/plain")).toBe(false);
    expect(isAllowedPdfMimetype(null)).toBe(false);
    expect(isAllowedPdfMimetype("")).toBe(false);
  });
});

describe("titleFromFilename", () => {
  it("derives clean titles from filename paths and extensions", () => {
    expect(titleFromFilename("cardiology.pdf")).toBe("cardiology");
    expect(titleFromFilename("/path/to/some-file.pdf")).toBe("some file");
    expect(titleFromFilename("C:\\Windows\\Path\\another_file.pdf")).toBe("another file");
  });

  it("collapses multiple whitespaces", () => {
    expect(titleFromFilename("my   long__spaced_file.pdf")).toBe("my long spaced file");
  });

  it("returns fallback for empty or invalid names", () => {
    expect(titleFromFilename("")).toBe("Untitled deck");
    expect(titleFromFilename(".pdf")).toBe("Untitled deck");
    expect(titleFromFilename(null)).toBe("Untitled deck");
  });

  it("truncates titles if they are too long", () => {
    const longName = "a".repeat(200) + ".pdf";
    const derived = titleFromFilename(longName);
    expect(derived.length).toBe(120);
  });
});

describe("validatePdfUploadMetadata", () => {
  it("passes for valid metadata and returns normalized values", () => {
    const res = validatePdfUploadMetadata({
      filename: "study.pdf",
      mimetype: "application/pdf; charset=utf-8",
    });
    expect(res).toEqual({
      filename: "study.pdf",
      mimetype: "application/pdf",
    });
  });

  it("throws error for missing filename", () => {
    expect(() => {
      validatePdfUploadMetadata({ mimetype: "application/pdf" });
    }).toThrow(UploadValidationError);
  });

  it("throws error for wrong extension", () => {
    expect(() => {
      validatePdfUploadMetadata({ filename: "study.docx", mimetype: "application/pdf" });
    }).toThrow(UploadValidationError);
  });

  it("throws error for wrong mimetype", () => {
    expect(() => {
      validatePdfUploadMetadata({ filename: "study.pdf", mimetype: "image/png" });
    }).toThrow(UploadValidationError);
  });
});

describe("assertPdfSizeWithinLimit", () => {
  it("passes for sizes within limits", () => {
    expect(() => assertPdfSizeWithinLimit(100)).not.toThrow();
    expect(() => assertPdfSizeWithinLimit(MAX_PDF_BYTES)).not.toThrow();
  });

  it("throws error for empty file", () => {
    expect(() => assertPdfSizeWithinLimit(0)).toThrow(UploadValidationError);
  });

  it("throws error for files exceeding max bytes", () => {
    expect(() => assertPdfSizeWithinLimit(MAX_PDF_BYTES + 1)).toThrow(UploadValidationError);
  });
});
