import { describe, expect, it } from "vitest";

import {
  contentHash,
  formatFileSize,
  formatModified,
  previewFileName,
  validationStatus,
} from "./recentDetails";

describe("formatFileSize", () => {
  it("renders zero bytes as 0 B", () => {
    expect(formatFileSize(0)).toBe("0 B");
  });

  it("renders a small byte count without a unit conversion", () => {
    expect(formatFileSize(48)).toBe("48 B");
  });

  it("renders exactly one kibibyte as 1 KB with no trailing .0", () => {
    expect(formatFileSize(1024)).toBe("1 KB");
  });

  it("renders a kilobyte count with one decimal", () => {
    expect(formatFileSize(2100)).toBe("2.1 KB");
  });

  it("renders a megabyte count with one decimal", () => {
    expect(formatFileSize(1_572_864)).toBe("1.5 MB");
  });

  it("renders a gigabyte count with one decimal", () => {
    expect(formatFileSize(1_073_741_824)).toBe("1 GB");
  });
});

describe("formatModified", () => {
  it("renders a timestamp on the current calendar day as Today, HH:MM", () => {
    const now = new Date(2024, 9, 24, 18, 0).getTime();
    const mtime = new Date(2024, 9, 24, 15, 30).getTime();

    expect(formatModified(mtime, now)).toBe("Today, 15:30");
  });

  it("renders the previous calendar day as Yesterday", () => {
    const now = new Date(2024, 9, 24, 18, 0).getTime();
    const mtime = new Date(2024, 9, 23, 9, 5).getTime();

    expect(formatModified(mtime, now)).toBe("Yesterday");
  });

  it("renders an older timestamp as Mon D, YYYY in en-US", () => {
    const now = new Date(2026, 10, 19, 12, 0).getTime();
    const mtime = new Date(2024, 9, 24, 15, 30).getTime();

    expect(formatModified(mtime, now)).toBe("Oct 24, 2024");
  });

  it("renders a future timestamp as an em dash instead of a date", () => {
    const now = new Date(2024, 9, 24, 18, 0).getTime();
    const mtime = new Date(2024, 9, 25, 9, 0).getTime();

    expect(formatModified(mtime, now)).toBe("—");
  });

  it("renders an invalid timestamp as an em dash", () => {
    const now = new Date(2024, 9, 24, 18, 0).getTime();

    expect(formatModified(Number.NaN, now)).toBe("—");
  });
});

describe("validationStatus", () => {
  it("maps an empty result object to valid — nothing to report is a pass", () => {
    expect(validationStatus({})).toBe("valid");
  });

  it("maps an object whose issue arrays are all empty to valid", () => {
    expect(validationStatus({ valence: [] })).toBe("valid");
  });

  it("maps an empty array to valid — an empty finding list is a pass", () => {
    expect(validationStatus([])).toBe("valid");
  });

  it("maps a non-empty issue array to warnings", () => {
    expect(validationStatus({ valence: ["..."], stereo: [] })).toBe("warnings");
  });

  it("maps a result carrying an error to invalid", () => {
    expect(validationStatus({ error: "..." })).toBe("invalid");
  });

  it("maps null to unknown — a missing result is never a pass", () => {
    expect(validationStatus(null)).toBe("unknown");
  });

  it("maps undefined to unknown — a missing result is never a pass", () => {
    expect(validationStatus(undefined)).toBe("unknown");
  });

  it("maps a non-object value to unknown", () => {
    expect(validationStatus("boom")).toBe("unknown");
  });
});

describe("previewFileName", () => {
  it("appends the .svg extension to the content hash", () => {
    expect(previewFileName("abc")).toBe("abc.svg");
  });
});

describe("contentHash", () => {
  it("hashes the text as lower-case hex SHA-256", async () => {
    await expect(contentHash("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
