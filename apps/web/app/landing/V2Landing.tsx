import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Blocks,
  Check,
  EyeOff,
  Layers3,
  MessageCircleMore,
  Sparkles,
} from "lucide-react";
import { assetPath } from "@/app/lib/basePath";
import { MAC_DOWNLOAD_HREF } from "@/app/lib/platformLinks";
import styles from "./V2Landing.module.css";

const benefits = [
  {
    icon: Layers3,
    title: "Intent, not app switches",
    body: "Writing in Cursor, checking a reference in Dia, and replying in Slack can still be one stretch of work.",
  },
  {
    icon: Blocks,
    title: "One truth, three views",
    body: "Timeline, Apps, and AI read the same blocks, so the hours and the story always agree.",
  },
  {
    icon: EyeOff,
    title: "Noise stays out of sight",
    body: "Idle time, lock screens, and system processes never get dressed up as meaningful work.",
  },
  {
    icon: Sparkles,
    title: "Corrections always win",
    body: "Rename, merge, or remove a block once. Your version survives every rebuild.",
  },
] as const;

const productRows = [
  {
    number: "01",
    title: "A timeline that reads like your day",
    body: "Blocks are named for what you did and sized by how long it took.",
  },
  {
    number: "02",
    title: "Every app, with the work inside it",
    body: "Open any app to see the pages, sites, and intentions that filled the time.",
  },
  {
    number: "03",
    title: "Answers grounded in real evidence",
    body: "Ask what got done, where the afternoon went, or when you last touched a project.",
  },
  {
    number: "04",
    title: "Wraps worth opening",
    body: "Daily and weekly stories come from the same facts, with no scores or invented wins.",
  },
] as const;

const comparisonRows = [
  ["Groups by what you were doing", true, false, false],
  ["Absorbs brief detours", true, false, false],
  ["Keeps corrections after a rebuild", true, false, false],
  ["Answers questions about the day", true, false, false],
  ["Keeps tracked history on your computer", true, false, true],
  ["Never scores or grades the day", true, false, false],
] as const;

const appLogos = [
  ["chrome.svg", "Chrome"],
  ["figma.svg", "Figma"],
  ["slack.png", "Slack"],
  ["vscode.ico", "Visual Studio Code"],
  ["notion.svg", "Notion"],
  ["claude.svg", "Claude"],
] as const;

function Wordmark() {
  return (
    <span className={styles.wordmark}>
      <span className={styles.lensMark} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      Daylens
    </span>
  );
}

function PillLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className={styles.pillLink} href={href}>
      {children}
      <ArrowUpRight size={13} strokeWidth={2.2} />
    </a>
  );
}

function ProductStage({
  src,
  alt,
  className = "",
  priority = false,
}: {
  src: string;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <div className={`${styles.productStage} ${className}`}>
      <div className={styles.productShell}>
        <div className={styles.productScreen}>
          <Image
            src={assetPath(src)}
            alt={alt}
            fill
            priority={priority}
            quality={95}
            sizes="(max-width: 760px) 94vw, 907px"
          />
        </div>
      </div>
    </div>
  );
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return <p className={styles.eyebrow}>{children}</p>;
}

function CheckCell({ value }: { value: boolean }) {
  return value ? (
    <span className={styles.checkCell} aria-label="Included">
      <Check size={13} strokeWidth={2.3} />
      <span>Yes</span>
    </span>
  ) : (
    <span className={styles.emptyCell}>Not built for it</span>
  );
}

