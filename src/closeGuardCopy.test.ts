import { describe, expect, it } from "vitest";

import { closeGuardCopy, type CloseGuardCopy } from "./closeGuardCopy";

const FORBIDDEN_COPY = ["not possible", "on screen", "saving them all"];

function allCopies(): CloseGuardCopy[] {
  return [
    closeGuardCopy({ documentName: "benzene", dirtyCount: 3, allowSave: true }),
    closeGuardCopy({ documentName: "benzene", dirtyCount: 1, allowSave: false }),
    closeGuardCopy({ documentName: "benzene", dirtyCount: 1, allowSave: true }),
  ];
}

describe("closeGuardCopy", () => {
  it("offers discard or cancel, with the dirty count, when several documents are dirty", () => {
    expect(closeGuardCopy({ documentName: "benzene", dirtyCount: 3, allowSave: true })).toEqual({
      title: "Unsaved changes",
      lines: ["3 documents have unsaved changes.", "Are you sure you want to discard them?"],
      actions: ["discard", "cancel"],
    });
  });

  it("offers discard or cancel, with the document name, when the only dirty document cannot be saved", () => {
    expect(closeGuardCopy({ documentName: "benzene", dirtyCount: 1, allowSave: false })).toEqual({
      title: "Unsaved changes",
      lines: ["benzene has unsaved changes.", "Are you sure you want to discard them?"],
      actions: ["discard", "cancel"],
    });
  });

  it("offers save, discard or cancel when the only dirty document can be saved", () => {
    expect(closeGuardCopy({ documentName: "benzene", dirtyCount: 1, allowSave: true })).toEqual({
      title: "Save changes?",
      lines: ["benzene has unsaved changes.", "Do you want to save them before closing?"],
      actions: ["save", "discard", "cancel"],
    });
  });

  it("substitutes the document name instead of a placeholder", () => {
    const untitled = closeGuardCopy({ documentName: "Untitled", dirtyCount: 1, allowSave: true });
    const aspirin = closeGuardCopy({ documentName: "aspirin", dirtyCount: 1, allowSave: false });

    expect(untitled.lines[0]).toBe("Untitled has unsaved changes.");
    expect(aspirin.lines[0]).toBe("aspirin has unsaved changes.");
  });

  it("keeps implementation language out of every copy", () => {
    for (const copy of allCopies()) {
      const text = `${copy.title}\n${copy.lines.join("\n")}`.toLowerCase();

      for (const phrase of FORBIDDEN_COPY) {
        expect(text).not.toContain(phrase);
      }
    }
  });
});
