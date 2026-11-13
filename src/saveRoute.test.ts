import { describe, expect, it } from "vitest";

import { newDocument, openDocument } from "./document";
import { routeSavedBlob, type SaveRoute } from "./saveRoute";

const BENZENE = "/home/jorge/Documents/benzene.ket";
const WINDOWS_BENZENE = "C:\\Users\\jorge\\Documents\\benzene.ket";

const DESKTOP = { desktop: true, hasHandler: true };
const BROWSER = { desktop: false, hasHandler: true };
const DESKTOP_WITHOUT_HANDLER = { desktop: true, hasHandler: false };

function documentSave(path: string | null, defaultName: string): SaveRoute {
  return { kind: "document-save", path, defaultName };
}

function exportSave(defaultName: string): SaveRoute {
  return { kind: "export-save", defaultName };
}

function download(defaultName: string): SaveRoute {
  return { kind: "download", defaultName };
}

describe("routeSavedBlob: .ket document save", () => {
  it("writes to the existing path and defaults to its file name", () => {
    expect(routeSavedBlob("ketcher.ket", openDocument(BENZENE), DESKTOP)).toEqual(
      documentSave(BENZENE, "benzene.ket"),
    );
  });

  it("uses the last segment of a Windows path as the default name", () => {
    expect(routeSavedBlob("ketcher.ket", openDocument(WINDOWS_BENZENE), DESKTOP)).toEqual(
      documentSave(WINDOWS_BENZENE, "benzene.ket"),
    );
  });

  it("opens Save As with untitled.ket when the document has no path", () => {
    expect(routeSavedBlob("ketcher.ket", newDocument(), DESKTOP)).toEqual(
      documentSave(null, "untitled.ket"),
    );
  });

  it("treats an uppercase .KET extension as the document format", () => {
    expect(routeSavedBlob("ketcher.KET", openDocument(BENZENE), DESKTOP)).toEqual(
      documentSave(BENZENE, "benzene.ket"),
    );
  });

  it("treats a mixed-case .Ket extension as the document format", () => {
    expect(routeSavedBlob("ketcher.Ket", newDocument(), DESKTOP)).toEqual(
      documentSave(null, "untitled.ket"),
    );
  });
});

describe("routeSavedBlob: non-.ket export save", () => {
  it("routes a molfile to an export save that keeps the supplied name", () => {
    expect(routeSavedBlob("ketcher.mol", openDocument(BENZENE), DESKTOP)).toEqual(
      exportSave("ketcher.mol"),
    );
  });

  it("routes an SVG image to an export save so the document is untouched", () => {
    expect(routeSavedBlob("ketcher.svg", openDocument(BENZENE), DESKTOP)).toEqual(
      exportSave("ketcher.svg"),
    );
  });

  it("routes SMILES to an export save", () => {
    expect(routeSavedBlob("ketcher.smi", newDocument(), DESKTOP)).toEqual(
      exportSave("ketcher.smi"),
    );
  });

  it("routes InChI to an export save", () => {
    expect(routeSavedBlob("ketcher.inchi", newDocument(), DESKTOP)).toEqual(
      exportSave("ketcher.inchi"),
    );
  });

  it("routes a PNG image to an export save", () => {
    expect(routeSavedBlob("ketcher.png", openDocument(BENZENE), DESKTOP)).toEqual(
      exportSave("ketcher.png"),
    );
  });

  it("routes an uppercase .MOL extension to an export save", () => {
    expect(routeSavedBlob("ketcher.MOL", openDocument(BENZENE), DESKTOP)).toEqual(
      exportSave("ketcher.MOL"),
    );
  });

  it("routes a filename without a dot to an export save with that name", () => {
    expect(routeSavedBlob("ketcher", openDocument(BENZENE), DESKTOP)).toEqual(
      exportSave("ketcher"),
    );
  });
});

describe("routeSavedBlob: download fallback", () => {
  it("downloads a .ket blob in the browser even when the document has a path", () => {
    expect(routeSavedBlob("ketcher.ket", openDocument(BENZENE), BROWSER)).toEqual(
      download("benzene.ket"),
    );
  });

  it("downloads a .ket blob in the browser when the document has no path", () => {
    expect(routeSavedBlob("ketcher.ket", newDocument(), BROWSER)).toEqual(download("untitled.ket"));
  });

  it("downloads a .ket blob on desktop when no handler is registered", () => {
    expect(routeSavedBlob("ketcher.ket", openDocument(BENZENE), DESKTOP_WITHOUT_HANDLER)).toEqual(
      download("benzene.ket"),
    );
  });

  it("downloads a .mol blob on desktop when no handler is registered", () => {
    expect(routeSavedBlob("ketcher.mol", openDocument(BENZENE), DESKTOP_WITHOUT_HANDLER)).toEqual(
      download("ketcher.mol"),
    );
  });

  it("downloads an untitled .ket blob on desktop when no handler is registered", () => {
    expect(routeSavedBlob("ketcher.ket", newDocument(), DESKTOP_WITHOUT_HANDLER)).toEqual(
      download("untitled.ket"),
    );
  });

  it("downloads a .svg blob in the browser", () => {
    expect(routeSavedBlob("ketcher.svg", openDocument(BENZENE), BROWSER)).toEqual(
      download("ketcher.svg"),
    );
  });

  it("downloads when the browser has no handler either", () => {
    expect(
      routeSavedBlob("ketcher.ket", newDocument(), { desktop: false, hasHandler: false }),
    ).toEqual(download("untitled.ket"));
  });
});
