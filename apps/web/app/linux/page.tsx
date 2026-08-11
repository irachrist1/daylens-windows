import Link from "next/link";
import { MarketingFooter, MarketingInnerNav } from "../components/MarketingChrome";
import { MarketingCursor } from "../components/MarketingEffects";
import {
  MAC_DOWNLOAD_HREF,
  WINDOWS_DOWNLOAD_HREF,
} from "../lib/platformLinks";

export const metadata = {
  title: "Linux Status — Daylens",
  description:
    "Daylens is being built as one cross-platform product for macOS, Windows, and Linux. Public Linux installer routing is still catching up.",
};

export default function LinuxStatusPage() {
  return (
    <div className="lp">
      <MarketingCursor />
      <MarketingInnerNav current="home" theme="light" variant="capsule" />

      <section className="lp-docs-hero">
        <div className="lp-container" style={{ position: "relative", zIndex: 1 }}>
          <div className="lp-accent-rule" style={{ marginBottom: "1.5rem" }} />
          <p className="text-label" style={{ color: "var(--lp-accent)", marginBottom: "1rem" }}>
            Linux status
          </p>
          <h1 className="text-display-lg" style={{ color: "var(--lp-bone)", margin: "0 0 1rem", maxWidth: "16ch" }}>
            Linux is part of the Daylens direction.
          </h1>
          <p
            style={{
              fontSize: "1rem",
              fontWeight: 400,
              lineHeight: 1.65,
              color: "rgba(10,22,40,0.5)",
              margin: 0,
              maxWidth: "46ch",
            }}
          >
            Daylens is being built as one local-first, evidence-grounded product across macOS,
            Windows, and Linux. Public Linux installer routing is still catching up, so this site
            does not offer a direct Linux download today.
          </p>
        </div>
      </section>

      <section className="lp-section lp-section--light">
        <div className="lp-container" style={{ maxWidth: 920 }}>
          <div
            className="glass-card"
            style={{
              padding: "1.5rem",
              borderRadius: "1.5rem",
              background: "rgba(255,255,255,0.72)",
              border: "1px solid rgba(15, 42, 74, 0.08)",
              boxShadow: "0 20px 60px rgba(15, 42, 74, 0.08)",
            }}
          >
            <h2 className="text-headline" style={{ margin: "0 0 0.75rem", color: "var(--lp-ink)" }}>
              What is true right now
            </h2>
            <div className="lp-docs-bullets" style={{ marginBottom: "1.25rem" }}>
              <p className="lp-docs-body" style={{ margin: 0 }}>
                Daylens is one cross-platform desktop product for macOS, Windows, and Linux.
              </p>
              <p className="lp-docs-body" style={{ margin: 0 }}>
                Linux runtime and packaging work still need real-machine validation across X11 and
                Wayland sessions before the install path should be called fully ready.
              </p>
              <p className="lp-docs-body" style={{ margin: 0 }}>
                macOS and Windows installs are still the direct download paths surfaced on this
                site today.
              </p>
            </div>

            <p className="lp-docs-body" style={{ marginBottom: "0.75rem" }}>
              Need a Daylens install right now?
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <a href={MAC_DOWNLOAD_HREF} className="lp-btn-ghost-dark">
                Download for Mac
              </a>
              <a href={WINDOWS_DOWNLOAD_HREF} className="lp-btn-ghost-dark">
                Download for Windows
              </a>
              <Link href="/docs" className="lp-btn-ghost-dark">
                Read the docs
              </Link>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
