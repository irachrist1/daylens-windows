"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import {
  APP_BRANDS,
  CATEGORY_COLORS,
  DEMO_BLOCKS,
  DEMO_DAY_LABEL,
  DEMO_MONTH_DAYS,
  DEMO_MONTH_LABEL,
  DEMO_WEEK_BLOCKS,
  DEMO_WEEK_DAYS,
  DEMO_WEEK_LABEL,
  blockAccentStyle,
  blockDurationMinutes,
  formatClock,
  formatDuration,
  type DemoBlock,
} from "./demoData";
import { assetPath } from "@/app/lib/basePath";
import { cn } from "@/app/lib/cn";

const DAY_START = 9;
const DAY_END = 18;
const PX_PER_HOUR = 72;

type TimelineView = "day" | "week" | "month";

function blockTop(block: DemoBlock): number {
  return ((block.startHour - DAY_START) * 60 + block.startMinute) * (PX_PER_HOUR / 60);
}

function blockHeight(block: DemoBlock): number {
  return Math.max(blockDurationMinutes(block) * (PX_PER_HOUR / 60), 52);
}

function AppIconRow({ apps }: { apps: string[] }) {
  return (
    <ul className="mt-1.5 flex flex-wrap items-center gap-2">
      {apps.map((name) => {
        const brand = APP_BRANDS[name];
        return (
          <li key={name} className="flex items-center gap-1.5">
            {brand ? (
              <Image
                src={assetPath(brand.src)}
                alt=""
                width={16}
                height={16}
                className={cn("size-4", brand.invertInDark && "dark:invert")}
              />
            ) : (
              <span className="flex size-4 items-center justify-center rounded bg-zinc-200 text-[8px] font-medium text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                {name.slice(0, 1)}
              </span>
            )}
            <span className="text-xs text-zinc-600 dark:text-zinc-300">{name}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ViewSwitcher({
  view,
  onChange,
}: {
  view: TimelineView;
  onChange: (view: TimelineView) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 p-0.5 text-xs dark:border-zinc-700">
      {(["day", "week", "month"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            "rounded-md px-2.5 py-1 capitalize transition-colors",
            view === option
              ? "bg-blue-600 font-medium text-white"
              : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function DayView({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const hours = useMemo(
    () => Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i),
    [],
  );
  const trackHeight = (DAY_END - DAY_START) * PX_PER_HOUR;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="relative" style={{ height: trackHeight }}>
        {hours.map((hour) => (
          <div
            key={hour}
            className="pointer-events-none absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800/80"
            style={{ top: (hour - DAY_START) * PX_PER_HOUR }}
          >
            <span className="absolute -top-2.5 left-0 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
              {formatClock(hour, 0).replace(":00", "")}
            </span>
          </div>
        ))}

        {DEMO_BLOCKS.map((block) => {
          const isSelected = block.id === selectedId;
          const accent = blockAccentStyle(block.category, isSelected);
          return (
            <button
              key={block.id}
              type="button"
              onClick={() => onSelect(block.id)}
              className="absolute right-0 left-10 overflow-hidden rounded-xl border px-3 py-2 text-left transition-shadow"
              style={{
                top: blockTop(block),
                height: blockHeight(block),
                backgroundColor: accent.backgroundColor,
                borderColor: accent.borderColor,
              }}
            >
              <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {block.title}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-zinc-600 dark:text-zinc-400">
                {formatClock(block.startHour, block.startMinute)} –{" "}
                {formatClock(block.endHour, block.endMinute)}
                {" · "}
                {formatDuration(blockDurationMinutes(block))}
              </p>
              {blockHeight(block) > 64 && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">
                  {block.body}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const hours = useMemo(
    () => Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i),
    [],
  );
  const trackHeight = (DAY_END - DAY_START) * PX_PER_HOUR;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-[36px_repeat(7,minmax(0,1fr))] border-b border-zinc-200 dark:border-zinc-800">
        <div />
        {DEMO_WEEK_DAYS.map((day) => (
          <div
            key={day.label}
            className="border-l border-zinc-100 px-1 py-2 text-center dark:border-zinc-800"
          >
            <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">
              {day.label}
            </p>
            <p
              className={cn(
                "mt-0.5 text-sm font-medium",
                day.date === 28
                  ? "mx-auto flex size-6 items-center justify-center rounded-full bg-blue-600 text-xs text-white"
                  : "text-zinc-700 dark:text-zinc-200",
              )}
            >
              {day.date}
            </p>
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="grid grid-cols-[36px_repeat(7,minmax(0,1fr))]"
          style={{ height: trackHeight, minWidth: 640 }}
        >
          <div className="relative">
            {hours.map((hour) => (
              <span
                key={hour}
                className="absolute left-0 font-mono text-[9px] text-zinc-400"
                style={{ top: (hour - DAY_START) * PX_PER_HOUR - 6 }}
              >
                {formatClock(hour, 0).replace(":00", "")}
              </span>
            ))}
          </div>

          {DEMO_WEEK_DAYS.map((day, dayIndex) => (
            <div
              key={day.label}
              className="relative border-l border-zinc-100 dark:border-zinc-800"
            >
              {hours.map((hour) => (
                <div
                  key={hour}
                  className="pointer-events-none absolute inset-x-0 border-t border-zinc-100 dark:border-zinc-800/80"
                  style={{ top: (hour - DAY_START) * PX_PER_HOUR }}
                />
              ))}
              {DEMO_WEEK_BLOCKS.filter((b) => b.dayIndex === dayIndex).map((block) => {
                const isSelected = block.id === selectedId;
                const accent = blockAccentStyle(block.category, isSelected);
                return (
                  <button
                    key={block.id}
                    type="button"
                    onClick={() => onSelect(block.id)}
                    className="absolute inset-x-0.5 overflow-hidden rounded-md border px-1 py-0.5 text-left"
                    style={{
                      top: blockTop(block),
                      height: blockHeight(block),
                      backgroundColor: accent.backgroundColor,
                      borderColor: accent.borderColor,
                    }}
                  >
                    <p className="truncate text-[10px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">
                      {block.title}
                    </p>
                    {blockHeight(block) > 40 && (
                      <p className="truncate text-[9px] text-zinc-600 dark:text-zinc-400">
                        {formatDuration(blockDurationMinutes(block))}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MonthView({ onPickDay }: { onPickDay: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-800">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div
            key={d}
            className="bg-zinc-50 px-2 py-1.5 font-mono text-[10px] uppercase tracking-wide text-zinc-400 dark:bg-zinc-900"
          >
            {d}
          </div>
        ))}
        {DEMO_MONTH_DAYS.map((cell, index) => (
          <button
            key={`${cell.day}-${index}`}
            type="button"
            disabled={!cell.inMonth}
            onClick={() => {
              if (cell.isToday) onPickDay();
            }}
            className={cn(
              "flex min-h-[88px] flex-col bg-white p-1.5 text-left dark:bg-zinc-950",
              !cell.inMonth && "bg-zinc-50/80 dark:bg-zinc-900/40",
              cell.isToday && "ring-1 ring-inset ring-blue-500",
            )}
          >
            <span
              className={cn(
                "ml-auto flex size-5 items-center justify-center text-[11px]",
                cell.isToday
                  ? "rounded-full bg-blue-600 font-medium text-white"
                  : cell.inMonth
                    ? "text-zinc-700 dark:text-zinc-300"
                    : "text-zinc-300 dark:text-zinc-600",
              )}
            >
              {cell.day}
            </span>
            <ul className="mt-0.5 flex flex-1 flex-col gap-0.5 overflow-hidden">
              {cell.entries.slice(0, 3).map((entry) => (
                <li
                  key={`${entry.time}-${entry.title}`}
                  className="flex items-center gap-1 truncate text-[9px] text-zinc-600 dark:text-zinc-400"
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: CATEGORY_COLORS[entry.category] }}
                  />
                  <span className="truncate">
                    {entry.time} {entry.title}
                  </span>
                </li>
              ))}
              {cell.more ? (
                <li className="text-[9px] text-zinc-400">+{cell.more} more</li>
              ) : null}
            </ul>
            {cell.tracked && cell.inMonth ? (
              <p className="mt-auto pt-0.5 text-[9px] text-zinc-400">{cell.tracked} tracked</p>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DemoTimeline() {
  const [view, setView] = useState<TimelineView>("day");
  const [selectedId, setSelectedId] = useState<string>(DEMO_BLOCKS[1]?.id ?? DEMO_BLOCKS[0]!.id);

  const selected = useMemo(() => {
    return (
      DEMO_WEEK_BLOCKS.find((b) => b.id === selectedId) ??
      DEMO_BLOCKS.find((b) => b.id === selectedId) ??
      DEMO_BLOCKS[0]!
    );
  }, [selectedId]);

  const totalMinutes = DEMO_BLOCKS.reduce((sum, b) => sum + blockDurationMinutes(b), 0);
  const headerLabel =
    view === "day" ? DEMO_DAY_LABEL : view === "week" ? DEMO_WEEK_LABEL : DEMO_MONTH_LABEL;
  const headerSub =
    view === "day"
      ? `${formatDuration(totalMinutes)} tracked · ${DEMO_BLOCKS.length} blocks`
      : view === "week"
        ? "Sample week · click a block for details"
        : "Click May 28 to open the day";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div>
          <p className="text-sm font-medium tracking-tight text-zinc-900 dark:text-zinc-100">
            {headerLabel}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{headerSub}</p>
        </div>
        <ViewSwitcher view={view} onChange={setView} />
      </div>

      <div className="flex min-h-0 flex-1">
        {view === "day" && <DayView selectedId={selectedId} onSelect={setSelectedId} />}
        {view === "week" && <WeekView selectedId={selectedId} onSelect={setSelectedId} />}
        {view === "month" && (
          <MonthView
            onPickDay={() => {
              setView("day");
              setSelectedId(DEMO_BLOCKS[1]?.id ?? DEMO_BLOCKS[0]!.id);
            }}
          />
        )}

        {view !== "month" && (
          <aside className="flex w-[220px] shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-900/40 xl:w-[260px]">
            <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-400">
              Details
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: CATEGORY_COLORS[selected.category] }}
              />
              <h3 className="text-base font-medium tracking-tight text-zinc-900 dark:text-zinc-100">
                {selected.title}
              </h3>
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {formatClock(selected.startHour, selected.startMinute)} –{" "}
              {formatClock(selected.endHour, selected.endMinute)}
              {" · "}
              {formatDuration(blockDurationMinutes(selected))}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {selected.body}
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {selected.evidence.map((chip) => (
                <span
                  key={chip}
                  className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
                >
                  {chip}
                </span>
              ))}
            </div>
            <p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-zinc-400">
              Apps
            </p>
            <AppIconRow apps={selected.apps} />
          </aside>
        )}
      </div>
    </div>
  );
}
