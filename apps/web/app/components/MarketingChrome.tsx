import Image from "next/image";
import Link from "next/link";
import { assetPath } from "../lib/basePath";
import {
  LINUX_STATUS_HREF,
  MAC_DOWNLOAD_HREF,
  WINDOWS_DOWNLOAD_HREF,
} from "../lib/platformLinks";

type MarketingNavKey = "home" | "docs" | "roadmap" | "changelog";

const NAV_LINKS: Array<{ href: string; label: string; key: MarketingNavKey }> = [
  { href: "/", label: "Product", key: "home" },
  { href: "/docs", label: "Docs", key: "docs" },
  { href: "/roadmap", label: "Roadmap", key: "roadmap" },
  { href: "/changelog", label: "Changelog", key: "changelog" },
];

function DaylensLogo({ size = 28 }: { size?: number }) {
  return (
    <>
      <Image
        src={assetPath("/app-icon.png")}
        alt=""
        width={size}
        height={size}
        className="rounded-md"
        style={{ width: size, height: size }}
      />
      <span className="text-sm font-medium tracking-tight text-zinc-900">Daylens</span>
    </>
  );
}

export function MarketingInnerNav({
  current,
}: {
  current: MarketingNavKey;
  theme?: "dark" | "light";
  variant?: "default" | "capsule";
  landing?: boolean;
}) {
  return (
    <header className="sticky top-0 z-50 px-4 pt-4 pb-2">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 rounded-full border border-zinc-200 bg-white/80 p-2 pl-4 backdrop-blur-xl">
        <Link href="/" className="flex items-center gap-2" aria-label="Daylens home">
          <DaylensLogo />
        </Link>
        <nav className="hidden items-center gap-7 lg:flex" aria-label="Public site">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={current === link.key ? "page" : undefined}
              className="text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900 aria-[current=page]:text-zinc-900"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <a
          href={MAC_DOWNLOAD_HREF}
          className="inline-flex h-9 items-center justify-center rounded-full bg-zinc-900 px-5 text-xs font-medium text-white transition-colors hover:bg-zinc-800"
        >
          Download
        </a>
      </div>
    </header>
  );
}

export function MarketingFooter({ variant = "full" }: { variant?: "full" | "minimal" }) {
  return (
    <footer className={`v2-site-footer${variant === "minimal" ? " is-minimal" : ""}`}>
      <div className="v2-site-footer-inner">
        <div className="v2-site-footer-top">
          <Link href="/" className="flex items-center gap-2" aria-label="Daylens home">
            <DaylensLogo size={20} />
          </Link>
          <nav aria-label="Footer">
            <Link href="/docs">Docs</Link>
            <Link href="/roadmap">Roadmap</Link>
            <Link href="/changelog">Changelog</Link>
            <a href={MAC_DOWNLOAD_HREF}>macOS</a>
            <a href={WINDOWS_DOWNLOAD_HREF}>Windows</a>
            <a href={LINUX_STATUS_HREF}>Linux</a>
          </nav>
        </div>
        {variant === "full" && <div className="v2-site-wordmark">daylens</div>}
        <div className="v2-site-footer-bottom">
          <span>Local first</span>
        </div>
      </div>
    </footer>
  );
}
