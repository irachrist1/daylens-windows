"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import { MemoryTimelineDemo } from "./MemoryTimelineDemo";
import { JobChatDemo } from "./JobChatDemo";
import { JOB_SCENARIOS } from "./jobsData";
import { cn } from "@/app/lib/cn";

function Split({
  title,
  body,
  media,
  reverse = false,
}: {
  title: string;
  body: string;
  media: ReactNode;
  reverse?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14"
    >
      <div className={cn(reverse && "lg:order-2")}>
        <h3 className="text-2xl font-medium tracking-tight text-zinc-100 md:text-3xl">
          {title}
        </h3>
        <p className="mt-4 max-w-md text-base leading-relaxed text-zinc-400">
          {body}
        </p>
      </div>
      <div className={cn(reverse && "lg:order-1")}>{media}</div>
    </motion.div>
  );
}

/**
 * The jobs band, after OpenAI's Computer History page structure: a dark band of
 * alternating copy/demo splits, one per job the product does. Copy follows
 * docs/product/positioning.md §4 — moment first, no mechanism words.
 */
export function JobsSection() {
  return (
    <section className="bg-zinc-950 px-4 py-20 text-zinc-100 lg:py-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-24 lg:gap-32">
        <Split
          title="The day, written down."
          body="Every entry is something you did — one plain sentence, with the apps that were part of it. Nothing to reconstruct, nothing to remember."
          media={<MemoryTimelineDemo />}
        />
        <Split
          title="Pick up where you left off."
          body="Ask what you were doing before a break without reconstructing every open app, document, and next step."
          media={<JobChatDemo scenario={JOB_SCENARIOS.resume} />}
        />
        <Split
          reverse
          title="Find what you know you saw."
          body="Refer to a document, a conversation, or a page the way you remember it. Daylens identifies the source you mean."
          media={<JobChatDemo scenario={JOB_SCENARIOS.find} />}
        />
        <Split
          title="See where your time actually went."
          body="Not just what you were doing — how long it took, per project, per client, per month. The question an assistant without a memory cannot even start on."
          media={<JobChatDemo scenario={JOB_SCENARIOS.time} />}
        />
      </div>
    </section>
  );
}
