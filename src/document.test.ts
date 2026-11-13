import { describe, expect, it } from "vitest";

import {
  applyExport,
  applySaved,
  closeAfterSave,
  decideCloseGuard,
  documentName,
  documentTitle,
  exportFileName,
  exportRequest,
  markDirty,
  newDocument,
  openDocument,
  saveAsTarget,
  saveRequest,
  saveTarget,
  type DocumentState,
  type ExportFormat,
} from "./document";

const BENZENE = "/home/jorge/Documents/benzene.ket";
const WINDOWS_BENZENE = "C:\\Users\\jorge\\Documents\\benzene.ket";

function dirtyBenzene(): DocumentState {
  return markDirty(openDocument(BENZENE));
}

describe("documentTitle", () => {
  it("shows Untitled for a document without a path", () => {
    expect(documentTitle(newDocument())).toBe("Untitled");
  });

  it("shows the base name without the .ket extension", () => {
    expect(documentTitle(openDocument(BENZENE))).toBe("benzene");
  });

  it("shows the base name for a Windows path", () => {
    expect(documentTitle(openDocument(WINDOWS_BENZENE))).toBe("benzene");
  });

  it("appends a marker only while the document is dirty", () => {
    expect(documentTitle(dirtyBenzene())).toBe("benzene*");
    expect(documentTitle(markDirty(newDocument()))).toBe("Untitled*");
  });

  it("drops the marker after a successful save", () => {
    expect(documentTitle(applySaved(dirtyBenzene(), BENZENE))).toBe("benzene");
  });
});

describe("dirty transitions", () => {
  it("starts clean with no path and the ket format", () => {
    expect(newDocument()).toEqual({ path: null, format: "ket", dirty: false });
  });

  it("sets dirty on the first editor change", () => {
    expect(markDirty(newDocument()).dirty).toBe(true);
    expect(markDirty(dirtyBenzene()).dirty).toBe(true);
  });

  it("clears dirty after a successful save and adopts the target path", () => {
    expect(applySaved(dirtyBenzene(), "/home/jorge/Documents/benzene.ket")).toEqual({
      path: BENZENE,
      format: "ket",
      dirty: false,
    });
  });

  it("clears dirty on open", () => {
    expect(openDocument(BENZENE)).toEqual({ path: BENZENE, format: "ket", dirty: false });
  });

  it("clears dirty and the path on new", () => {
    expect(newDocument()).toEqual({ path: null, format: "ket", dirty: false });
  });
});

describe("document names", () => {
  it("names a document without a path Untitled", () => {
    expect(documentName(null)).toBe("Untitled");
  });

  it("uses the base name without the .ket extension", () => {
    expect(documentName(BENZENE)).toBe("benzene");
    expect(documentName(WINDOWS_BENZENE)).toBe("benzene");
  });

  it("builds export file names from the document base name", () => {
    expect(exportFileName(BENZENE, ".mol")).toBe("benzene.mol");
    expect(exportFileName(WINDOWS_BENZENE, ".svg")).toBe("benzene.svg");
  });

  it("falls back to untitled for an export from an unsaved document", () => {
    expect(exportFileName(null, ".smi")).toBe("untitled.smi");
  });
});

describe("save target", () => {
  it("defaults to untitled.ket when the document has no path", () => {
    expect(saveTarget(newDocument())).toBe("untitled.ket");
  });

  it("reuses the current path", () => {
    expect(saveTarget(openDocument(BENZENE))).toBe(BENZENE);
  });

  it("appends .ket for Save As when the extension is missing", () => {
    expect(saveAsTarget("/home/jorge/Documents/benzene")).toBe(BENZENE);
  });

  it("keeps a .ket extension that is already present", () => {
    expect(saveAsTarget(BENZENE)).toBe(BENZENE);
  });

  it("maps Save to getKet and the .ket format", () => {
    expect(saveRequest(newDocument())).toEqual({
      path: "untitled.ket",
      format: "ket",
      extension: ".ket",
      source: "getKet",
    });
    expect(saveRequest(dirtyBenzene())).toEqual({
      path: BENZENE,
      format: "ket",
      extension: ".ket",
      source: "getKet",
    });
  });
});

describe("export mapping", () => {
  const cases: Array<[ExportFormat, Record<string, unknown>]> = [
    ["v2000", { format: "v2000", source: "getMolfile", argument: "v2000", extension: ".mol" }],
    ["v3000", { format: "v3000", source: "getMolfile", argument: "v3000", extension: ".mol" }],
    ["smiles", { format: "smiles", source: "getSmiles", argument: null, extension: ".smi" }],
    ["inchi", { format: "inchi", source: "getInchi", argument: null, extension: ".inchi" }],
    ["svg", { format: "svg", source: "generateImage", argument: "svg", extension: ".svg" }],
    ["png", { format: "png", source: "generateImage", argument: "png", extension: ".png" }],
  ];

  for (const [format, expected] of cases) {
    it(`maps ${format} to its Ketcher source and file extension`, () => {
      expect(exportRequest(format)).toEqual(expected);
    });
  }

  it("maps every export format to a source other than getKet", () => {
    expect(cases.map(([format]) => exportRequest(format).source)).not.toContain("getKet");
  });

  it("does not change the document path, format or dirty flag", () => {
    const state = dirtyBenzene();
    const { state: exported, request } = applyExport(state, "smiles");

    expect(exported).toEqual({ path: BENZENE, format: "ket", dirty: true });
    expect(request).toEqual(exportRequest("smiles"));
  });

  it("keeps path, format and dirty untouched when exporting an unsaved document", () => {
    const state = markDirty(newDocument());
    const { state: exported } = applyExport(state, "png");

    expect(exported.path).toBeNull();
    expect(exported.format).toBe("ket");
    expect(exported.dirty).toBe(true);
  });
});

describe("close guard", () => {
  it("allows the close when the document is clean", () => {
    expect(decideCloseGuard(newDocument(), null)).toEqual({ action: "close" });
  });

  it("asks for a decision when the document is dirty", () => {
    expect(decideCloseGuard(dirtyBenzene(), null)).toEqual({ action: "prompt" });
  });

  it("stays open on cancel", () => {
    expect(decideCloseGuard(dirtyBenzene(), "cancel")).toEqual({ action: "stay" });
  });

  it("closes without saving on discard", () => {
    expect(decideCloseGuard(dirtyBenzene(), "discard")).toEqual({ action: "discard" });
  });

  it("saves before closing when a path exists", () => {
    expect(decideCloseGuard(dirtyBenzene(), "save")).toEqual({ action: "save" });
  });

  it("runs Save As before closing when the document has no path", () => {
    expect(decideCloseGuard(markDirty(newDocument()), "save")).toEqual({ action: "save-as" });
  });

  it("closes after a successful save", () => {
    expect(closeAfterSave("saved")).toBe("close");
  });

  it("stays open when the save is cancelled", () => {
    expect(closeAfterSave("cancelled")).toBe("stay");
  });

  it("stays open when the save fails", () => {
    expect(closeAfterSave("failed")).toBe("stay");
  });
});
