"use client";

import { useState } from "react";
import Image from "next/image";
import { CalendarDays, LayoutGrid, Sparkles, Settings } from "lucide-react";
import { DemoTimeline } from "./DemoTimeline";
import { DemoApps } from "./DemoApps";
import { DemoAI } from "./DemoAI";
import { assetPath } from "@/app/lib/basePath";
import { cn } from "@/app/lib/cn";

type DemoTab = "timeline" | "apps" | "ai";

const NAV: Array<{ id: DemoTab; label: string; icon: typeof CalendarDays }> = [
  { id: "timeline", label: "Timeline", icon: CalendarDays },
  { id: "apps", label: "Apps", icon: LayoutGrid },
  { id: "ai", label: "AI", icon: Sparkles },
];

export function HeroDemo() {
  const [tab, setTab] = useState<DemoTab>("timeline");

  return (
    <div className="w-full">
      {/* Interactive shell — md+ */}
      <div
        className="hidden overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_-32px_rgba(0,0,0,0.35)] dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-[0_24px_80px_-32px_rgba(0,0,0,0.7)] md:block"
        style={{ height: "min(640px, 70vh)" }}
      >
        <div className="flex h-full min-h-0">
          <nav className="flex w-[148px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/90 dark:border-zinc-800 dark:bg-zinc-900/50">
            <div className="flex items-center gap-2 px-3.5 pb-2 pt-3.5">
              <Image
                src={assetPath("/app-icon.png")}
                alt=""
                width={22}
                height={22}
                className="size-[22px] rounded-[5px]"
              />
              <span className="text-sm font-medium tracking-tight">Daylens</span>
            </div>
            <ul className="mt-3 flex flex-1 flex-col gap-0.5 px-2">
              {NAV.map((item) => {
                const Icon = item.icon;
                const active = tab === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                        active
                          ? "bg-zinc-200/80 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
                      )}
                    >
                      <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
                      {item.label}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
              <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-zinc-400">
                <Settings className="size-4 opacity-60" aria-hidden />
                Settings
              </div>
            </div>
          </nav>

          <div className="min-w-0 flex-1">
            {tab === "timeline" && <DemoTimeline />}
            {tab === "apps" && <DemoApps />}
            {tab === "ai" && <DemoAI />}
          </div>
        </div>
      </div>

      {/* Mobile: static product image (shell is too dense below md) */}
      <div className="md:hidden">
        <Image
          src={assetPath("/hackathon/01-timeline-day.png")}
          alt="Daylens today view — a reconstructed timeline of your work"
          width={2538}
          height={1802}
          priority
          quality={90}
          sizes="100vw"
          className="h-auto w-full rounded-2xl border border-zinc-200 dark:border-zinc-800"
        />
      </div>
    </div>
  );
}
