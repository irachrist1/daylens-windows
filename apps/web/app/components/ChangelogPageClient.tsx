"use client";

import { useMemo, useState } from "react";
import { generatedChangelogData } from "../changelog/generatedChangelogData";
import { MarketingFooter, MarketingInnerNav } from "./MarketingChrome";

type SurfaceRecord = (typeof generatedChangelogData.surfaces)[number];
type SurfaceId = SurfaceRecord["id"];
type ReleaseRecord = SurfaceRecord["releases"][number];

const PLATFORM_ORDER: SurfaceId[] = ["mac", "windows", "linux", "web"];

const SURFACE_LABELS: Record<SurfaceId, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
  web: "Website",
};

const SURFACE_PANEL_LABELS: Record<SurfaceId, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
  web: "Website",
};

function formatDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function displayTitle(value: string) {
  const compact = value.split(/[—:,.]/)[0].trim();
  if (compact.length > 68) {
    return compact.split(/\s+/).slice(0, 7).join(" ");
  }
  return compact || value;
}

function cardTitle(value: string) {
  const compact = value.split(/[—:,.]/)[0].trim();
  return compact.split(/\s+/).slice(0, 4).join(" ");
}

function cleanParagraph(value: string) {
  return value.replace(/\.\.+$/g, ".").replace(/\s+/g, " ").trim();
}

function SurfaceIcon({
  surface,
  className,
}: {
  surface: SurfaceId;
  className?: string;
}) {
  if (surface === "mac") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
        <path
          fill="currentColor"
          d="M12.367 8.5c.022 2.422 2.124 3.227 2.147 3.238-.018.056-.336 1.148-1.107 2.275-.667.975-1.36 1.946-2.45 1.966-1.07.02-1.415-.635-2.64-.635s-1.607.615-2.621.655c-1.053.04-1.854-1.054-2.527-2.025C1.795 11.987.745 8.36 2.155 5.912c.7-1.215 1.952-1.985 3.31-2.005 1.034-.02 2.01.695 2.641.695.632 0 1.817-.86 3.063-.733.522.021 1.986.21 2.927 1.587-.076.047-1.747 1.02-1.73 3.044Zm-2.014-5.945c.559-.677.935-1.618.833-2.555-.806.032-1.78.537-2.357 1.213-.518.598-.971 1.556-.85 2.474.899.07 1.816-.456 2.374-1.132Z"
        />
      </svg>
    );
  }

  if (surface === "windows") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M0 0h7.584v7.584H0zm8.416 0h7.583v7.584H8.416zm-.832 8.416H0V16h7.584zm.832 0h7.583V16H8.416z"
          clipRule="evenodd"
        />
      </svg>
    );
  }

  if (surface === "linux") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
        <path
          fill="currentColor"
          d="M2.5 3.5A1.5 1.5 0 0 1 4 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 12 14H4A1.5 1.5 0 0 1 2.5 12.5v-9ZM4 3.5v9h8v-9H4Zm1.11 2.15 1.74 1.6-1.74 1.6.8.85 2.67-2.45-2.67-2.45-.8.85Zm4.14 3.2h2.15v-1.1H9.25v1.1Z"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm4.824 5.75H10.49a14.4 14.4 0 0 0-.77-3.197A5.03 5.03 0 0 1 12.824 7.25ZM8 3.01c.52.699.972 1.988 1.16 3.24H6.84C7.029 4.998 7.48 3.71 8 3.01ZM6.28 4.053a14.4 14.4 0 0 0-.77 3.197H3.176A5.03 5.03 0 0 1 6.28 4.053ZM3.01 8.75h2.333c.057 1.15.33 2.274.79 3.197A5.03 5.03 0 0 1 3.01 8.75Zm3.83 0h2.32c-.189 1.252-.64 2.54-1.16 3.24-.52-.699-.971-1.988-1.16-3.24Zm2.88 3.197c.46-.923.733-2.047.79-3.197h2.333a5.03 5.03 0 0 1-3.104 3.197Z"
      />
    </svg>
  );
}