export function V2Landing() {
  return (
    <div className={styles.page}>
      <header className={styles.navigation}>
        <div className={styles.navInner}>
          <Link href="/" className={styles.logo} aria-label="Daylens home">
            <Wordmark />
          </Link>
          <nav className={styles.navLinks} aria-label="Main navigation">
            <a href="#benefits">Why Daylens</a>
            <a href="#product">Product</a>
            <a href="#how">How it works</a>
            <a href="#privacy">Privacy</a>
          </nav>
          <PillLink href={MAC_DOWNLOAD_HREF}>Download</PillLink>
        </div>
      </header>

      <main>
        <section className={styles.hero}>
          <h1>See your whole day.</h1>
          <ProductStage
            src="/landing/v2/timeline-recap.png"
            alt="Daylens showing a timeline of work blocks and a recap of the day"
            className={styles.heroStage}
            priority
          />
        </section>

        <section className={styles.logoCloud} aria-label="Works across the apps you use">
          <p>Across the apps that make up your day:</p>
          <div className={styles.logoRow}>
            {appLogos.map(([file, name]) => (
              <div key={name} className={styles.appLogo}>
                <Image
                  src={assetPath(`/brands/${file}`)}
                  alt={name}
                  width={30}
                  height={30}
                />
                <span>{name}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="benefits" className={styles.benefitsSection}>
          <div className={styles.benefitHeading}>
            <SectionEyebrow>Why Daylens</SectionEyebrow>
            <h2>The day, put back together.</h2>
            <p>One calm picture of what you actually got done.</p>
          </div>
          <div className={styles.benefitGrid}>
            {benefits.map(({ icon: Icon, title, body }) => (
              <article key={title}>
                <Icon size={23} strokeWidth={1.75} />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <div className={styles.dayRibbon} aria-hidden="true">
            <div className={styles.ribbonSky} />
            <div className={styles.ribbonGlow} />
            <div className={styles.ribbonWaveOne} />
            <div className={styles.ribbonWaveTwo} />
            <div className={styles.ribbonWaveThree} />
            <div className={styles.ribbonBlocks}>
              <span><b>9:10</b> Building the new timeline</span>
              <span><b>11:40</b> Research and notes</span>
              <span><b>2:15</b> Reviewing the day</span>
            </div>
          </div>
        </section>

        <section id="product" className={styles.featureSection}>
          <div className={styles.featureCopy}>
            <div>
              <h2>See the whole picture</h2>
              <p>
                Daylens turns the work scattered across your computer into one clear,
                searchable memory.
              </p>
            </div>
            <div className={styles.featureList}>
              {productRows.map((row) => (
                <article key={row.number}>
                  <span>{row.number}</span>
                  <div>
                    <strong>{row.title}</strong>
                    <p>{row.body}</p>
                  </div>
                </article>
              ))}
            </div>
            <PillLink href={MAC_DOWNLOAD_HREF}>Get Daylens</PillLink>
          </div>
          <div className={styles.featureVisual}>
            <div className={styles.visualOrbOne} />
            <div className={styles.visualOrbTwo} />
            <div className={styles.timelineCard}>
              <div className={styles.timelineHeader}>
                <span>Tuesday</span>
                <strong>6h 24m</strong>
              </div>
              <div className={styles.timelineTrack}>
                <span className={styles.timeNine}>9am</span>
                <span className={styles.timeNoon}>noon</span>
                <span className={styles.timeThree}>3pm</span>
                <i className={styles.blockOne}><b>Building the new timeline</b><small>2h 18m</small></i>
                <i className={styles.blockTwo}><b>Product research</b><small>1h 6m</small></i>
                <i className={styles.blockThree}><b>Polishing the release</b><small>2h 12m</small></i>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.comparisonSection}>
          <div className={styles.comparisonIntro}>
            <SectionEyebrow>The difference</SectionEyebrow>
            <h2>Why choose Daylens?</h2>
            <p>Activity logs show the tools. Daylens remembers the work.</p>
            <PillLink href={MAC_DOWNLOAD_HREF}>Download</PillLink>
          </div>
          <div className={styles.comparisonScroller}>
            <div className={styles.comparisonTable} role="table" aria-label="Daylens feature comparison">
              <div className={styles.tableHeader} role="row">
                <div role="columnheader" />
                <div className={styles.daylensColumn} role="columnheader"><Wordmark /></div>
                <div role="columnheader">Activity logs</div>
                <div role="columnheader">Manual timers</div>
              </div>
              {comparisonRows.map(([label, daylens, activity, timers]) => (
                <div className={styles.tableRow} role="row" key={label}>
                  <div role="rowheader">{label}</div>
                  <div className={styles.daylensColumn} role="cell"><CheckCell value={daylens} /></div>
                  <div role="cell"><CheckCell value={activity} /></div>
                  <div role="cell"><CheckCell value={timers} /></div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.principleSection}>
          <div className={styles.principleArt} aria-hidden="true">
            <div className={styles.principleHalo} />
            <div className={styles.principleLens}>
              <span />
            </div>
            <div className={styles.principleShadow} />
          </div>
          <blockquote>
            “Your tools are evidence. Your work is the story. Daylens keeps the two
            connected without confusing one for the other.”
            <footer>
              <strong>The Daylens principle</strong>
              <span>One truth across Timeline, Apps, and AI</span>
            </footer>
          </blockquote>
        </section>

        <section id="how" className={styles.howSection}>
          <div className={styles.howHeading}>
            <h2>From activity to memory</h2>
            <PillLink href={MAC_DOWNLOAD_HREF}>Get Daylens</PillLink>
          </div>
          <div className={styles.steps}>
            <article>
              <span>01</span>
              <div>
                <h3>Capture quietly</h3>
                <p>Daylens reads app, window, and browser metadata. No screenshots or video.</p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>Build the day</h3>
                <p>Related activity becomes blocks based on what you were trying to do.</p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>Remember clearly</h3>
                <p>Read the Timeline, open an app, or ask AI for the answer.</p>
              </div>
            </article>
          </div>
        </section>

        <section id="privacy" className={styles.showcaseSection}>
          <div className={styles.showcaseBackdrop}>
            <div className={styles.showcaseCopy}>
              <span>Local by design</span>
              <strong>Your history lives on your computer.</strong>
              <p>AI receives only the resolved facts needed for the answer you asked for.</p>
            </div>
            <ProductStage
              src="/landing/v2/timeline-week.png"
              alt="Daylens week view showing work blocks across several days"
              className={styles.showcaseProduct}
            />
          </div>
        </section>

        <section className={styles.ctaSection}>
          <h2>Make sense of the day</h2>
          <p>Start with the work already happening on your computer.</p>
          <a className={styles.ctaButton} href={MAC_DOWNLOAD_HREF}>
            Download Daylens for macOS
            <ArrowRight size={15} />
          </a>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerLinks}>
          <nav aria-label="Footer navigation">
            <a href="#benefits">Why Daylens</a>
            <a href="#product">Product</a>
            <a href="#how">How it works</a>
            <Link href="/docs">Docs</Link>
          </nav>
        </div>
        <div className={styles.footerCredits}>
          <Wordmark />
          <span>© {new Date().getFullYear()}</span>
          <span>Built in Rwanda</span>
        </div>
      </footer>

      <div className={styles.mobileDock}>
        <a href={MAC_DOWNLOAD_HREF}>Download</a>
        <a href="#product" aria-label="See the product"><MessageCircleMore size={17} /></a>
      </div>
    </div>
  );
}
