"use client";

import Link from "next/link";
import posthog from "posthog-js";
import { type ReactNode, useRef } from "react";
import { MarketingFooter, MarketingInnerNav } from "./MarketingChrome";
import { usePanelStacking } from "./MarketingEffects";
import { assetPath } from "../lib/basePath";
import {
  LINUX_STATUS_HREF,
  MAC_DOWNLOAD_HREF,
  WINDOWS_DOWNLOAD_HREF,
} from "../lib/platformLinks";

type ToolChipRecord = {
  label: string;
  src: string;
  rounded?: boolean;
};

const toolChips: ToolChipRecord[] = [
  { label: "VS Code", src: assetPath("/brands/vscode.ico"), rounded: true },
  { label: "Claude Code", src: assetPath("/brands/claude-app.png"), rounded: true },
  { label: "ChatGPT", src: assetPath("/brands/chatgpt.png"), rounded: true },
  { label: "Dia", src: assetPath("/brands/dia.png"), rounded: true },
  { label: "Arc", src: assetPath("/brands/arc.svg") },
  { label: "Chrome", src: assetPath("/brands/chrome.svg") },
  { label: "Spotify", src: assetPath("/brands/spotify.svg") },
  { label: "Figma", src: assetPath("/brands/figma.svg") },
  { label: "Slack", src: assetPath("/brands/slack.png"), rounded: true },
  { label: "Notion", src: assetPath("/brands/notion.svg") },
  { label: "Linear", src: assetPath("/brands/linear.svg") },
];

const marqueeTools = [...toolChips, ...toolChips];

const faqItems = [
  {
    question: "How does Daylens know what I'm working on?",
    answer:
      "It watches frontmost windows, file paths, browser tabs, and calendar events — passively, in the background. No clicks logged. No screenshots taken.",
  },
  {
    question: "Where does my data live?",
    answer:
      "In a single SQLite file on your laptop. You can read it, back it up, move it, or delete it. Optional cloud sync is opt-in.",
  },
  {
    question: "What can I actually ask?",
    answer:
      "Anything you'd ask yourself. When you were last in a file. How long Client X took this week. Which days had real focus. What supported a meeting.",
  },
  {
    question: "What about Linux?",
    answer:
      "macOS and Windows have public downloads today. Linux builds exist; we're validating across distros before listing a public download.",
  },
];

type DownloadButtonProps = {
  href: string;
  label: string;
  platform: "mac" | "windows" | "linux";
  icon: ReactNode;
  variant?: "primary" | "secondary";
  source?: string;
};

function AppleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.36-1.09-.46-2.08-.48-3.22 0-1.43.62-2.18.44-3.04-.36C2.82 15.22 3.54 7.59 9.09 7.31c1.35.07 2.3.74 3.09.8 1.18-.24 2.3-.93 3.56-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.3 2.98-2.57 4.08ZM12.09 7.27c-.15-2.23 1.66-4.07 3.75-4.27.29 2.58-2.07 4.52-3.75 4.27Z" />
    </svg>
  );
}

function WindowsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M0 2.357L6.545 1.5v6H0V2.357zM7.273 1.393L16 0v7.5H7.273V1.393zM0 8.5h6.545v6L0 13.643V8.5zM7.273 8.5H16V16l-8.727-1.393V8.5z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8h9M8.5 4l4 4-4 4" />
    </svg>
  );
}

function DownloadButton({
  href,
  label,
  platform,
  icon,
  variant = "primary",
  source,
}: DownloadButtonProps) {
  return (
    <a
      href={href}
      className={`dlx-btn dlx-btn--${variant}`}
      onClick={() =>
        posthog.capture("download_clicked", {
          platform,
          ...(source ? { source } : {}),
        })
      }
    >
      <span className="dlx-btn__icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </a>
  );
}

function ToolChip({ label, src, rounded = false }: ToolChipRecord) {
  return (
    <li className="dlx-tool-chip">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className={`dlx-tool-chip__logo${rounded ? " is-rounded" : ""}`}
        width={20}
        height={20}
        loading="lazy"
        decoding="async"
      />
      <span>{label}</span>
    </li>
  );
}

/* ---------- CSS-built UI mocks (no screenshots) ---------- */

function ChatMock() {
  return (
    <div className="dlx-mock dlx-mock--chat" aria-hidden="true">
      <div className="dlx-mock__chrome">
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__chrome-title">Daylens · Ask</span>
      </div>
      <div className="dlx-mock__body">
        <div className="dlx-chat__bubble dlx-chat__bubble--q">
          How much time on Client X this week?
        </div>
        <div className="dlx-chat__bubble dlx-chat__bubble--a">
          <strong>6h 08m</strong> across Mon, Tue, and Wed.
          <div className="dlx-chat__evidence">
            <span>14 sessions</span>
            <span>·</span>
            <span>3 files</span>
            <span>·</span>
            <span>2 meetings</span>
          </div>
        </div>
        <div className="dlx-chat__input">
          <span className="dlx-chat__input-cursor" />
          <span className="dlx-chat__input-placeholder">Ask your timeline…</span>
        </div>
      </div>
    </div>
  );
}

