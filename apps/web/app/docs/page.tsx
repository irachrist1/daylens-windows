import Link from "next/link";
import { MarketingFooter, MarketingInnerNav } from "../components/MarketingChrome";
import { LINUX_STATUS_HREF } from "../lib/platformLinks";

export const metadata = {
  title: "Docs — Daylens",
  description:
    "How Daylens remembers your workday, answers in plain language, and stays private on your laptop.",
};

const TOC = [
  { href: "#getting-started", label: "Getting Started" },
  { href: "#product-status", label: "Product Status" },
  { href: "#timeline", label: "Timeline" },
  { href: "#apps", label: "Apps" },
  { href: "#ai", label: "AI" },
  { href: "#focus", label: "Focus Sessions" },
  { href: "#reports", label: "Reports and Exports" },
  { href: "#sync", label: "Sync and Web Access" },
  { href: "#privacy", label: "Privacy and Data" },
  { href: "#faq", label: "FAQ" },
];

export default function DocsPage() {
  return (
    <div className="lp v2-public-page v2-docs-page">
      <MarketingInnerNav current="docs" theme="light" variant="capsule" />

      <section className="lp-docs-hero">
        <div className="lp-container" style={{ position: "relative", zIndex: 1 }}>
          <div className="lp-accent-rule" style={{ marginBottom: "1.5rem" }} />
          <p className="text-label" style={{ color: "var(--lp-accent)", marginBottom: "1rem" }}>
            Documentation
          </p>
          <h1
            className="text-display-lg"
            style={{ color: "var(--lp-bone)", margin: "0 0 1rem", maxWidth: "18ch" }}
          >
            Everything about Daylens.
          </h1>
          <p
            style={{
              fontSize: "1rem",
              fontWeight: 400,
              lineHeight: 1.65,
              color: "rgba(15,23,42,0.64)",
              margin: 0,
              maxWidth: "44ch",
            }}
          >
            Daylens is a private memory of what you do on your laptop — for you to ask in
            plain language, and for the AI tools you already use. These docs explain what is
            real today and where we stay conservative.
          </p>
        </div>
      </section>

      <section className="lp-section lp-section--light">
        <div className="lp-container">
          <div className="lp-docs-layout">
            <aside className="lp-docs-sidebar">
              <span className="text-label lp-docs-toc-heading">On this page</span>
              {TOC.map(({ href, label }) => (
                <a key={href} href={href} className="lp-docs-toc-link">
                  {label}
                </a>
              ))}
            </aside>

            <article className="lp-docs-content">
              <section id="getting-started" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">Getting Started</h2>
                <p className="lp-docs-body">
                  Daylens is built around four top-level surfaces: Timeline, Apps, AI, and
                  Settings. The desktop app does the real work. The website explains the product,
                  hosts optional access flows, and points to current platform status.
                </p>
                <div className="lp-docs-steps">
                  <div className="lp-docs-step">
                    <span className="text-label lp-docs-step-num">01</span>
                    <div>
                      <p className="lp-docs-step-title">Install the desktop app</p>
                      <p className="lp-docs-step-body">
                        macOS and Windows builds are available from the download links on the home
                        page. Linux is part of the product too, but the public install path still
                        lives on the{" "}
                        <a href={LINUX_STATUS_HREF} className="lp-docs-link">
                          Linux status page
                        </a>{" "}
                        while real-machine validation catches up.
                      </p>
                    </div>
                  </div>
                  <div className="lp-docs-step">
                    <span className="text-label lp-docs-step-num">02</span>
                    <div>
                      <p className="lp-docs-step-title">Let it keep running</p>
                      <p className="lp-docs-step-body">
                        Daylens tracks in the background and stores history locally. The timeline
                        should reconstruct from persisted data after relaunch instead of depending on
                        the current window session.
                      </p>
                    </div>
                  </div>
                  <div className="lp-docs-step">
                    <span className="text-label lp-docs-step-num">03</span>
                    <div>
                      <p className="lp-docs-step-title">Review the proof surface</p>
                      <p className="lp-docs-step-body">
                        Open the Timeline later in the day or revisit an earlier date. If the
                        product is healthy, you should see coherent reconstructed work blocks, gaps,
                        and supporting evidence rather than a blank slate.
                      </p>
                    </div>
                  </div>
                  <div className="lp-docs-step">
                    <span className="text-label lp-docs-step-num">04</span>
                    <div>
                      <p className="lp-docs-step-title">Optionally enable web access</p>
                      <p className="lp-docs-step-body">
                        Settings can create a workspace for optional sync and browser access. That
                        path is additive, not required for the desktop product to be useful.
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <section id="product-status" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">Product Status</h2>
                <p className="lp-docs-body">
                  Daylens is further along than an idea deck and not as finished as a polished
                  launch story would suggest. The right way to read the product today is: the core
                  desktop direction is real, several important features are implemented, and a lot
                  of honest validation still matters.
                </p>
                <ul className="lp-docs-bullets">
                  {[
                    "Daylens is one cross-platform desktop product for macOS, Windows, and Linux.",
                    "macOS install, onboarding, and menu-bar polish are implemented, but the final packaged-app feel still needs human validation.",
                    "A deterministic daily, weekly, and monthly recap now exists inside the AI surface, but it is not yet fully shipped and proven.",
                    "Persistent AI threads, artifacts, focus flows, exports, and several settings refinements are in the product, with many still marked implemented pending verification.",
                    "Linux is part of Daylens, but real-machine validation across X11 and Wayland is still incomplete.",
                    "Provider-backed packaged AI flows are still not fully proven end to end from the current validation environment.",
                  ].map((item) => (
                    <li key={item}>
                      <span className="lp-docs-bullet-dot" />
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="lp-docs-infobox">
                  <span className="lp-docs-infobox-label">Status rule:</span>
                  When code exists but still needs broader validation, the website should say so
                  plainly instead of promoting it as settled product truth.
                </div>
              </section>

              <section id="timeline" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">Timeline</h2>
                <p className="lp-docs-body">
                  The Timeline is the proof surface of Daylens. It is where raw capture gets
                  reconstructed into work blocks that read like real sessions instead of a pile of
                  app totals.
                </p>
                <ul className="lp-docs-bullets">
                  {[
                    "Prior days and weeks should reload from the database after restart.",
                    "Blocks should stay visible even when attribution is weak or incomplete.",
                    "Meetings, active work, and gaps should read as different kinds of time.",
                    "Block detail should expose the artifacts, apps, and evidence behind the label.",
                  ].map((item) => (
                    <li key={item}>
                      <span className="lp-docs-bullet-dot" />
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="lp-docs-infobox">
                  <span className="lp-docs-infobox-label">Note:</span>
                  Daylens is meant to tell the story of the work, not just report that an app was
                  open.
                </div>
              </section>

              <section id="apps" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">Apps</h2>
                <p className="lp-docs-body">
                  The Apps view is secondary to the Timeline. It exists to explain how each tool
                  participated in real work sessions.
                </p>
                <p className="lp-docs-body">
                  A good Apps detail view should answer what you were working on in that app, which
                  files or pages were involved, what other tools commonly appeared alongside it, and
                  when during the day it mattered most.
                </p>
              </section>

              <section id="ai" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">AI</h2>
                <p className="lp-docs-body">
                  The AI surface is how Daylens memory becomes useful in conversation. Ask what you
                  got done, where an afternoon went, or what you were last deep in — and get an
                  answer grounded in the same facts as Timeline and Apps. You can also bring that
                  context into the AI tools you already use when you opt in.
                </p>
                <p className="lp-docs-body">
                  Starter prompts, freeform chat, tables, charts, artifacts, and feedback all live
                  here. The AI layer is orchestration over local data, not the primary runtime of the
                  product. Deterministic recap cards and durable AI state are implemented now, while
                  provider-backed packaged flows still need broader real-world proof before they
                  should be treated as fully settled.
                </p>
                <div className="lp-docs-examples">
                  {[
                    "What did I actually get done this week?",
                    "What did I work on for Acme?",
                    "Where did Tuesday afternoon go?",
                    "What did I read before that meeting?",
                    "Draft my weekly update report from what I got done this week.",
                  ].map((q) => (
                    <div key={q} className="lp-docs-example">
                      <span className="lp-docs-example-q">Q</span>
                      {q}
                    </div>
                  ))}
                </div>
                <div className="lp-docs-infobox">
                  <span className="lp-docs-infobox-label">Note:</span>
                  AI-powered answers depend on a configured provider and send activity summaries such
                  as app names, titles, durations, and related evidence needed to answer the query.
                  They do not rely on screenshots or keystroke capture. Your activity database stays
                  on your laptop; what leaves is what you choose to send when you ask.
                </div>
              </section>

              <section id="focus" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">Focus Sessions</h2>
                <p className="lp-docs-body">
                  Focus sessions live inside the AI surface. They are not a separate top-level tab.
                  Starting, stopping, and reviewing focus runs should stay connected to the same
                  evidence-grounded workflow as the rest of Daylens.
                </p>
                <p className="lp-docs-body">
                  In practice, that means a focus session is part timer, part work context, and part
                  review loop. Session summaries should stay grounded in what the tracker actually saw
                  happen.
                </p>
              </section>

              <section id="reports" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">Reports and Exports</h2>
                <p className="lp-docs-body">
                  Reports and exports also belong in the AI surface. Ask for a report, export, or
                  artifact there and Daylens should generate it from tracked evidence rather than from
                  a separate reporting product.
                </p>
                <p className="lp-docs-body">
                  This is where client summaries, recap cards, and evidence-backed exports are meant
                  to live. Today that includes a deterministic daily, weekly, and monthly recap
                  foundation inside AI, but it still needs human validation before it should be called
                  fully shipped. Richer year-end storytelling remains future work.
                </p>
              </section>

              <section id="sync" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">Sync and Web Access</h2>
                <p className="lp-docs-body">
                  Daylens is local-first. Optional workspace and sync features exist so you can access
                  linked surfaces from a browser, but the desktop app remains the source of truth for
                  capture, persistence, and reconstruction.
                </p>
                <div className="lp-docs-steps">
                  <div className="lp-docs-step">
                    <span className="text-label lp-docs-step-num">01</span>
                    <div>
                      <p className="lp-docs-step-title">Create a workspace in Settings</p>
                      <p className="lp-docs-step-body">
                        The desktop app exposes workspace and sync controls directly in Settings. If
                        you keep everything local, you can leave them alone.
                      </p>
                    </div>
                  </div>
                  <div className="lp-docs-step">
                    <span className="text-label lp-docs-step-num">02</span>
                    <div>
                      <p className="lp-docs-step-title">Link browser access when needed</p>
                      <p className="lp-docs-step-body">
                        Use the link and recovery flows from this site only if you want browser-side
                        access to that synced workspace.
                      </p>
                    </div>
                  </div>
                  <div className="lp-docs-step">
                    <span className="text-label lp-docs-step-num">03</span>
                    <div>
                      <p className="lp-docs-step-title">Keep expectations grounded</p>
                      <p className="lp-docs-step-body">
                        The desktop app is the primary experience. The web layer should stay aligned
                        with it, not drift into a separate product with contradictory claims.
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              <section id="privacy" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">Privacy and Data</h2>
                <p className="lp-docs-body">
                  Daylens is built around a simple default: keep work history local and explain it
                  from evidence instead of collecting more than the product needs.
                </p>
                <div className="lp-docs-privacy-list">
                  {[
                    ["Local-first by default", "The database on your machine is the source of truth for tracked history."],
                    ["No screenshots", "Daylens uses window, app, browser, and artifact evidence rather than grabbing screen images."],
                    ["No keylogging", "The product does not record what you type."],
                    ["Optional sync", "Workspace and web access flows are additive, not required for the core desktop experience."],
                  ].map(([title, body]) => (
                    <div key={title as string} className="lp-docs-privacy-item">
                      <span className="lp-docs-check">✓</span>
                      <div>
                        <p className="lp-docs-privacy-title">{title}.</p>
                        <p className="lp-docs-privacy-body">{body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section id="faq" style={{ scrollMarginTop: 80 }} className="lp-docs-section">
                <h2 className="text-headline lp-docs-section-title">FAQ</h2>
                <div className="lp-docs-faq">
                  {[
                    {
                      q: "What platforms are currently supported?",
                      a: "Daylens is one cross-platform desktop product. macOS and Windows have public download paths here today. Linux is part of the product too, but public guidance still routes through the Linux status page until real-machine validation is further along.",
                    },
                    {
                      q: "What does Daylens actually track?",
                      a: "It uses app, window, browser, meeting, and artifact evidence to reconstruct work sessions. The goal is to answer what you were working on, not just which app was foregrounded.",
                    },
                    {
                      q: "Where do focus sessions and reports live?",
                      a: "Inside the AI surface. Focus start, stop, and review flows, along with report and export requests, stay there instead of becoming extra top-level tabs.",
                    },
                    {
                      q: "Can I delete or export my data?",
                      a: "Settings is where privacy, export, delete, and workspace controls belong. The product is designed so local history remains the base layer even when optional sync is enabled.",
                    },
                    {
                      q: "Is Wrapped already shipped?",
                      a: "Not as a fully proven feature. A deterministic daily, weekly, and monthly recap now exists inside the AI surface, but it still needs broader validation before it should be marketed as fully shipped. Richer Wrapped-style storytelling remains future work.",
                    },
                    {
                      q: "Where is the source of truth?",
                      a: "Your local Daylens database on your machine. Optional sync and web access are additive; they do not replace the desktop history store.",
                    },
                  ].map(({ q, a }) => (
                    <details key={q} className="lp-docs-faq-item">
                      <summary>
                        <span className="lp-docs-faq-q">{q}</span>
                        <svg className="lp-docs-faq-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <line
                            x1="8"
                            y1="2"
                            x2="8"
                            y2="14"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                          <line
                            x1="2"
                            y1="8"
                            x2="14"
                            y2="8"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </summary>
                      <p className="lp-docs-faq-a">{a}</p>
                    </details>
                  ))}
                </div>
              </section>

              <div className="lp-docs-cta">
                <p className="lp-docs-body" style={{ marginBottom: "1.25rem" }}>
                  Need the current implementation status rather than the product overview?
                </p>
                <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                  <Link href="/roadmap" className="lp-btn-ghost-dark">
                    See the roadmap →
                  </Link>
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