export function ChangelogPageClient() {
  const [activeSurface, setActiveSurface] = useState<SurfaceId>("mac");

  const surface = useMemo(
    () =>
      generatedChangelogData.surfaces.find((item) => item.id === activeSurface) ??
      generatedChangelogData.surfaces[0],
    [activeSurface]
  );

  const releases = surface.releases as readonly ReleaseRecord[];

  return (
    <div className="lp lp-ray-changelog-page v2-public-page v2-changelog-page">
      <MarketingInnerNav current="changelog" theme="light" variant="capsule" />

      <main className="lp-ray-changelog-main">
        <section className="lp-container lp-ray-changelog-shell" aria-labelledby="changelog-title">
          <header className="lp-ray-changelog-header">
            <h1 id="changelog-title" className="lp-ray-changelog-title">
              Changelog
            </h1>
            <p className="lp-ray-board-note">
              These notes separate work that is confidently real today from work that is
              implemented but still waiting on broader human or platform validation.
            </p>

            <div
              className="lp-ray-platform-switch"
              role="tablist"
              aria-label="Select product surface"
            >
              {PLATFORM_ORDER.map((surfaceId) => {
                const item = generatedChangelogData.surfaces.find(
                  (candidate) => candidate.id === surfaceId
                );
                if (!item) return null;

                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={activeSurface === item.id}
                    className={`lp-ray-platform-pill${
                      activeSurface === item.id ? " is-active" : ""
                    }`}
                    onClick={() => setActiveSurface(item.id)}
                  >
                    <SurfaceIcon surface={item.id} className="lp-ray-platform-icon" />
                    <span>{SURFACE_LABELS[item.id]}</span>
                  </button>
                );
              })}
            </div>
          </header>

          <div className="lp-ray-release-stream">
            {releases.map((release, index) => (
              <article
                key={release.id}
                className={`lp-ray-release-entry${
                  index === 0 ? " is-first" : ""
                }`}
                id={release.id}
              >
                <aside className="lp-ray-release-meta">
                  <a href={`#${release.id}`} className="lp-ray-release-version">
                    v{release.version}
                  </a>
                  <time className="lp-ray-release-date" dateTime={release.date}>
                    {formatDate(release.date)}
                  </time>
                </aside>

                <div className="lp-ray-release-body">
                  <h2 className="lp-ray-release-title">{displayTitle(release.title)}</h2>

                  <div className={`lp-ray-release-media is-${surface.id}`}>
                    <div className="lp-ray-release-glow" />
                    <div className="lp-ray-release-panel">
                      <SurfaceIcon surface={surface.id} className="lp-ray-release-panel-icon" />
                      <span className="lp-ray-release-panel-kicker">
                        {SURFACE_PANEL_LABELS[surface.id]}
                      </span>
                      <strong className="lp-ray-release-panel-title">
                        {cardTitle(release.title)}
                      </strong>
                      <span className="lp-ray-release-panel-version">v{release.version}</span>
                    </div>
                    <div className="lp-ray-release-strips" aria-hidden="true">
                      <span />
                      <span />
                    </div>
                  </div>

                  <div className="lp-ray-release-copy">
                    {release.intro.map((paragraph) => (
                      <p key={`${release.id}-${paragraph}`}>{cleanParagraph(paragraph)}</p>
                    ))}
                  </div>

                  {release.sections.map((section) => (
                    <section
                      key={`${release.id}-${section.label}`}
                      className="lp-ray-release-section"
                    >
                      <h3 className="lp-ray-release-section-title">{section.label}</h3>
                      <ul className="lp-ray-release-list">
                        {section.items.map((item) => (
                          <li key={`${release.id}-${section.label}-${item}`}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  ))}

                </div>
              </article>
            ))}
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
