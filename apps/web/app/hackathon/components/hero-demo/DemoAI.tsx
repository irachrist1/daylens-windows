"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { FileSpreadsheet, ArrowUp, Search } from "lucide-react";
import { DEMO_ASKS, matchDemoAsk, replyToFreeform, type DemoAsk } from "./demoData";
import { cn } from "@/app/lib/cn";

type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  ask?: DemoAsk;
};

type Thread = {
  id: string;
  title: string;
  group: "Today" | "Yesterday" | "Previous 30 Days";
  askIndex?: number;
};

const THREADS: Thread[] = [
  { id: "new", title: "Ask anything", group: "Today" },
  { id: "week", title: "What did I get done", group: "Today", askIndex: 0 },
  { id: "acme", title: "Acme this week", group: "Yesterday", askIndex: 1 },
  { id: "tuesday", title: "Tuesday afternoon", group: "Yesterday", askIndex: 2 },
  { id: "report", title: "Weekly update report", group: "Previous 30 Days", askIndex: 4 },
];

function AttachmentCard({ title, kind }: { title: string; kind: string }) {
  return (
    <div className="mt-3 flex max-w-sm items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-950">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
        <FileSpreadsheet className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{kind}</p>
      </div>
      <button
        type="button"
        className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
      >
        Open
      </button>
    </div>
  );
}

export function DemoAI() {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamedText, setStreamedText] = useState("");
  const [activeThreadId, setActiveThreadId] = useState("new");
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const streamTimer = useRef<number | null>(null);

  function isNearBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function scrollToBottomIfSticky() {
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    bottomRef.current?.scrollIntoView({ block: "end" });
  }

  useEffect(() => {
    scrollToBottomIfSticky();
  }, [turns, streamedText]);

  useEffect(() => {
    return () => {
      if (streamTimer.current) window.clearInterval(streamTimer.current);
    };
  }, []);

  function runAsk(ask: DemoAsk, threadId?: string) {
    if (streamTimer.current) {
      window.clearInterval(streamTimer.current);
      streamTimer.current = null;
    }

    if (threadId) setActiveThreadId(threadId);
    stickToBottom.current = true;

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      text: ask.q,
    };
    const assistantId = `a-${Date.now()}`;
    setTurns([userTurn]);
    setStreamingId(assistantId);
    setStreamedText("");
    setInput("");

    let i = 0;
    streamTimer.current = window.setInterval(() => {
      i += 2;
      const next = ask.a.slice(0, i);
      setStreamedText(next);
      if (i >= ask.a.length) {
        if (streamTimer.current) window.clearInterval(streamTimer.current);
        streamTimer.current = null;
        setTurns([userTurn, { id: assistantId, role: "assistant", text: ask.a, ask }]);
        setStreamingId(null);
        setStreamedText("");
      }
    }, 16);
  }

  function selectThread(thread: Thread) {
    setActiveThreadId(thread.id);
    if (thread.askIndex !== undefined) {
      const ask = DEMO_ASKS[thread.askIndex];
      if (ask) runAsk(ask, thread.id);
      return;
    }
    if (streamTimer.current) {
      window.clearInterval(streamTimer.current);
      streamTimer.current = null;
    }
    setTurns([]);
    setStreamingId(null);
    setStreamedText("");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const matched = matchDemoAsk(input);
    if (matched) {
      runAsk(matched);
      return;
    }
    if (!input.trim()) return;

    stickToBottom.current = true;
    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: "user",
      text: input.trim(),
    };
    const nudge: ChatTurn = {
      id: `a-${Date.now()}`,
      role: "assistant",
      text: replyToFreeform(input),
    };
    setTurns((prev) => [...prev, userTurn, nudge]);
    setInput("");
  }

  const isEmpty = turns.length === 0 && !streamingId;
  const groups = ["Today", "Yesterday", "Previous 30 Days"] as const;
  const activeThread = THREADS.find((t) => t.id === activeThreadId) ?? THREADS[0]!;

  return (
    <div className="flex h-full min-h-0">
      {/* Thread list — mirrors desktop AI sidebar */}
      <aside className="flex w-[180px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40 xl:w-[200px]">
        <div className="border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
          <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950">
            <Search className="size-3.5 shrink-0" aria-hidden />
            Search chats
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {groups.map((group) => {
            const items = THREADS.filter((t) => t.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="mb-3">
                <p className="px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-zinc-400">
                  {group}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {items.map((thread) => (
                    <li key={thread.id}>
                      <button
                        type="button"
                        onClick={() => selectThread(thread)}
                        className={cn(
                          "w-full truncate rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                          activeThreadId === thread.id
                            ? "bg-zinc-200/90 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                            : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
                        )}
                      >
                        {thread.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <p className="text-sm font-medium tracking-tight">{activeThread.title}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Scripted demo · same memory as Timeline
            </p>
          </div>
        </div>

        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            stickToBottom.current = isNearBottom(el);
          }}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          {isEmpty ? (
            <div className="mx-auto flex h-full w-full max-w-lg flex-col justify-center gap-4">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Ask about this sample week — answers are grounded in the same Timeline and
                Apps memory.
              </p>
              <ul className="flex flex-col gap-2">
                {DEMO_ASKS.map((ask) => (
                  <li key={ask.q}>
                    <button
                      type="button"
                      onClick={() => runAsk(ask)}
                      className="w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-left text-sm text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      “{ask.q}”
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-lg flex-col gap-3">
              {turns.map((turn) =>
                turn.role === "user" ? (
                  <div key={turn.id} className="flex justify-end">
                    <span className="max-w-[min(100%,20rem)] rounded-2xl bg-zinc-900 px-3.5 py-2 text-sm leading-relaxed text-white dark:bg-white dark:text-zinc-900">
                      {turn.text}
                    </span>
                  </div>
                ) : (
                  <div key={turn.id} className="w-full text-sm leading-relaxed">
                    <p className="whitespace-pre-line text-zinc-700 dark:text-zinc-200">
                      {turn.text}
                    </p>
                    {turn.ask?.attachment && (
                      <AttachmentCard
                        title={turn.ask.attachment.title}
                        kind={turn.ask.attachment.kind}
                      />
                    )}
                    {turn.ask && turn.ask.evidence.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {turn.ask.evidence.map((chip) => (
                          <span
                            key={chip}
                            className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[11px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                          >
                            {chip}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ),
              )}

              {streamingId && (
                <div className="w-full text-sm leading-relaxed">
                  <p className="whitespace-pre-line text-zinc-700 dark:text-zinc-200">
                    {streamedText}
                    <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-zinc-400 align-middle" />
                  </p>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <form
          onSubmit={onSubmit}
          className="shrink-0 border-t border-zinc-200 p-3 dark:border-zinc-800"
        >
          <div className="mx-auto flex w-full max-w-lg items-end gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything — / for commands, @ to mention…"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-zinc-400"
              disabled={streamingId !== null}
            />
            <button
              type="submit"
              disabled={streamingId !== null || !input.trim()}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-opacity disabled:opacity-30 dark:bg-white dark:text-zinc-900"
              aria-label="Send"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
