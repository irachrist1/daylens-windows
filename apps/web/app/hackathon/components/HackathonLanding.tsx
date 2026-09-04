"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, FileSpreadsheet } from "lucide-react";
import { Counter } from "./Counter";
import { ThemeToggle } from "./ThemeToggle";
import { HeroDemo } from "./hero-demo/HeroDemo";
import { DEMO_ASKS } from "./hero-demo/demoData";
import { JobsSection } from "./jobs/JobsSection";
import { assetPath } from "@/app/lib/basePath";
import {
  MAC_DOWNLOAD_HREF,
  WINDOWS_DOWNLOAD_HREF,
  LINUX_STATUS_HREF,
} from "@/app/lib/platformLinks";
import { cn } from "@/app/lib/cn";

// ─── Content ────────────────────────────────────────────────────────────────

const STATS = [
  { label: "Sessions watched this week", value: 397, suffix: "" },
  { label: "Apps in active orbit", value: 28, suffix: "" },
  { label: "Data shared with anyone else", value: 0, suffix: "%" },
];

const EXAMPLE_ASKS = DEMO_ASKS;

const PILLARS = [
  {
    title: "Ask in plain language",
    body: "Ask what you got done, where an afternoon went, or what you were last deep in — and get an answer grounded in what actually happened on your laptop.",
  },
  {
    title: "Answers from real work",
    body: "Timeline, Apps, and AI read the same memory. Drafts, summaries, and recalls come from evidence you can still open and correct — not from a blank page.",
  },
  {
    title: "Context for the tools you already use",
    body: "Opt in to share Daylens memory with Claude, Cursor, and other agents when you want your day as context there too. Off until you turn it on.",
  },
  {
    title: "Private on your laptop",
    body: "Your activity lives in a local database on your machine. What leaves the device is what you choose to send when you ask — not a silent copy of your whole day.",
  },
];

const SUPPORTED_APPS: Array<{
  name: string;
  src: string;
  invertInDark?: boolean;
}> = [
  { name: "VS Code", src: "/brands/vscode.ico" },
  { name: "Claude", src: "/brands/claude-app.png" },
  { name: "Dia", src: "/brands/dia.png" },
  { name: "Chrome", src: "/brands/chrome.svg" },
  { name: "Notion", src: "/brands/notion.svg", invertInDark: true },
  { name: "Figma", src: "/brands/figma.svg" },
  { name: "Linear", src: "/brands/linear.svg" },
  { name: "Slack", src: "/brands/slack.png" },
];

// ─── UI primitives ──────────────────────────────────────────────────────────

function Button({
  children,
  variant = "primary",
  href,
  className = "",
  target,
  rel,
  ...props
}: {
  children: React.ReactNode;
  variant?: "primary" | "outline";
  href?: string;
  className?: string;
  target?: string;
  rel?: string;
}) {
  const base =
    "inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors";
  const styles =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      : "border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-transparent dark:text-zinc-100 dark:hover:bg-zinc-900";
  const cls = `${base} ${styles} ${className}`;
  // Plain <a> rather than next/link: these hrefs are downloads, external links,
  // and in-page hash scrolls — none need client-side routing. Using next/link
  // here would re-apply the configured basePath on top of hrefs that already
  // carry it (via withBasePath), producing /daylens/daylens/... 404s.
  return href ? (
    <a href={href} target={target} rel={rel} className={cls} {...props}>
      {children}
    </a>
  ) : (
    <button className={cls} {...props}>
      {children}
    </button>
  );
}

