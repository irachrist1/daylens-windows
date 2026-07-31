import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HackathonLanding } from "./hackathon/components/HackathonLanding";
import { appPath, assetPath } from "@/app/lib/basePath";

export const metadata: Metadata = {
  title: "Daylens — Your digital life, made searchable on demand",
  description:
    "Daylens watches what you do on your laptop, keeps it private, and lets you ask anything in plain language — or bring that context into the AI tools you already use.",
  openGraph: {
    title: "Daylens — Your digital life, made searchable on demand",
    description:
      "Ask anything about what you did on your laptop. Bring that context into the AI tools you already use. Private by default.",
    url: "/daylens",
    images: [
      {
        url: assetPath("/hackathon/02-timeline-week.png"),
        width: 1280,
        height: 800,
        alt: "Daylens week view",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Daylens — Your digital life, made searchable on demand",
    description:
      "Your workday, answerable — for you and the AI tools you already use.",
    images: [assetPath("/hackathon/02-timeline-week.png")],
  },
};

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = await searchParams;
  // Preserve old QR-code redirect behavior from the previous landing.
  if (params.token && /^[0-9a-f]{32}$/i.test(params.token)) {
    redirect(appPath(`/link?token=${params.token}`));
  }
  return <HackathonLanding />;
}
