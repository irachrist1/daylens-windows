"use client";

import { useState } from "react";
import Image from "next/image";
import { DEMO_APPS } from "./demoData";
import { assetPath } from "@/app/lib/basePath";
import { cn } from "@/app/lib/cn";

export function DemoApps() {
  const [selectedId, setSelectedId] = useState(DEMO_APPS[0]!.id);
  const selected = DEMO_APPS.find((app) => app.id === selectedId) ?? DEMO_APPS[0]!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <p className="text-sm font-medium tracking-tight">Today</p>
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 p-0.5 text-xs dark:border-zinc-700">
          <span className="rounded-md bg-zinc-900 px-2.5 py-1 font-medium text-white dark:bg-white dark:text-zinc-900">
            Day
          </span>
          <span className="px-2.5 py-1 text-zinc-400">7d</span>
          <span className="px-2.5 py-1 text-zinc-400">30d</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <ul className="w-[200px] shrink-0 overflow-y-auto border-r border-zinc-200 p-2 dark:border-zinc-800 sm:w-[220px]">
          {DEMO_APPS.map((app) => {
            const isSelected = app.id === selected.id;
            return (
              <li key={app.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(app.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors",
                    isSelected
                      ? "bg-zinc-100 dark:bg-zinc-800"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                  )}
                >
                  <Image
                    src={assetPath(app.brandSrc)}
                    alt=""
                    width={22}
                    height={22}
                    className={cn("size-[22px]", app.invertInDark && "dark:invert")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{app.name}</span>
                    <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                      {app.category} · {app.durationLabel}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start gap-3">
              <Image
                src={assetPath(selected.brandSrc)}
                alt=""
                width={36}
                height={36}
                className={cn("size-9", selected.invertInDark && "dark:invert")}
              />
              <div className="min-w-0">
                <h3 className="text-base font-medium tracking-tight">{selected.name}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {selected.category} · Tracked for {selected.durationLabel} ·{" "}
                  {selected.sessionsLabel}
                </p>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {selected.narrative}
            </p>
          </div>

          <p className="mt-5 font-mono text-[10px] uppercase tracking-widest text-zinc-400">
            What you did there
          </p>
          <ul className="mt-2 space-y-2">
            {selected.sessions.map((session) => (
              <li
                key={`${session.title}-${session.when}`}
                className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/50"
              >
                <p className="text-sm font-medium">{session.title}</p>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{session.when}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