function ExampleAskAccordion() {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <ul className="mt-12 flex flex-col gap-3 text-left">
      {EXAMPLE_ASKS.map((item, index) => {
        const isOpen = openIndex === index;
        return (
          <li
            key={item.q}
            className={cn(
              "overflow-hidden rounded-2xl border transition-colors",
              isOpen
                ? "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/60"
                : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-transparent",
            )}
          >
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpenIndex(isOpen ? -1 : index)}
              className="flex w-full items-start gap-4 px-5 py-4 text-left md:px-6 md:py-5"
            >
              <span className="min-w-0 flex-1 text-base font-medium tracking-tight md:text-lg">
                “{item.q}”
              </span>
              <ChevronDown
                className={cn(
                  "mt-1 size-5 shrink-0 text-zinc-400 transition-transform duration-300",
                  isOpen && "rotate-180",
                )}
                aria-hidden
              />
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  key="answer"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-zinc-200 px-5 pb-5 pt-4 dark:border-zinc-800 md:px-6 md:pb-6">
                    <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-300 md:text-base">
                      {item.a}
                    </p>
                    {item.attachment && (
                      <div className="mt-4 flex max-w-md items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                          <FileSpreadsheet className="size-5" aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            {item.attachment.title}
                          </p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            {item.attachment.kind}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="shrink-0 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                          Open
                        </button>
                      </div>
                    )}
                    {item.evidence.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {item.evidence.map((chip) => (
                          <span
                            key={chip}
                            className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
                          >
                            {chip}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </li>
        );
      })}
    </ul>
  );
}

function AppleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.36-1.09-.46-2.08-.48-3.22 0-1.43.62-2.18.44-3.04-.36C2.82 15.22 3.54 7.59 9.09 7.31c1.35.07 2.3.74 3.09.8 1.18-.24 2.3-.93 3.56-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.3 2.98-2.57 4.08ZM12.09 7.27c-.15-2.23 1.66-4.07 3.75-4.27.29 2.58-2.07 4.52-3.75 4.27Z" />
    </svg>
  );
}

function WindowsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M0 2.357L6.545 1.5v6H0V2.357zM7.273 1.393L16 0v7.5H7.273V1.393zM0 8.5h6.545v6L0 13.643V8.5zM7.273 8.5H16V16l-8.727-1.393V8.5z" />
    </svg>
  );
}

function LinuxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.84-.41 1.66-.401 2.49a4.85 4.85 0 0 0 .03.484c-.27.272-.61.61-.86 1.024-.32.529-.665 1.157-.665 1.835v.013c0 .35.099.706.282 1.013.27.448.74.798 1.276 1.041.535.244 1.207.392 1.974.392.62 0 1.176-.097 1.65-.273.422-.156.78-.385 1.039-.674.245-.273.448-.547.59-.832.176-.358.301-.74.347-1.137l.146-1.51c.05-.547.275-1.06.685-1.405.42-.351.973-.557 1.529-.557.555 0 1.108.206 1.527.557.41.345.636.858.687 1.405l.144 1.51c.046.397.171.778.348 1.137.142.285.345.56.59.832.259.289.617.518 1.039.674.474.176 1.03.273 1.65.273.768 0 1.439-.148 1.974-.392.535-.243 1.006-.593 1.276-1.041.183-.307.282-.663.282-1.013v-.013c0-.678-.346-1.306-.665-1.835-.25-.414-.59-.752-.86-1.024.02-.16.03-.32.03-.484.009-.83-.123-1.65-.4-2.49-.59-1.771-1.831-3.47-2.717-4.521-.75-1.067-.973-1.928-1.05-3.02C16.103 4.808 17.224.334 12.998.021 12.83.008 12.667 0 12.504 0z" />
    </svg>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function HackathonLanding() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
      {/* NAVBAR */}
      <header className="fixed inset-x-0 top-0 z-50 px-4 pt-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 rounded-full border border-zinc-200 bg-white/80 p-2 pl-4 backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-950/70">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src={assetPath("/app-icon.png")}
              alt="Daylens"
              width={28}
              height={28}
              className="size-7 rounded-md"
            />
            <span className="text-sm font-medium tracking-tight">Daylens</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button href="#download" variant="primary" className="h-9 text-xs">
              Download
            </Button>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative px-4 pt-32 pb-16 lg:pt-40 lg:pb-24">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="mx-auto flex w-full max-w-7xl flex-col items-center gap-14"
        >
          <section className="flex w-full max-w-6xl flex-col items-start justify-between gap-8 lg:flex-row lg:gap-12">
            <h1 className="max-w-2xl text-balance text-4xl font-medium leading-[1.05] tracking-tighter md:text-6xl lg:text-7xl">
              Your digital life, made searchable on demand.
            </h1>
            <div className="flex max-w-md flex-col gap-6 lg:pt-3">
              <p className="text-base leading-relaxed text-zinc-600 dark:text-zinc-400 md:text-lg">
                Daylens watches what you do on your laptop, keeps it private,
                and lets you ask anything in plain language — or bring that
                context into the AI tools you already use.
              </p>
              <div className="flex flex-row gap-2">
                <Button href="#download" variant="primary">
                  Download
                </Button>
              </div>
            </div>
          </section>

          <div className="relative mx-auto w-full max-w-6xl">
            <HeroDemo />
          </div>
        </motion.div>
      </section>

      {/* JOBS — dark band after the hero, structured after the jobs a
          computer memory does (positioning.md §4/§5) */}
      <JobsSection />

      {/* SUPPORTED APPS */}
      <section className="px-4 py-16">
        <div className="mx-auto flex max-w-6xl flex-col gap-8">
          <div className="flex flex-col items-center text-center">
            <h2 className="text-3xl font-medium tracking-tight md:text-4xl">
              The apps you already live in.
            </h2>
            <p className="mt-3 max-w-md text-base text-zinc-500 dark:text-zinc-400">
              Daylens watches your workspace quietly — without a pile of
              integrations to set up first.
            </p>
          </div>

          <div className="grid grid-cols-2 border-l border-t border-zinc-200 dark:border-zinc-800 md:grid-cols-4">
            {SUPPORTED_APPS.map((app) => (
              <div
                key={app.name}
                className="flex h-24 items-center justify-center border-b border-r border-zinc-200 grayscale transition-all duration-300 hover:grayscale-0 dark:border-zinc-800 lg:h-32"
              >
                <Image
                  src={assetPath(app.src)}
                  alt={app.name}
                  width={32}
                  height={32}
                  className={cn(
                    "size-8 opacity-90",
                    app.invertInDark && "dark:invert",
                  )}
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* STATS */}
      <section className="px-4 py-20 lg:py-28">
        <div className="mb-16 flex flex-col items-center gap-3 text-center">
          <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">
            Memory over surveillance.
          </h2>
          <p className="max-w-md text-base text-zinc-500 dark:text-zinc-400">
            The data you generate every day should belong to you. So it does.
          </p>
        </div>

        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-1 border-l border-t border-zinc-200 dark:border-zinc-800 md:grid-cols-3">
            {STATS.map((stat) => (
              <div
                key={stat.label}
                className="flex flex-col items-center justify-center border-b border-r border-zinc-200 px-6 py-12 text-center dark:border-zinc-800"
              >
                <div className="text-4xl font-medium tracking-tight md:text-5xl">
                  <Counter value={stat.value} suffix={stat.suffix} />
                </div>
                <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                  {stat.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* EXAMPLE ASKS */}
      <section className="px-4 py-20 lg:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">
            Ask anything about your day.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-zinc-500 dark:text-zinc-400">
            Open a question to see the kind of answer Daylens gives — grounded
            in what actually happened, not a blank page.
          </p>
          <ExampleAskAccordion />
        </div>
      </section>

      {/* ARCHITECTURE */}
      <section id="architecture" className="px-4 py-20 lg:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="mb-16 text-center">
            <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">
              What the AI can do.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-zinc-500 dark:text-zinc-400">
              Built for knowledge workers — anyone who lives on a laptop and
              already uses AI.
            </p>
          </div>

          <div className="grid grid-cols-1 border-l border-t border-zinc-200 dark:border-zinc-800 md:grid-cols-2">
            {PILLARS.map((pillar) => (
              <div
                key={pillar.title}
                className="flex flex-col gap-3 border-b border-r border-zinc-200 p-10 dark:border-zinc-800"
              >
                <h3 className="text-xl font-medium tracking-tight">
                  {pillar.title}
                </h3>
                <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {pillar.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* DOWNLOAD */}
      <section id="download" className="px-4 py-24 lg:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-balance text-4xl font-medium tracking-tighter md:text-6xl">
            Get your history back.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base text-zinc-500 dark:text-zinc-400">
            Private by default. Available now for macOS. Windows and Linux are
            next.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button href={MAC_DOWNLOAD_HREF} variant="primary">
              <AppleIcon /> Download for Mac
            </Button>
            <Button href={WINDOWS_DOWNLOAD_HREF} variant="outline">
              <WindowsIcon /> Download for Windows
            </Button>
            <Button href={LINUX_STATUS_HREF} variant="outline">
              <LinuxIcon /> Linux status
            </Button>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-zinc-200 px-4 py-10 dark:border-zinc-800">
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400 md:grid-cols-3">
          <div className="flex items-center justify-center gap-2 md:justify-start">
            <Image
              src={assetPath("/app-icon.png")}
              alt="Daylens"
              width={20}
              height={20}
              className="size-5"
            />
            <span className="font-medium tracking-tight text-zinc-900 dark:text-zinc-100">
              Daylens
            </span>
          </div>
          <div className="flex justify-center">
            <Link
              href="/docs"
              className="transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Docs
            </Link>
          </div>
          <p className="text-center font-mono text-[11px] uppercase tracking-widest md:text-right">
            Christian Tonny
          </p>
        </div>
      </footer>
    </div>
  );
}
