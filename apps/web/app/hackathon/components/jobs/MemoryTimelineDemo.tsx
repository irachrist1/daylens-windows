"use client";

import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { APP_BRANDS } from "../hero-demo/demoData";
import { MEMORY_ENTRIES, type MemoryEntry } from "./jobsData";
import { assetPath } from "@/app/lib/basePath";
import { cn } from "@/app/lib/cn";

/** Always rendered on the dark jobs band, so invertInDark applies unconditionally. */
function AppChip({ name }: { name: string }) {
  const brand = APP_BRANDS[name];
  return (
    <li className="flex size-7 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900">
      {brand ? (
        <Image
          src={assetPath(brand.src)}
          alt=""
          width={16}
          height={16}
          className={cn("size-4", brand.invertInDark && "invert")}
        />
      ) : (
        <span aria-hidden className="text-[9px] font-medium text-zinc-400">
          {name.slice(0, 1)}
        </span>
      )}
      <span className="sr-only">{name}</span>
    </li>
  );
}

function Entry({ entry }: { entry: MemoryEntry }) {
  return (
    <li className="flex gap-4">
      <span className="w-14 shrink-0 pt-0.5 text-xs tabular-nums text-zinc-500">
        {entry.time}
      </span>
      <div className="relative flex-1 border-l border-zinc-800 pb-9 pl-5 last:pb-0">
        <span
          aria-hidden
          className="absolute top-1.5 -left-[4.5px] size-2 rounded-full bg-zinc-600"
        />
        <p className="text-sm font-medium tracking-tight text-zinc-100">
          {entry.title}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-zinc-400">
          {entry.sentence}
        </p>
        <ul className="mt-3 flex items-center gap-1.5">
          {entry.apps.map((name) => (
            <AppChip key={name} name={name} />
          ))}
        </ul>
        {entry.suggestion && (
          <div className="mt-3 rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-4">
            <p className="text-sm font-medium tracking-tight text-zinc-100">
              {entry.suggestion.kind}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">
              {entry.suggestion.body}
            </p>
            <button
              type="button"
              className="mt-2 text-sm font-medium text-blue-400 transition-colors hover:text-blue-300"
            >
              {entry.suggestion.action}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function MemoryTimelineDemo() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-2 rounded-[1.75rem] bg-gradient-to-br from-blue-500/50 via-indigo-500/20 to-sky-400/40 blur-xl"
      />
      <div className="relative rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm font-medium text-zinc-200"
        >
          Today
          <ChevronDown className="size-4 text-zinc-500" aria-hidden />
        </button>
        <ul className="mt-6 flex flex-col">
          {MEMORY_ENTRIES.map((entry) => (
            <Entry key={entry.time} entry={entry} />
          ))}
        </ul>
      </div>
    </div>
  );
}
