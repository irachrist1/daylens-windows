"use client";

import { useState } from "react";
import { ArrowUp, Plus } from "lucide-react";
import type { JobScenario } from "./jobsData";
import { cn } from "@/app/lib/cn";

function ModeToggle({
  mode,
  onChange,
}: {
  mode: "with" | "without";
  onChange: (mode: "with" | "without") => void;
}) {
  return (
    <div
      role="group"
      aria-label="Compare answers with and without Daylens"
      className="grid grid-cols-2 rounded-xl border border-zinc-800 bg-zinc-900/70 p-1 text-xs font-medium"
    >
      {(["with", "without"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={mode === option}
          onClick={() => onChange(option)}
          className={cn(
            "rounded-lg px-3 py-1.5 transition-colors",
            mode === option
              ? "bg-zinc-700/80 text-white"
              : "text-zinc-500 hover:text-zinc-300",
          )}
        >
          {option === "with" ? "With Daylens" : "Without"}
        </button>
      ))}
    </div>
  );
}

function WithAnswer({ scenario }: { scenario: JobScenario }) {
  return (
    <div className="text-sm leading-relaxed">
      <p className="text-zinc-200">{scenario.lead}</p>
      <ul className="mt-2 flex flex-col gap-0.5">
        {scenario.steps.map((step) => (
          <li key={step} className="text-[13px] text-zinc-500">
            {step}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-zinc-200">{scenario.answer}</p>
    </div>
  );
}

function InputBar() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2.5">
      <Plus className="size-4 shrink-0 text-zinc-500" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-600">
        Ask Daylens anything…
      </span>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
        <ArrowUp className="size-3.5" aria-hidden />
      </span>
    </div>
  );
}

export function JobChatDemo({ scenario }: { scenario: JobScenario }) {
  const hasToggle = scenario.withoutAnswer !== null;
  const [mode, setMode] = useState<"with" | "without">("with");
  const showWith = !hasToggle || mode === "with";

  return (
    <div className="relative">
      <div
        aria-hidden
        className="absolute -inset-2 rounded-[1.75rem] bg-gradient-to-br from-blue-500/50 via-indigo-500/20 to-sky-400/40 blur-xl"
      />
      <div className="relative flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
        {hasToggle && <ModeToggle mode={mode} onChange={setMode} />}

        <div className="flex min-h-[220px] flex-col gap-3">
          <div className="flex justify-end">
            <span className="max-w-[85%] rounded-2xl bg-zinc-800 px-3.5 py-2 text-sm leading-relaxed text-zinc-100">
              {scenario.question}
            </span>
          </div>
          {/* Keyed remount, no exit animation: a comparison toggle must swap
              even where rAF is throttled and AnimatePresence exits can stall. */}
          <div key={showWith ? "with" : "without"}>
            {showWith ? (
              <WithAnswer scenario={scenario} />
            ) : (
              <p className="text-sm leading-relaxed text-zinc-300">
                {scenario.withoutAnswer}
              </p>
            )}
          </div>
        </div>

        <InputBar />
      </div>
    </div>
  );
}
