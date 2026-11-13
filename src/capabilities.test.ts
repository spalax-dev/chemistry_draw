import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Tauri's fs plugin matches scope entries against the *absolute* path it is
 * given and expands `$VAR` roots (e.g. `$APPDATA`, `$HOME`) to real
 * directories. A bare `**` is not a root glob: it never matches an absolute
 * path, so every autosave/save scope check would be denied. The scope must
 * therefore list the concrete roots the app writes to: the recovery directory
 * under `$APPDATA` and the documents a user opens from `$HOME`.
 */
const CAPABILITIES_URL = new URL("../src-tauri/capabilities/default.json", import.meta.url);

const FS_PERMISSIONS = [
  "fs:allow-mkdir",
  "fs:allow-rename",
  "fs:allow-remove",
  "fs:allow-stat",
  "fs:allow-exists",
  "fs:allow-read-text-file",
  "fs:allow-write-text-file",
  "fs:allow-read-file",
  "fs:allow-write-file",
];

interface ScopeRule {
  path: string;
}

interface PermissionEntry {
  identifier: string;
  allow?: ScopeRule[];
}

interface Capability {
  identifier: string;
  windows?: string[];
  permissions?: Array<string | PermissionEntry>;
}

function loadCapability(): Capability {
  return JSON.parse(readFileSync(CAPABILITIES_URL, "utf8")) as Capability;
}

function permissionEntries(capability: Capability): PermissionEntry[] {
  return (capability.permissions ?? []).flatMap((permission) =>
    typeof permission === "string" ? [{ identifier: permission }] : [permission],
  );
}

function scopePaths(capability: Capability): string[] {
  return permissionEntries(capability)
    .filter((permission) => permission.identifier === "fs:scope")
    .flatMap((permission) => (permission.allow ?? []).map((rule) => rule.path));
}

describe("default capability", () => {
  it("is valid JSON and targets the main window", () => {
    const capability = loadCapability();

    expect(typeof capability.identifier).toBe("string");
    expect(capability.identifier).toBe("default");
    expect(capability.windows).toContain("main");
  });

  it("grants the fs permissions autosave and save rely on", () => {
    const granted = permissionEntries(loadCapability()).map((entry) => entry.identifier);

    for (const permission of FS_PERMISSIONS) {
      expect(granted, `missing permission ${permission}`).toContain(permission);
    }
  });

  it("scopes filesystem access to the recovery dir and restored documents", () => {
    const paths = scopePaths(loadCapability());

    expect(paths).toContain("$APPDATA/**");
    expect(paths).toContain("$HOME/**");
  });

  it("does not rely on a bare ** scope that never matches absolute paths", () => {
    const paths = scopePaths(loadCapability());

    expect(paths).not.toContain("**");
  });
});