function TimelineMock() {
  const blocks = [
    { time: "9:10", title: "Codex loop", app: "Claude Code", w: 78, tone: "accent" },
    { time: "10:42", title: "Pricing draft", app: "Notion", w: 54, tone: "neutral" },
    { time: "11:30", title: "Standup", app: "Calendar", w: 22, tone: "soft" },
    { time: "12:05", title: "Auth migration", app: "VS Code", w: 88, tone: "accent" },
    { time: "14:20", title: "Client review", app: "Figma", w: 46, tone: "neutral" },
  ];
  return (
    <div className="dlx-mock dlx-mock--timeline" aria-hidden="true">
      <div className="dlx-mock__chrome">
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__chrome-title">Today · Friday</span>
      </div>
      <div className="dlx-mock__body">
        <ul className="dlx-tl">
          {blocks.map((b) => (
            <li key={b.time} className="dlx-tl__row">
              <span className="dlx-tl__time">{b.time}</span>
              <span
                className={`dlx-tl__bar dlx-tl__bar--${b.tone}`}
                style={{ width: `${b.w}%` }}
              >
                <span className="dlx-tl__bar-title">{b.title}</span>
                <span className="dlx-tl__bar-app">{b.app}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RecapMock() {
  return (
    <div className="dlx-mock dlx-mock--recap" aria-hidden="true">
      <div className="dlx-mock__chrome">
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__dot" />
        <span className="dlx-mock__chrome-title">Daily recap · Apr 17</span>
      </div>
      <div className="dlx-mock__body dlx-recap">
        <div className="dlx-recap__stats">
          <div className="dlx-recap__stat">
            <span>Tracked</span>
            <strong>9h 35m</strong>
          </div>
          <div className="dlx-recap__stat">
            <span>Focus</span>
            <strong>92%</strong>
          </div>
        </div>
        <div className="dlx-recap__group">
          <p className="dlx-recap__label">Main blocks</p>
          <div className="dlx-recap__row">
            <span>Client X research</span>
            <strong>2h 14m</strong>
          </div>
          <div className="dlx-recap__row">
            <span>Pricing &amp; proposal</span>
            <strong>1h 38m</strong>
          </div>
          <div className="dlx-recap__row">
            <span>Editorial review</span>
            <strong>1h 12m</strong>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingClient() {
  const rootRef = useRef<HTMLDivElement>(null);

  usePanelStacking(rootRef);

  return (
    <div className="dlx" ref={rootRef}>
      <MarketingInnerNav current="home" variant="capsule" landing />

      <main className="dlx-stack">
        {/* PANEL 1 — HERO */}
        <section className="dlx-panel dlx-panel--hero" data-panel="hero">
          <div className="dlx-panel__bg" aria-hidden="true" />
          <div className="dlx-shell dlx-panel__inner dlx-panel__inner--hero">
            <h1 className="dlx-h1">Your workday, on the record.</h1>
            <p className="dlx-lede">
              Daylens watches your apps, files, tabs, and meetings — locally — and turns
              every minute into a searchable timeline you can ask anything.
            </p>
            <div className="dlx-hero__actions">
              <DownloadButton
                href={MAC_DOWNLOAD_HREF}
                label="Download for Mac"
                platform="mac"
                icon={<AppleIcon />}
              />
              <DownloadButton
                href={WINDOWS_DOWNLOAD_HREF}
                label="Download for Windows"
                platform="windows"
                icon={<WindowsIcon />}
                variant="secondary"
              />
            </div>

            <div className="dlx-hero-proof">
              <div className="dlx-hero-proof__frame">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={assetPath("/landing/daylens-desktop-dark.png")}
                  alt="Daylens desktop timeline with reconstructed work sessions and a daily summary"
                  className="dlx-hero-proof__image"
                  loading="eager"
                  decoding="async"
                />
              </div>
            </div>

          </div>

          <div className="dlx-tools-mini" aria-label="Tools Daylens watches">
            <div className="dlx-tools__marquee">
              <ul className="dlx-tool-track">
                {marqueeTools.map((tool, index) => (
                  <ToolChip key={`${tool.label}-${index}`} {...tool} />
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* PANEL 2 — SEARCH */}
        <section className="dlx-panel dlx-panel--white" id="search">
          <div className="dlx-shell dlx-panel__inner">
            <div className="dlx-split">
              <div className="dlx-split__copy">
                <h2 className="dlx-h2">Your work history, queryable.</h2>
                <p className="dlx-lede">
                  Stop guessing where the day went. Ask Daylens in plain language and
                  it answers from real evidence — not vibes.
                </p>
              </div>
              <div className="dlx-split__media">
                <ChatMock />
              </div>
            </div>
          </div>
        </section>

        {/* PANEL 3 — TIMELINE */}
        <section className="dlx-panel dlx-panel--surface" id="timeline">
          <div className="dlx-shell dlx-panel__inner">
            <div className="dlx-split dlx-split--reverse">
              <div className="dlx-split__media">
                <TimelineMock />
              </div>
              <div className="dlx-split__copy">
                <h2 className="dlx-h2">Every session, in order.</h2>
                <p className="dlx-lede">
                  Frontmost windows, file paths, tabs, and meetings — stitched into one
                  continuous timeline of how the day actually went.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* PANEL 4 — RECAP */}
        <section className="dlx-panel dlx-panel--white" id="recap">
          <div className="dlx-shell dlx-panel__inner">
            <div className="dlx-split">
              <div className="dlx-split__copy">
                <h2 className="dlx-h2">Every day ends with a brief.</h2>
                <p className="dlx-lede">
                  A deterministic summary written from your timeline — daily, weekly,
                  monthly. Exportable to anywhere you already journal.
                </p>
              </div>
              <div className="dlx-split__media">
                <RecapMock />
              </div>
            </div>
          </div>
        </section>

        {/* PANEL 5 — LOCAL-FIRST */}
        <section className="dlx-panel dlx-panel--surface" id="local">
          <div className="dlx-shell dlx-panel__inner">
            <div className="dlx-panel__head">
              <h2 className="dlx-h2 dlx-h2--center">Your day stays on your laptop.</h2>
              <p className="dlx-lede dlx-lede--center">
                One file. No telemetry. No vendor lock-in.
              </p>
            </div>

            <div className="dlx-bento">
              <article className="dlx-bento__cell dlx-bento__cell--wide">
                <div className="dlx-bento__head">
                  <h3>One file you can copy, back up, or delete.</h3>
                  <p>
                    Your entire work history lives in a single, portable SQLite file.
                  </p>
                </div>
                <div className="dlx-bento__file" aria-hidden="true">
                  <div className="dlx-bento__file-row">
                    <span className="dlx-bento__file-icon" />
                    <span className="dlx-bento__file-name">~/Library/Application Support/Daylens/</span>
                  </div>
                  <div className="dlx-bento__file-row dlx-bento__file-row--accent">
                    <span className="dlx-bento__file-icon dlx-bento__file-icon--db" />
                    <span className="dlx-bento__file-name">daylens.sqlite</span>
                    <span className="dlx-bento__file-meta">42 MB</span>
                  </div>
                </div>
              </article>

              <article className="dlx-bento__cell">
                <h3>It doesn&apos;t phone home.</h3>
                <p>No analytics. No usage beacons. The only network call is the one you ask for.</p>
              </article>
            </div>
          </div>
        </section>

        {/* PANEL 6 — FAQ */}
        <section className="dlx-panel dlx-panel--white" id="faq">
          <div className="dlx-shell dlx-panel__inner">
            <div className="dlx-panel__head">
              <h2 className="dlx-h2 dlx-h2--center">Common questions.</h2>
            </div>

            <div className="dlx-faq">
              {faqItems.map((item, index) => (
                <details key={item.question} className="dlx-faq__item">
                  <summary className="dlx-faq__question">
                    <span className="dlx-faq__index">0{index + 1}</span>
                    <span className="dlx-faq__q-text">{item.question}</span>
                    <span className="dlx-faq__chev" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 6.5l4 4 4-4" />
                      </svg>
                    </span>
                  </summary>
                  <p className="dlx-faq__answer">{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* PANEL 7 — FINAL CTA + FOOTER */}
        <section className="dlx-panel dlx-panel--dark dlx-panel--final">
          <div className="dlx-panel__bg" aria-hidden="true" />
          <div className="dlx-shell dlx-panel__inner dlx-panel__inner--center">
            <h2 className="dlx-h2 dlx-h2--center dlx-h2--light">
              Stop reconstructing your day from memory.
            </h2>
            <p className="dlx-lede dlx-lede--center dlx-lede--light">
              Daylens runs in the background and keeps the receipts. Free for macOS and
              Windows.
            </p>

            <div className="dlx-hero__actions">
              <DownloadButton
                href={MAC_DOWNLOAD_HREF}
                label="Download for Mac"
                platform="mac"
                icon={<AppleIcon />}
                source="final"
              />
              <DownloadButton
                href={WINDOWS_DOWNLOAD_HREF}
                label="Download for Windows"
                platform="windows"
                icon={<WindowsIcon />}
                variant="secondary"
                source="final"
              />
            </div>

            <div className="dlx-final__links">
              <Link href="/docs" className="dlx-text-link">
                Docs <ArrowIcon />
              </Link>
              <Link href="/roadmap" className="dlx-text-link">
                Roadmap <ArrowIcon />
              </Link>
              <a href={LINUX_STATUS_HREF} className="dlx-text-link">
                Linux status <ArrowIcon />
              </a>
            </div>
          </div>

          <div className="dlx-panel__foot">
            <MarketingFooter variant="minimal" />
          </div>
        </section>
      </main>
    </div>
  );
}
