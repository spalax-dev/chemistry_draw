/**
 * Backstage → About: real version and environment values only
 * (`docs/architecture.md` §5.11.2, `docs/conventions.md` §6.8).
 *
 * The app, Ketcher and React versions come from `package.json` at build time;
 * Indigo and the sidecar port come from `GET /v2/info` through `App`; platform
 * and runtime come from the webview. A source that has not answered shows
 * `Unavailable` instead of a placeholder.
 */

import type { CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import packageJson from "../../../package.json";
import { declaredVersion } from "../../backstage";
import { tokens } from "../tokens";
import { CARD, ROW, ROW_DIVIDER, ROW_META, SECTION_LEAD, SECTION_TITLE } from "./sectionStyles";

export interface AboutSectionProps {
  /** `package.json.version`, read at build time; Tauri `getVersion()` is not used. */
  appVersion: string;
  /** `indigo_version` from `GET /v2/info`; `null` until the sidecar answers. */
  indigoVersion: string | null;
  /** The actually bound sidecar port from `api_path`; `null` until it answers. */
  indigoPort: number | null;
}

const LICENSE_LINKS = [
  {
    name: "Ketcher",
    license: "Apache-2.0",
    href: "https://github.com/epam/ketcher/blob/master/LICENSE",
  },
  {
    name: "Indigo",
    license: "Apache-2.0",
    href: "https://github.com/epam/Indigo/blob/master/LICENSE",
  },
  {
    name: "ONNX Runtime",
    license: "MIT",
    href: "https://github.com/microsoft/onnxruntime/blob/main/LICENSE",
  },
] as const;

const LINK: CSSProperties = {
  color: tokens.color.accent,
  textDecoration: "underline",
  outlineColor: tokens.color.accent,
  outlineOffset: 2,
};

const VALUE: CSSProperties = {
  flex: "0 0 auto",
  maxWidth: "55%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "right",
  color: tokens.color.text,
};

const LICENSE_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 12,
  flexWrap: "wrap",
};

/** A license opens in the system browser in Tauri and in a tab in the browser. */
function LicenseLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={LINK}
      onClick={(event) => {
        if (!isTauri()) return;
        event.preventDefault();
        void openUrl(href).catch((error) =>
          console.warn("[chemistry-draw] could not open the license page:", error),
        );
      }}
    >
      {children}
    </a>
  );
}

function platformLabel(): string {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = (data?.platform ?? navigator.platform).trim();
  return platform.length > 0 ? platform : navigator.userAgent;
}

interface AboutRow {
  label: string;
  value: string;
}

export function AboutSection({ appVersion, indigoVersion, indigoPort }: AboutSectionProps) {
  const rows: AboutRow[] = [
    { label: "Chemistry Draw", value: appVersion },
    { label: "Ketcher", value: declaredVersion(packageJson.dependencies["ketcher-react"]) },
    { label: "React", value: declaredVersion(packageJson.dependencies.react) },
    { label: "Indigo", value: indigoVersion ?? "Unavailable" },
    { label: "Sidecar port", value: indigoPort === null ? "Unavailable" : `:${indigoPort}` },
    { label: "Platform", value: platformLabel() },
    { label: "Runtime", value: isTauri() ? "Desktop (Tauri)" : "Browser" },
  ];

  return (
    <section aria-labelledby="backstage-about-title">
      <h2 id="backstage-about-title" style={SECTION_TITLE}>
        About
      </h2>
      <p style={SECTION_LEAD}>Chemistry Draw and the open-source components it builds on.</p>

      <ul style={CARD}>
        {rows.map((row, index) => (
          <li key={row.label} style={index === 0 ? ROW : { ...ROW, borderTop: ROW_DIVIDER }}>
            <span style={{ ...ROW_META, flex: "1 1 auto" }}>{row.label}</span>
            <span style={VALUE} title={row.value}>
              {row.value}
            </span>
          </li>
        ))}
        <li style={{ ...ROW, borderTop: ROW_DIVIDER }}>
          <span style={{ ...ROW_META, flex: "1 1 auto" }}>Licenses</span>
          <span style={LICENSE_ROW}>
            {LICENSE_LINKS.map((entry) => (
              <LicenseLink key={entry.name} href={entry.href}>
                {`${entry.name} (${entry.license})`}
              </LicenseLink>
            ))}
          </span>
        </li>
      </ul>
    </section>
  );
}
