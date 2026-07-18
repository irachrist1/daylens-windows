import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { ANALYTICS_EVENT, blockCountBucket, trackedTimeBucket } from '@shared/analytics'
import type {
  AppSettings,
  BillingAccessSnapshot,
  DayTimelinePayload,
  LiveSession,
  OnboardingStage,
  ProofState,
  TrackingPermissionDetails,
  TrackingPermissionState,
  NotificationPermissionState,
  LinuxTrackingDiagnostics,
} from '@shared/types'
import type { AppCategory, SummaryVoice, WorkRhythm } from '@shared/types'
import { nextMacStageAfterGrantedPermission } from '@shared/onboarding'
import { VOICE_SAMPLES, DEFAULT_SUMMARY_VOICE } from '@shared/summaryVoice'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { showIntercom, trackIntercomEvent } from '../lib/intercom'
import { todayString } from '../lib/format'
import ConnectAI from '../components/ConnectAI'
import Mascot, { type MascotExpression } from '../components/Mascot'

// ── Content data ────────────────────────────────────────────────────────────

// Intent chips double as goal ids (persisted to userGoals for back-compat) and as
// sentences that auto-fill the free-text intent box (persisted to userIntent).
const INTENTS = [
  { id: 'billable', label: 'Track billable work', phrase: 'Track billable work across clients and projects.' },
  { id: 'time', label: 'See where my time goes', phrase: 'Understand where my time actually goes.' },
  { id: 'focus', label: 'Protect my focus', phrase: 'Protect my focus and catch distractions early.' },
  { id: 'recall', label: 'Remember what I did', phrase: 'Remember what I worked on without taking notes.' },
  { id: 'ask-ai', label: 'Ask AI about my work', phrase: 'Ask AI specific questions about my week.' },
]

// What the user does — single-select. Seeds the "your work" suggestions and gives
// recaps a frame ("As a designer, your day…"). Deliberately everyday, not jargon.
const ROLES: Array<{ id: string; label: string; emoji: string }> = [
  { id: 'consultant', label: 'Consultant', emoji: '🧭' },
  { id: 'designer', label: 'Designer', emoji: '🎨' },
  { id: 'engineer', label: 'Engineer', emoji: '💻' },
  { id: 'founder', label: 'Founder / operator', emoji: '🚀' },
  { id: 'writer', label: 'Writer / creator', emoji: '✍️' },
  { id: 'researcher', label: 'Researcher', emoji: '🔬' },
  { id: 'manager', label: 'Manager / lead', emoji: '📊' },
  { id: 'student', label: 'Student', emoji: '🎓' },
  { id: 'other', label: 'Something else', emoji: '✨' },
]

// Picking a role gently pre-selects a couple of categories, an immediate "it gets
// me" payoff. Only applied while the user hasn't touched categories themselves.
const ROLE_SEED_CATEGORIES: Record<string, AppCategory[]> = {
  consultant: ['meetings', 'communication', 'productivity'],
  designer: ['design', 'productivity'],
  engineer: ['productivity', 'research'],
  founder: ['meetings', 'communication', 'productivity'],
  writer: ['writing', 'research'],
  researcher: ['research', 'writing'],
  manager: ['meetings', 'communication'],
  student: ['research', 'writing'],
  other: [],
}

const RHYTHMS: Array<{ id: WorkRhythm; label: string; hint: string; emoji: string }> = [
  { id: 'early', label: 'Early bird', hint: 'Mornings are my focus', emoji: '🌅' },
  { id: 'standard', label: 'Nine to five', hint: 'Regular working hours', emoji: '🕘' },
  { id: 'night', label: 'Night owl', hint: 'I do my best work late', emoji: '🌙' },
  { id: 'always', label: 'Always on', hint: 'It varies, all hours', emoji: '⚡' },
]

const MAC_STEPS: Array<{ id: OnboardingStage[]; label: string }> = [
  { id: ['welcome', 'why'], label: 'Hello' },
  { id: ['permission', 'relaunch_required', 'verifying_permission'], label: 'Grant access' },
  { id: ['proof'], label: 'First signal' },
  { id: ['tour', 'superpowers'], label: 'How it works' },
  { id: ['about', 'voice', 'work', 'connections', 'privacy', 'personalize'], label: 'Make it yours' },
  { id: ['ai_setup'], label: 'Set up AI' },
  { id: ['ready'], label: 'Ready' },
]

const NON_MAC_STEPS: Array<{ id: OnboardingStage[]; label: string }> = [
  { id: ['welcome', 'why'], label: 'Hello' },
  { id: ['proof'], label: 'First signal' },
  { id: ['tour', 'superpowers'], label: 'How it works' },
  { id: ['about', 'voice', 'work', 'connections', 'privacy', 'personalize'], label: 'Make it yours' },
  { id: ['ai_setup'], label: 'Set up AI' },
  { id: ['ready'], label: 'Ready' },
]

// The five "Make it yours" screens share a progress group; we show a sub-count
// ("3 of 5") in the eyebrow so the user feels momentum without the bar lurching.
const MAKE_IT_YOURS: OnboardingStage[] = ['about', 'voice', 'work', 'connections', 'privacy']

// The macro flow used for the Back button. The mac permission stage is omitted:
// it auto-advances once access is granted, so stepping back into it would bounce
// the user forward again.
const STAGE_FLOW: OnboardingStage[] = ['welcome', 'why', 'proof', 'tour', 'superpowers', 'about', 'voice', 'work', 'connections', 'privacy', 'ai_setup', 'ready']
const SYSTEM_STAGES = new Set<OnboardingStage>(['relaunch_required', 'verifying_permission'])

// Ordered flow for onboarding_step_completed indexing. Unlike STAGE_FLOW (the
// Back button), this includes the mac permission stage — completing it is a
// real funnel step the analytics must count.
const MAC_ANALYTICS_FLOW: OnboardingStage[] = ['welcome', 'why', 'permission', 'proof', 'tour', 'superpowers', 'about', 'voice', 'work', 'connections', 'privacy', 'ai_setup', 'ready']

// Collapse system / legacy stages onto the funnel step they belong to.
function analyticsStage(stage: OnboardingStage): OnboardingStage {
  if (SYSTEM_STAGES.has(stage)) return 'permission'
  if (stage === 'personalize') return 'about'
  return stage
}

// The "why am I installing this?" story, told one calm beat at a time, with Lumen
// acting it out, not three stacked FAQ boxes.
const WHY_BEATS: Array<{ scene: 'diary' | 'device' | 'recap'; expression: MascotExpression; title: string; body: string }> = [
  {
    scene: 'diary',
    expression: 'curious',
    title: 'So… why let an app watch my laptop?',
    body: "Fair question. Most trackers feel like a boss over your shoulder. Daylens is the opposite: a quiet diary of your day that only you can read.",
  },
  {
    scene: 'device',
    expression: 'idle',
    title: 'It all stays on this device.',
    body: 'No screenshots. No video. Just the names of what you had open, and none of it leaves your computer unless you ask it to.',
  },
  {
    scene: 'recap',
    expression: 'happy',
    title: 'At the end of the day, you get the good part.',
    body: "Instead of “where did the day go?”, an honest little recap of what you actually got done, written like a friend caught you up, not a spreadsheet.",
  },
]

// Multi-select roles get a playful Duolingo-style nudge when the combo is funny.
// Keyed by the two role ids sorted alphabetically and joined with '+'.
const ROLE_COMBO_JOKES: Record<string, string> = {
  'consultant+designer': "A consultant AND a designer? Bold. What's wrong with you 😄",
  'designer+engineer': 'Design AND code? The mythical unicorn 🦄',
  'engineer+writer': 'An engineer who writes? Now I have seen everything.',
  'founder+student': 'Founder and student? Sleep is clearly optional.',
  'consultant+founder': 'Founder and consultant. Billing yourself by the hour? 😏',
  'designer+engineer+founder': 'Designer, engineer AND founder. Okay, show off. 🙌',
  'manager+writer': 'A manager who actually writes things down? Rare and precious.',
  'researcher+student': 'Researcher and student. Professionally curious, got it.',
}
function comboJoke(ids: string[]): string | null {
  if (ids.length < 2) return null
  const key = [...ids].sort().join('+')
  if (ROLE_COMBO_JOKES[key]) return ROLE_COMBO_JOKES[key]
  if (ids.length >= 3) return 'A person of many hats. I will try to keep up. 🎩'
  return null
}

// A small popular-apps + sites catalogue for the keep-private autosuggest, so a
// user can quickly hide an app or website even if it is not in their captured
// list yet. Mirrors the app-identity catalogue; everyday names, not jargon.
const POPULAR_APPS_AND_SITES = [
  'Slack', 'Discord', 'WhatsApp', 'Telegram', 'Signal', 'Messages', 'Zoom', 'Microsoft Teams',
  'Gmail', 'Outlook', 'Spark', 'Notion', 'Obsidian', 'Evernote', 'Google Docs', 'Google Sheets',
  'Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint', 'Apple Notes', 'Figma', 'Sketch',
  'Adobe Photoshop', 'Adobe Illustrator', 'Canva', 'Linear', 'Jira', 'Asana', 'Trello', 'ClickUp',
  'Safari', 'Google Chrome', 'Arc', 'Firefox', 'Spotify', 'Apple Music', 'YouTube', 'Netflix',
  'Instagram', 'X (Twitter)', 'Facebook', 'LinkedIn', 'Reddit', 'TikTok', 'ChatGPT', 'Claude',
  'VS Code', 'Xcode', 'Terminal', 'GitHub', 'Calendar', 'Reminders', 'Things', 'Todoist',
  'Tinder', 'Hinge', 'Bumble', 'Twitch', 'Steam', 'Photos', 'Mail', 'FaceTime',
]

// Day-one "try asking" questions, written for someone who has NOT tracked a full
// day yet. They teach what Daylens is for instead of querying data that is not
// there. Used on the Ready screen.
const READY_QUESTIONS = [
  'How does Daylens know what I worked on?',
  'Can you write my weekly client report?',
  'What can you do that ChatGPT cannot?',
]

// The delight beat: things only Daylens can answer because it actually sees your
// day, contrasted with what a generic chatbot can do. Funny and honest.
const SUPERPOWERS = [
  { you: 'Which client did I actually spend the most time on last week?', them: 'ChatGPT has no idea. It never saw your week.' },
  { you: 'Was I really “in meetings all day”, or did it just feel like it?', them: 'Daylens has the receipts. 🧾' },
  { you: 'Write the timesheet for the 9 hours I lost to “quick” Slack threads.', them: 'It remembers every one of them, sadly for you.' },
]

// Categories a normal person recognises — chosen so Daylens knows what you care to
// see. Deliberately everyday, not developer jargon.
const INTEREST_CATEGORIES: Array<{ id: AppCategory; label: string; emoji: string }> = [
  { id: 'productivity', label: 'Focused work', emoji: '🎯' },
  { id: 'writing', label: 'Writing', emoji: '✍️' },
  { id: 'design', label: 'Design', emoji: '🎨' },
  { id: 'communication', label: 'Email & messages', emoji: '✉️' },
  { id: 'meetings', label: 'Meetings', emoji: '📞' },
  { id: 'research', label: 'Reading & research', emoji: '📚' },
  { id: 'social', label: 'Social media', emoji: '💬' },
  { id: 'entertainment', label: 'Watching & music', emoji: '🎬' },
]

// Fallback focus-app suggestions for a brand-new user with no captured apps yet.
// Real top apps replace these when available.
const COMMON_FOCUS_APPS = ['Google Docs', 'Microsoft Word', 'Figma', 'Notion', 'Slack', 'Gmail', 'Zoom', 'Excel']

interface ProofSnapshot {
  liveSession: LiveSession | null
  timeline: DayTimelinePayload | null
  ready: boolean
}

// ── The stage: one fixed frame, identical on every screen ────────────────────
// Only the content zone changes between screens, and it scrolls inside the frame
// so the card never resizes or clips. Header (Lumen + title) and footer (action +
// skip) hold their position the whole way through.

function Stage({
  expression = 'idle',
  eyebrow,
  title,
  subtitle,
  steps,
  activeStepIndex,
  canGoBack,
  onBack,
  children,
  centered = false,
  contentKey,
  primary,
  secondary,
  skip,
  note,
}: {
  expression?: MascotExpression
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  steps: Array<{ label: string }>
  activeStepIndex: number
  canGoBack: boolean
  onBack: () => void
  children?: ReactNode
  centered?: boolean
  contentKey?: string | number
  primary?: { label: ReactNode; onClick: () => void; disabled?: boolean }
  secondary?: { label: ReactNode; onClick: () => void; disabled?: boolean }
  skip?: { label: ReactNode; onClick: () => void }
  note?: ReactNode
}) {
  return (
    <div className="ob-stage">
      <div className="ob-rail">
        {canGoBack
          ? <button className="ob-back" onClick={onBack}>‹ Back</button>
          : <span className="ob-back-ph" aria-hidden="true" />}
        <div className="ob-rail-right">
          <div className="ob-progress" role="progressbar" aria-valuenow={activeStepIndex + 1} aria-valuemin={1} aria-valuemax={steps.length} aria-label="Setup progress">
            {steps.map((s, i) => (
              <span
                key={`${s.label}-${i}`}
                className={`ob-seg${i === activeStepIndex ? ' is-active' : i < activeStepIndex ? ' is-done' : ''}`}
              />
            ))}
          </div>
          {/* Fin is reachable before setup finishes — a question shouldn't block onboarding. */}
          <button type="button" className="ob-help" onClick={() => showIntercom()} aria-label="Questions? Chat with us">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2.6 3.4h10.8v7.2H8.4L5.4 13.2v-2.6H2.6Z" /></svg>
            Questions?
          </button>
        </div>
      </div>

      {centered ? (
        // Hero screens (welcome, why, ready): Lumen, title and content centre as
        // one group in the available space, so nothing floats with a dead gap.
        <div className="ob-content ob-content-hero" key={contentKey}>
          <div className="ob-hero">
            <span className="ob-lumen-hero"><Mascot expression={expression} size={66} /></span>
            {eyebrow && <div className="ob-eyebrow">{eyebrow}</div>}
            <h1 className="ob-title">{title}</h1>
            {subtitle && <p className="ob-sub">{subtitle}</p>}
            {children}
          </div>
        </div>
      ) : (
        <div className="ob-body">
          <div className="ob-header">
            <span className="ob-lumen"><Mascot expression={expression} size={54} /></span>
            <div className="ob-headtext">
              {eyebrow && <div className="ob-eyebrow">{eyebrow}</div>}
              <h1 className="ob-title">{title}</h1>
              {subtitle && <p className="ob-sub">{subtitle}</p>}
            </div>
          </div>
          <div className="ob-content" key={contentKey}>
            {children}
          </div>
        </div>
      )}

      <div className="ob-footer">
        {primary && (
          <button className="ob-btn-primary" onClick={primary.onClick} disabled={primary.disabled}>
            {primary.label}
          </button>
        )}
        {secondary && (
          <button className="ob-btn-secondary" onClick={secondary.onClick} disabled={secondary.disabled}>
            {secondary.label}
          </button>
        )}
        <span className="ob-footer-spacer" />
        {note && <span className="ob-note">{note}</span>}
        {skip && <button className="ob-skip" onClick={skip.onClick}>{skip.label}</button>}
      </div>
    </div>
  )
}

function SettingsPreview() {
  return (
    <div className="onboarding-settings-mock" aria-hidden="true">
      <div className="onboarding-settings-mock-header">
        <div className="onboarding-settings-mock-dot" style={{ background: '#ff5f56' }} />
        <div className="onboarding-settings-mock-dot" style={{ background: '#ffbd2e' }} />
        <div className="onboarding-settings-mock-dot" style={{ background: '#27c93f' }} />
        <div className="onboarding-settings-mock-title">Privacy & Security · Accessibility</div>
      </div>
      <div className="onboarding-settings-mock-body">
        <div className="onboarding-settings-mock-row onboarding-settings-mock-row-other">
          <span className="onboarding-settings-mock-app">Raycast</span>
          <span className="onboarding-settings-mock-toggle on" />
        </div>
        <div className="onboarding-settings-mock-row onboarding-settings-mock-row-target">
          <span className="onboarding-settings-mock-app">
            <span className="onboarding-settings-mock-badge">Daylens</span>
          </span>
          <span className="onboarding-settings-mock-toggle off" />
        </div>
        <div className="onboarding-settings-mock-row onboarding-settings-mock-row-other">
          <span className="onboarding-settings-mock-app">Zoom</span>
          <span className="onboarding-settings-mock-toggle on" />
        </div>
      </div>
      <div className="onboarding-settings-mock-hint">Flip the Daylens toggle on, then return to this window.</div>
    </div>
  )
}

// ── The tour is a story: one real day, told back to you ─────────────────────

const STORY_BEATS = [
  { scene: 'intro', pos: 0, time: '', line: 'Here is one ordinary day, the way Daylens tells it back to you.' },
  { scene: 'brief', pos: 0.08, time: '8:14 am', line: 'You open your laptop. A short brief is already waiting.' },
  { scene: 'apps', pos: 0.22, time: '9:00 am', line: 'You drift between Docs, Chrome, and Slack.' },
  { scene: 'merge', pos: 0.34, time: '11:50 am', line: 'Daylens saw one thing, not three: writing the proposal.' },
  { scene: 'detour', pos: 0.46, time: '1:42 pm', line: 'A two-minute peek at Instagram, folded in. Never flagged, never judged.' },
  { scene: 'second', pos: 0.60, time: '4:00 pm', line: 'After your team call you finish the proposal. Your day: two clean blocks.' },
  { scene: 'ask', pos: 0.78, time: '9:00 pm', line: 'You wonder: what did I actually get done today?' },
  { scene: 'wrap', pos: 0.86, time: '9:30 pm', line: 'An evening recap, written fresh for the day you had.' },
  { scene: 'week', pos: 0.95, time: 'Friday', line: 'And your week, wrapped. Months and years, too.' },
  { scene: 'yours', pos: 1, time: '', line: 'Got it wrong? Rename it, it sticks. And none of this ever left your machine.' },
] as const

const STORY_ANSWER = 'You spent the morning writing the Q3 proposal, had the 2pm team call, then cleared your inbox. About 5 hours of real work. The trip plan you opened yesterday is still there when you want it.'

function CountUp({ to, decimals = 0, suffix = '' }: { to: number; decimals?: number; suffix?: string }) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    let current = 0
    const increment = to / 26
    const id = window.setInterval(() => {
      current += increment
      if (current >= to) { current = to; window.clearInterval(id) }
      setValue(current)
    }, 22)
    return () => window.clearInterval(id)
  }, [to])
  return <>{value.toFixed(decimals)}{suffix}</>
}

function StoryBlock({ label, time, tone }: { label: string; time: string; tone: string }) {
  return (
    <div className="onboarding-tour-block onboarding-tour-block-static" data-tone={tone} style={{ minHeight: 52 }}>
      <span className="onboarding-tour-block-row">
        <span className="onboarding-tour-block-label">{label}</span>
        <span className="onboarding-tour-block-time">{time}</span>
      </span>
    </div>
  )
}

function TourStory({ index, name }: { index: number; name: string }) {
  const beat = STORY_BEATS[Math.min(index, STORY_BEATS.length - 1)]
  const [typed, setTyped] = useState('')
  const timers = useRef<number[]>([])

  useEffect(() => {
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
    setTyped('')
    if (beat.scene !== 'ask') return
    let n = 0
    const step = () => {
      n += 2
      setTyped(STORY_ANSWER.slice(0, n))
      if (n < STORY_ANSWER.length) timers.current.push(window.setTimeout(step, 16))
    }
    timers.current.push(window.setTimeout(step, 700))
    return () => {
      timers.current.forEach((id) => window.clearTimeout(id))
      timers.current = []
    }
  }, [beat.scene])

  function scene() {
    switch (beat.scene) {
      case 'brief':
        return (
          <div className="onboarding-tour-notif">
            <div className="onboarding-tour-notif-head"><span className="onboarding-tour-notif-dot" />Daylens · morning brief</div>
            <div className="onboarding-tour-notif-body">Good morning{name ? `, ${name}` : ''}. The trip plan was still open yesterday. Pick it back up?</div>
          </div>
        )
      case 'apps':
        return (
          <div className="onboarding-story-apps">
            {['Docs', 'Chrome', 'Slack'].map((app, i) => (
              <span key={app} className="onboarding-story-appchip" style={{ animationDelay: `${i * 0.12}s` }}>{app}</span>
            ))}
          </div>
        )
      case 'merge':
        return (
          <div className="onboarding-story-stack">
            <StoryBlock label="Writing the Q3 proposal" time="9:00–12:00" tone="a" />
            <div className="onboarding-story-cap">3 apps · 1 block</div>
          </div>
        )
      case 'detour':
        return (
          <div className="onboarding-story-stack">
            <StoryBlock label="Writing the Q3 proposal" time="9:00–12:00" tone="a" />
            <div className="onboarding-story-cap"><span className="onboarding-story-pill">Instagram · 2 min</span> absorbed, not a new block</div>
          </div>
        )
      case 'second':
        return (
          <div className="onboarding-story-stack">
            <StoryBlock label="Writing the Q3 proposal" time="9:00–12:00" tone="a" />
            <StoryBlock label="Team call, then inbox" time="2:00–4:00" tone="c" />
          </div>
        )
      case 'ask':
        return (
          <div className="onboarding-tour-chatlog">
            <div className="onboarding-tour-bubble onboarding-tour-bubble-q">What did I get done today?</div>
            {typed === ''
              ? <div className="onboarding-tour-bubble onboarding-tour-bubble-a onboarding-tour-thinking"><span /><span /><span /></div>
              : <div className="onboarding-tour-bubble onboarding-tour-bubble-a">{typed}{typed.length < STORY_ANSWER.length && <span className="onboarding-tour-caret" />}</div>}
          </div>
        )
      case 'wrap':
        return (
          <div className="onboarding-tour-notif">
            <div className="onboarding-tour-notif-head"><span className="onboarding-tour-notif-dot" />Daylens · evening wrap</div>
            <div className="onboarding-tour-notif-body">Two clean blocks, about 5 hours of real work. You finished the Q3 proposal. Nice day.</div>
          </div>
        )
      case 'week':
        return (
          <div className="onboarding-tour-stats">
            <div><strong><CountUp to={18} suffix="h" /></strong><span>focused</span></div>
            <div><strong><CountUp to={23} /></strong><span>sessions</span></div>
            <div><strong><CountUp to={4} /></strong><span>projects</span></div>
          </div>
        )
      case 'yours':
        return (
          <div className="onboarding-story-stack">
            <div className="onboarding-tour-block onboarding-tour-block-static" data-tone="a" style={{ minHeight: 52 }}>
              <span className="onboarding-tour-block-row">
                <span className="onboarding-tour-block-label onboarding-tour-relabel">Q3 proposal</span>
                <span className="onboarding-tour-saved">edited by you</span>
              </span>
            </div>
            <div className="onboarding-tour-privacy">Stays on this device · no scores · no judgment</div>
          </div>
        )
      case 'intro':
      default:
        return (
          <div className="onboarding-story-intro">
            {[0.5, 0.3, 0.42].map((opacity, i) => (
              <div key={i} className="onboarding-story-ghost" style={{ opacity, animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>
        )
    }
  }

  return (
    <div className="onboarding-story">
      <div className="onboarding-daybar" aria-hidden="true">
        <div className="onboarding-daybar-track">
          <div className="onboarding-daybar-fill" style={{ width: `${beat.pos * 100}%` }} />
          <div className="onboarding-daybar-marker" style={{ left: `${beat.pos * 100}%` }} />
        </div>
        <div className="onboarding-daybar-ends"><span>morning</span><span>night</span></div>
      </div>
      <div className="onboarding-story-scene" key={beat.scene}>{scene()}</div>
      <div className="onboarding-story-caption">
        {beat.time && <span className="onboarding-story-time">{beat.time}</span>}
        <span className="onboarding-story-line">{beat.line}</span>
      </div>
    </div>
  )
}

// ── The "why" story scenes ───────────────────────────────────────────────────

function WhyScene({ scene, name }: { scene: 'diary' | 'device' | 'recap'; name: string }) {
  if (scene === 'device') {
    return (
      <div className="ob-why-scene">
        <div className="ob-why-device">
          <div className="ob-why-device-screen"><span className="ob-why-lock">🔒</span></div>
          <div className="ob-why-device-base" />
        </div>
        <div className="ob-why-tags">
          {['No screenshots', 'No video', 'Never the cloud'].map((t, i) => (
            <span key={t} className="ob-why-tag" style={{ animationDelay: `${0.1 + i * 0.1}s` }}>{t}</span>
          ))}
        </div>
      </div>
    )
  }
  if (scene === 'recap') {
    return (
      <div className="ob-why-scene">
        <div className="ob-why-recap">
          <div className="ob-why-recap-label">Evening recap</div>
          <div className="ob-why-recap-body">
            A solid day{name ? `, ${name}` : ''}, about 5 hours in. You stayed with the proposal and got it finished, made your team call, and cleared the inbox. Nice work.
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="ob-why-scene">
      <div className="ob-why-diary">
        <div className="ob-why-diary-line" style={{ width: '72%' }} />
        <div className="ob-why-diary-line" style={{ width: '88%' }} />
        <div className="ob-why-diary-line" style={{ width: '54%' }} />
        <div className="ob-why-diary-seal">only you</div>
      </div>
    </div>
  )
}

// ── Main view ────────────────────────────────────────────────────────────────

function AddItemRow({
  value,
  onChange,
  onAdd,
  placeholder,
  maxLength,
  buttonLabel = 'Add',
}: {
  value: string
  onChange: (value: string) => void
  onAdd: (value: string) => void
  placeholder: string
  maxLength: number
  buttonLabel?: string
}) {
  return (
    <div className="ob-addrow">
      <input
        className="ob-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onAdd(value)
          }
        }}
      />
      <button className="ob-add-btn" onClick={() => onAdd(value)} disabled={!value.trim()}>{buttonLabel}</button>
    </div>
  )
}

function TokenChips({
  items,
  kind,
  onRemove,
  removeLabel,
}: {
  items: string[]
  kind: 'token' | 'private'
  onRemove: (item: string) => void
  removeLabel: (item: string) => string
}) {
  if (items.length === 0) return null
  return (
    <div className="ob-chipwrap">
      {items.map((item) => (
        <span key={item} className={`ob-chip is-${kind}`}>
          {kind === 'private' ? '🔒 ' : ''}{item}
          <button className="ob-token-x" aria-label={removeLabel(item)} onClick={() => onRemove(item)}>×</button>
        </span>
      ))}
    </div>
  )
}

function NotificationPermissionButton({
  permission,
  busy,
  onRequest,
  onOpenSettings,
}: {
  permission: NotificationPermissionState
  busy: boolean
  onRequest: () => Promise<void>
  onOpenSettings: () => Promise<void>
}) {
  if (permission === 'granted' || permission === 'unsupported') return null
  return (
    <button
      type="button"
      className="ob-btn-secondary ob-btn-sm"
      style={{ marginTop: 12 }}
      onClick={() => void (permission === 'denied' ? onOpenSettings() : onRequest())}
      disabled={busy}
    >
      {permission === 'denied' ? 'Open notification settings' : 'Turn on notifications'}
    </button>
  )
}

export default function Onboarding({
  initialSettings,
  onComplete,
}: {
  initialSettings: AppSettings
  onComplete: () => void
}) {
  const [settings, setSettings] = useState(initialSettings)
  const [goals, setGoals] = useState<Set<string>>(new Set(initialSettings.userGoals))
  const [nameDraft, setNameDraft] = useState(initialSettings.userName)
  const [intentDraft, setIntentDraft] = useState(initialSettings.userIntent)
  const [aiConnected, setAiConnected] = useState(initialSettings.onboardingState.aiSetupState === 'connected')
  const [tourIndex, setTourIndex] = useState(0)
  const [whyIndex, setWhyIndex] = useState(0)
  // T3: opt-in to Tracking Controls during onboarding. Off by default — picking
  // an app to keep private (below) flips it on implicitly at persist time.
  const [trackingOptIn] = useState(initialSettings.trackingControlsEnabled ?? false)
  const [defaultUserName, setDefaultUserName] = useState('')
  const [namePlaceholder, setNamePlaceholder] = useState('')
  const [summaryVoice, setSummaryVoiceState] = useState<SummaryVoice>(initialSettings.summaryVoice ?? DEFAULT_SUMMARY_VOICE)
  const [focusApps, setFocusApps] = useState<Set<string>>(new Set(initialSettings.focusApps ?? []))
  const [interestedCategories, setInterestedCategories] = useState<Set<AppCategory>>(new Set(initialSettings.interestedCategories ?? []))
  const [excludedApps, setExcludedApps] = useState<Set<string>>(new Set(initialSettings.trackingExcludedApps ?? []))
  const [topApps, setTopApps] = useState<string[]>([])
  // Roles are multi-select. We seed from the persisted comma-joined label string.
  const [roleIds, setRoleIds] = useState<Set<string>>(() => {
    const saved = (initialSettings.userRole ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    return new Set(ROLES.filter((r) => saved.includes(r.label)).map((r) => r.id))
  })
  const [roleQuip, setRoleQuip] = useState<string | null>(null)
  const quipTimer = useRef<number | null>(null)
  const [clients, setClients] = useState<string[]>(initialSettings.userClients ?? [])
  const [clientDraft, setClientDraft] = useState('')
  const [customAppDraft, setCustomAppDraft] = useState('')
  const [privateDraft, setPrivateDraft] = useState('')
  const [workRhythm, setWorkRhythm] = useState<WorkRhythm | undefined>(initialSettings.workRhythm)
  const [billing, setBilling] = useState<BillingAccessSnapshot | null>(null)
  const [billingBusy, setBillingBusy] = useState(false)
  const [permissionState, setPermissionState] = useState<TrackingPermissionState>(initialSettings.onboardingState.trackingPermissionState)
  const [permissionDetails, setPermissionDetails] = useState<TrackingPermissionDetails | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [proof, setProof] = useState<ProofSnapshot>({ liveSession: null, timeline: null, ready: false })
  const [proofLoadError, setProofLoadError] = useState<string | null>(null)
  const [linuxTracking, setLinuxTracking] = useState<LinuxTrackingDiagnostics | null>(null)
  const [settingsHandoff, setSettingsHandoff] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>('not-determined')
  const onboardingTrackedRef = useRef(false)
  const proofTrackedRef = useRef(false)
  const paywallTrackedRef = useRef(false)
  const onboardingStateRef = useRef(settings.onboardingState)
  const transitionBusyRef = useRef(false)

  const platform = settings.onboardingState.platform
  const stage = settings.onboardingState.stage
  const isMac = platform === 'macos'
  const isLinux = platform === 'linux'
  const steps = isMac ? MAC_STEPS : NON_MAC_STEPS
  const activeStepIndex = useMemo(() => {
    const idx = steps.findIndex((s) => s.id.includes(stage))
    if (idx >= 0) return idx
    return stage === 'complete' ? steps.length : 0
  }, [steps, stage])

  // Friendly per-screen eyebrow: the group label, plus a sub-count for the
  // multi-screen "Make it yours" group so progress reads as momentum.
  const eyebrow = useMemo(() => {
    const label = steps[activeStepIndex]?.label ?? ''
    const myIdx = MAKE_IT_YOURS.indexOf(stage)
    if (myIdx >= 0) return `${label} · ${myIdx + 1} of ${MAKE_IT_YOURS.length}`
    return label
  }, [steps, activeStepIndex, stage])

  useEffect(() => {
    if (onboardingTrackedRef.current) return
    onboardingTrackedRef.current = true
    track(ANALYTICS_EVENT.ONBOARDING_STARTED, {
      stage,
      surface: 'onboarding',
      trigger: 'navigation',
    })
  }, [stage])

  useEffect(() => {
    onboardingStateRef.current = settings.onboardingState
  }, [settings.onboardingState])

  useEffect(() => {
    if (stage !== 'ai_setup' && stage !== 'ready') return
    void ipc.notifications.getPermissionState().then(setNotificationPermission).catch(() => {
      setErrorMessage('Could not check notification permission. You can retry with the button below.')
    })
  }, [stage])

  // Refresh notification permission on window focus during ready stage so the
  // status updates after an OS settings round-trip on every platform.
  useEffect(() => {
    if (stage !== 'ready') return
    if (notificationPermission !== 'not-determined' && notificationPermission !== 'denied') return
    const onFocus = () => {
      void ipc.notifications.getPermissionState().then(setNotificationPermission).catch(() => {
        setErrorMessage('Could not refresh notification permission. Daylens is keeping the last known state.')
      })
    }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [stage, notificationPermission])

  async function requestNotificationPermission() {
    setBusy(true)
    setErrorMessage(null)
    try {
      const next = await ipc.notifications.requestPermission()
      setNotificationPermission(next)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function openNotificationSettings() {
    await ipc.notifications.openSettings()
  }

  // paywall_seen: once per onboarding run, when the AI-setup stage actually
  // shows plans the user could buy (managed billing reachable, nothing paid
  // yet). Mirrors the Settings→Billing fire, with trigger 'onboarding'.
  useEffect(() => {
    if (paywallTrackedRef.current || stage !== 'ai_setup') return
    if (!billing || billing.mode === 'unavailable') return
    if (billing.mode === 'subscription' || billing.mode === 'local_pass') return
    paywallTrackedRef.current = true
    track(ANALYTICS_EVENT.PAYWALL_SEEN, { trigger: 'onboarding' })
  }, [stage, billing])

  // Migrate any state persisted on the old single "personalize" stage onto the
  // first of its replacements so a mid-onboarding reload never lands nowhere.
  useEffect(() => {
    if (stage === 'personalize') void persistOnboarding('about')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  useEffect(() => {
    let cancelled = false
    ipc.app.getDefaultUserName()
      .then((name) => {
        if (!cancelled) setDefaultUserName(name)
      })
      .catch(() => {
        if (!cancelled) setDefaultUserName('')
      })
    return () => { cancelled = true }
  }, [])

  // Seed the name field's placeholder from the computer's friendly name —
  // "Christian's MacBook Pro" → "Christian" — so the greeting feels like Daylens
  // already half-knows you. Falls back to the OS login name.
  useEffect(() => {
    let cancelled = false
    ipc.app.getComputerName()
      .then((computerName) => {
        if (cancelled) return
        const firstName = computerName.split(/['’]s\b/)[0].trim()
        setNamePlaceholder(firstName.length >= 2 && firstName.length <= 24 ? firstName : '')
      })
      .catch(() => { if (!cancelled) setNamePlaceholder('') })
    return () => { cancelled = true }
  }, [])

  // The user's real top apps (last 30 days) ground the focus-app and keep-private
  // pickers in their actual life, not a generic list. Empty for a brand-new user.
  useEffect(() => {
    let cancelled = false
    ipc.db.getAppSummaries(30)
      .then((rows) => {
        if (cancelled) return
        const names = (rows ?? [])
          .map((r) => r.appName ?? '')
          .filter((n): n is string => Boolean(n && n.trim()))
        setTopApps(Array.from(new Set(names)).slice(0, 12))
      })
      .catch(() => { if (!cancelled) setTopApps([]) })
    return () => { cancelled = true }
  }, [])

  // The money moment reads from the real billing snapshot, so the AI screen shows
  // what's actually true in this build (free credit / subscribe / unavailable).
  useEffect(() => {
    if (stage !== 'ai_setup' || billing) return
    let cancelled = false
    ipc.billing.getAccess()
      .then((snapshot) => { if (!cancelled) setBilling(snapshot) })
      .catch(() => { /* fall back to BYOK-only copy */ })
    return () => { cancelled = true }
  }, [stage, billing])

  async function persistOnboarding(
    nextStage: OnboardingStage,
    partial: Partial<AppSettings['onboardingState']> = {},
  ): Promise<boolean> {
    if (transitionBusyRef.current) return false
    transitionBusyRef.current = true
    setBusy(true)
    setErrorMessage(null)
    // onboarding_step_completed fires here — the single choke point every
    // stage transition passes through — exactly once per forward step.
    // Backward navigation and same-stage state updates don't fire.
    const flow = isMac ? MAC_ANALYTICS_FLOW : STAGE_FLOW
    const currentState = onboardingStateRef.current
    const fromIndex = flow.indexOf(analyticsStage(currentState.stage))
    const toIndex = flow.indexOf(analyticsStage(nextStage))
    const nextState = {
      ...currentState,
      ...partial,
      stage: nextStage,
    }
    try {
      await ipc.settings.set({ onboardingState: nextState })
      onboardingStateRef.current = nextState
      setSettings((current) => ({ ...current, onboardingState: nextState }))
      if (fromIndex >= 0 && toIndex > fromIndex) {
        track(ANALYTICS_EVENT.ONBOARDING_STEP_COMPLETED, {
          step_name: flow[fromIndex],
          step_index: fromIndex,
          total_steps: flow.length,
        })
      }
      return true
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      transitionBusyRef.current = false
      setBusy(false)
    }
  }

  async function refreshPermissionState() {
    if (!isMac) return
    const [nextState, details] = await Promise.all([
      ipc.tracking.getPermissionState(),
      ipc.tracking.getPermissionDetails(),
    ])
    setPermissionState(nextState)
    setPermissionDetails(details)

    if (nextState !== 'granted') {
      if (stage === 'verifying_permission') {
        await persistOnboarding('permission', {
          trackingPermissionState: nextState,
          proofState: 'idle',
        })
      }
      return
    }

    const nextStage = nextMacStageAfterGrantedPermission({
      currentStage: stage,
      permissionRequestedAt: settings.onboardingState.permissionRequestedAt,
      origin: 'refresh',
    })

    if (!nextStage) return

    if (nextStage === 'relaunch_required') {
      await persistOnboarding('relaunch_required', {
        trackingPermissionState: 'awaiting_relaunch',
      })
      return
    }

    if (nextStage === 'verifying_permission') {
      await persistOnboarding('verifying_permission', {
        trackingPermissionState: 'granted',
      })
      return
    }

    if (nextStage === 'proof') {
      await persistOnboarding('proof', {
        trackingPermissionState: 'granted',
        proofState: 'collecting',
        permissionRequestedAt: null,
      })
    }
  }

  useEffect(() => {
    if (!isMac || stage !== 'permission') return
    void refreshPermissionState()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, stage, settings.onboardingState.permissionRequestedAt])

  useEffect(() => {
    if (!isMac || stage !== 'verifying_permission') return

    const timer = window.setTimeout(() => {
      void refreshPermissionState()
    }, 650)

    return () => {
      window.clearTimeout(timer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, stage, settings.onboardingState.permissionRequestedAt])

  // While the user is in System Settings we refocus-check on window focus.
  useEffect(() => {
    if (!isMac || stage !== 'permission' || !settingsHandoff) return
    const onFocus = () => { void refreshPermissionState() }
    window.addEventListener('focus', onFocus)
    const interval = window.setInterval(() => { void refreshPermissionState() }, 2_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearInterval(interval)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, stage, settingsHandoff])

  useEffect(() => {
    if (stage !== 'proof') return

    let cancelled = false

    async function loadProof() {
      try {
        const [timeline, liveSession, diagnostics] = await Promise.all([
          ipc.db.getTimelineDay(todayString()),
          ipc.tracking.getLiveSession(),
          isLinux ? ipc.tracking.getDiagnostics() : Promise.resolve(null),
        ])
        if (cancelled) return

        if (isLinux && diagnostics?.linuxTracking) {
          setLinuxTracking(diagnostics.linuxTracking)
        }

        const ready = Boolean(
          liveSession
          || (timeline && (
            timeline.totalSeconds > 0
            || timeline.blocks.length > 0
            || timeline.siteCount > 0
            || timeline.segments.length > 0
          )),
        )

        setProof({ liveSession, timeline, ready })
        setProofLoadError(null)

        const nextProofState: ProofState = ready ? 'ready' : 'collecting'
        const currentOnboardingState = onboardingStateRef.current
        if (currentOnboardingState.proofState !== nextProofState || currentOnboardingState.stage !== 'proof') {
          const nextState = {
            ...currentOnboardingState,
            stage: 'proof' as const,
            proofState: nextProofState,
          }
          setSettings((current) => ({ ...current, onboardingState: nextState }))
          await ipc.settings.set({ onboardingState: nextState })
        }
      } catch (err) {
        if (!cancelled) {
          setProofLoadError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    void loadProof()
    const interval = window.setInterval(() => { void loadProof() }, 2_500)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [stage, isLinux])

  useEffect(() => {
    if (!proof.ready || proofTrackedRef.current) return
    proofTrackedRef.current = true
    track(ANALYTICS_EVENT.TRACKING_PROOF_READY, {
      block_count_bucket: blockCountBucket(proof.timeline?.blocks.length ?? 0),
      surface: 'onboarding',
      tracked_time_bucket: trackedTimeBucket(proof.timeline?.totalSeconds ?? 0),
      trigger: 'system',
      view: 'onboarding',
    })
  }, [proof.ready, proof.timeline])

  function toggleIntent(id: string) {
    const intent = INTENTS.find((item) => item.id === id)
    if (!intent) return
    const selecting = !goals.has(id)
    setGoals((previous) => {
      const next = new Set(previous)
      if (selecting) next.add(id)
      else next.delete(id)
      return next
    })
    // Chips auto-fill the free-text box; the box stays the source of truth for userIntent.
    setIntentDraft((current) => {
      const trimmed = current.trim()
      if (selecting) {
        if (trimmed.includes(intent.phrase)) return current
        return trimmed ? `${trimmed} ${intent.phrase}` : intent.phrase
      }
      return trimmed.replace(intent.phrase, '').replace(/\s{2,}/g, ' ').trim()
    })
  }

  function flashQuip(message: string | null) {
    if (quipTimer.current) window.clearTimeout(quipTimer.current)
    setRoleQuip(message)
    if (message) quipTimer.current = window.setTimeout(() => setRoleQuip(null), 3600)
  }

  function toggleRole(role: { id: string; label: string }) {
    setRoleIds((prev) => {
      const next = new Set(prev)
      const selecting = !next.has(role.id)
      if (selecting) next.add(role.id)
      else next.delete(role.id)
      // Gentle "it gets me" payoff: seed a couple of categories the first time,
      // only if the user hasn't already curated them.
      if (selecting && interestedCategories.size === 0) {
        const seed = ROLE_SEED_CATEGORIES[role.id]
        if (seed && seed.length > 0) setInterestedCategories(new Set(seed))
      }
      // Duolingo-style nudge for funny combos: fades up and away on its own.
      flashQuip(selecting ? comboJoke([...next]) : null)
      return next
    })
  }

  function addClient(raw: string) {
    const name = raw.trim()
    if (!name) return
    setClients((prev) => (prev.some((c) => c.toLowerCase() === name.toLowerCase()) ? prev : [...prev, name].slice(0, 24)))
    setClientDraft('')
  }

  // Add a custom "real work" app the user types in (Excel, PowerPoint, anything
  // not in their captured list yet). Stored in focusApps like the rest.
  function addCustomApp(raw: string) {
    const name = raw.trim()
    if (!name) return
    setFocusApps((prev) => {
      const next = new Set(prev)
      next.add(name)
      return next
    })
    setCustomAppDraft('')
  }

  function addPrivateApp(raw: string) {
    const name = raw.trim()
    if (!name) return
    setExcludedApps((prev) => {
      const next = new Set(prev)
      next.add(name)
      return next
    })
    setPrivateDraft('')
  }

  async function finishOnboarding() {
    if (busy) return
    setBusy(true)
    setErrorMessage(null)

    const completedAt = Date.now()
    const nextOnboardingState = {
      ...settings.onboardingState,
      stage: 'complete' as const,
      proofState: 'ready' as const,
      personalizationState: 'completed' as const,
      aiSetupState: aiConnected ? ('connected' as const) : settings.onboardingState.aiSetupState,
      completedAt,
    }

    try {
      const nextExcludedApps = Array.from(excludedApps)
      await ipc.attribution.ensureClients(clients)
      await ipc.settings.set({
        onboardingComplete: true,
        onboardingState: nextOnboardingState,
        userName: nameDraft.trim() || namePlaceholder.trim(),
        userGoals: Array.from(goals),
        userIntent: intentDraft.trim(),
        userRole: userRoleLabel,
        userClients: clients,
        workRhythm,
        summaryVoice,
        focusApps: Array.from(focusApps),
        interestedCategories: Array.from(interestedCategories),
        trackingControlsEnabled: trackingOptIn || nextExcludedApps.length > 0,
        trackingExcludedApps: nextExcludedApps,
        dailySummaryEnabled: true,
        morningNudgeEnabled: true,
        distractionAlertsEnabled: true,
      })
      await ipc.app.completeOnboarding()
      track(ANALYTICS_EVENT.ONBOARDING_COMPLETED, {
        platform,
        selected_goal_count: goals.size,
        surface: 'onboarding',
      })
      // Intercom: the dashboard-authored post-onboarding tour targets this event.
      // (The Messenger has no floating launcher — it lives in Settings → Help.)
      trackIntercomEvent('onboarding_completed')
      onComplete()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function beginPermissionRequest() {
    setBusy(true)
    setErrorMessage(null)
    try {
      const requestedAt = Date.now()
      const nextState = await ipc.tracking.requestScreenPermission()
      setPermissionState(nextState)
      setPermissionDetails(await ipc.tracking.getPermissionDetails())
      setSettingsHandoff(nextState !== 'granted' && nextState !== 'awaiting_relaunch')
      if (nextState === 'awaiting_relaunch') {
        await persistOnboarding('relaunch_required', {
          trackingPermissionState: nextState,
          permissionRequestedAt: requestedAt,
        })
      } else {
        await persistOnboarding('permission', {
          trackingPermissionState: nextState,
          permissionRequestedAt: requestedAt,
        })
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Escape hatch: the user is never trapped on the permission gate. They can
  // proceed without granting (capture simply has nothing to read until they do)
  // and grant later in Settings.
  async function skipPermission() {
    await persistOnboarding('proof', { proofState: 'collecting' })
  }

  async function handleContinueFromWelcome() {
    // Persist the name as soon as it's given so the rest of the flow (and a
    // mid-flow reload) is already personalized. Fall back to the placeholder.
    const resolvedName = nameDraft.trim() || namePlaceholder.trim()
    if (resolvedName && resolvedName !== nameDraft) setNameDraft(resolvedName)
    try {
      await ipc.settings.set({ userName: resolvedName })
      await persistOnboarding('why')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  // Leaving the capture explainer toward permission/proof is the consent act:
  // record it before advancing so capture (and the proof step's live data) is
  // allowed to start. The redesigned consent screen (separate issue) will own
  // this decision; the recorded state and gate are already in force.
  async function consentAndLeaveWhy() {
    try {
      await ipc.app.setCaptureConsent(true)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      return
    }
    await persistOnboarding(isMac ? 'permission' : 'proof', {
      proofState: isMac ? 'idle' : 'collecting',
    })
  }

  function advanceWhy() {
    if (whyIndex < WHY_BEATS.length - 1) {
      setWhyIndex((i) => i + 1)
      return
    }
    void consentAndLeaveWhy()
  }

  function skipWhy() {
    void consentAndLeaveWhy()
  }

  async function continueFromProof() {
    await persistOnboarding('tour', {
      proofState: proof.ready ? 'ready' : settings.onboardingState.proofState,
    })
  }

  function advanceTour() {
    if (tourIndex < STORY_BEATS.length - 1) {
      setTourIndex((index) => index + 1)
      return
    }
    void persistOnboarding('superpowers')
  }

  function continueFromSuperpowers() {
    void persistOnboarding('about')
  }

  async function continueFromAbout() {
    try {
      await ipc.settings.set({
        userRole: userRoleLabel,
        userGoals: Array.from(goals),
        userIntent: intentDraft.trim(),
      })
      await persistOnboarding('voice')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function chooseVoice(voice: SummaryVoice) {
    const previous = summaryVoice
    setSummaryVoiceState(voice)
    try {
      await ipc.settings.set({ summaryVoice: voice })
    } catch (error) {
      setSummaryVoiceState(previous)
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function continueFromVoice() {
    try {
      await ipc.settings.set({ summaryVoice })
      await persistOnboarding('work')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  function toggleInSet<T>(value: T, setter: Dispatch<SetStateAction<Set<T>>>) {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  // Ground the focus / keep-private pickers in the user's real apps; fall back to
  // a common list for a brand-new user with nothing captured yet.
  const appChoices = topApps.length > 0 ? topApps : COMMON_FOCUS_APPS
  // Custom "real work" apps the user typed that aren't in their captured list.
  const customFocusApps = Array.from(focusApps).filter((a) => !appChoices.includes(a))
  // Persisted, human-readable role label ("Designer, Consultant").
  const userRoleLabel = ROLES.filter((r) => roleIds.has(r.id)).map((r) => r.label).join(', ')
  // Keep-private autosuggest: popular apps + the user's real apps, filtered by
  // what they're typing, excluding anything already marked private.
  const privatePool = Array.from(new Set([...appChoices, ...POPULAR_APPS_AND_SITES]))
  const privateQuery = privateDraft.trim().toLowerCase()
  const privateMatches = (privateQuery
    ? privatePool.filter((a) => a.toLowerCase().includes(privateQuery))
    : privatePool
  ).filter((a) => !excludedApps.has(a)).slice(0, 8)

  const flowIndex = STAGE_FLOW.indexOf(stage)
  const canGoBack = !SYSTEM_STAGES.has(stage) && (
    (stage === 'tour' && tourIndex > 0)
    || (stage === 'why' && whyIndex > 0)
    || flowIndex > 0
  )

  function goBack() {
    if (stage === 'tour' && tourIndex > 0) {
      setTourIndex((index) => index - 1)
      return
    }
    if (stage === 'why' && whyIndex > 0) {
      setWhyIndex((index) => index - 1)
      return
    }
    const previous = STAGE_FLOW[flowIndex - 1]
    if (!previous) return
    void persistOnboarding(previous)
  }

  async function continueFromWork() {
    try {
      await ipc.settings.set({
        focusApps: Array.from(focusApps),
        interestedCategories: Array.from(interestedCategories),
      })
      await persistOnboarding('connections')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function continueFromConnections() {
    setBusy(true)
    setErrorMessage(null)
    try {
      await ipc.attribution.ensureClients(clients)
      await ipc.settings.set({ workRhythm })
      await persistOnboarding('privacy')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (!transitionBusyRef.current) setBusy(false)
    }
  }

  async function continueFromPrivacy() {
    const nextExcludedApps = Array.from(excludedApps)
    try {
      await ipc.settings.set({
        // Excluding specific apps requires the controls master switch on. Turn it
        // on implicitly when the user actually picked something to keep private.
        trackingControlsEnabled: trackingOptIn || nextExcludedApps.length > 0,
        trackingExcludedApps: nextExcludedApps,
      })
      await persistOnboarding('ai_setup', { personalizationState: 'completed' })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  async function openCheckout() {
    setBillingBusy(true)
    setErrorMessage(null)
    try {
      await ipc.billing.createPolarCheckout('onboarding')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBillingBusy(false)
    }
  }

  async function continueFromAiSetup() {
    if (notificationPermission === 'not-determined') {
      await requestNotificationPermission()
    } else if (notificationPermission === 'denied') {
      await openNotificationSettings()
    }
    await persistOnboarding('ready', {
      aiSetupState: aiConnected ? 'connected' : 'dismissed',
    })
  }

  const permissionStatusLabel =
    permissionState === 'granted'
      ? 'Enabled'
      : permissionState === 'awaiting_relaunch'
        ? 'Ready to restart'
        : settingsHandoff
          ? 'Waiting on you in System Settings'
          : 'Not yet enabled'

  const permissionStatusTone: 'ok' | 'waiting' | 'pending' =
    permissionState === 'granted' || permissionState === 'awaiting_relaunch'
      ? 'ok'
      : settingsHandoff
        ? 'waiting'
        : 'pending'

  const notificationStatusLabel =
    notificationPermission === 'granted'
      ? 'Enabled'
      : notificationPermission === 'denied'
        ? 'Blocked in System Settings'
        : notificationPermission === 'unsupported'
          ? 'Not supported on this system'
          : 'Not yet enabled'

  const notificationStatusTone: 'ok' | 'waiting' | 'pending' =
    notificationPermission === 'granted'
      ? 'ok'
      : notificationPermission === 'denied'
        ? 'waiting'
        : 'pending'

  const greetName = nameDraft.trim() || namePlaceholder
  const railProps = { steps, activeStepIndex, canGoBack, onBack: goBack }
  const voiceSample = VOICE_SAMPLES.find((v) => v.voice === summaryVoice)
  // Managed AI is "available" when billing reports a real managed mode (not the
  // unavailable fallback some builds ship with). Drives the $5 framing honestly.
  const managedAvailable = billing != null && billing.mode !== 'unavailable'

  function renderStage() {
    switch (stage) {
      case 'welcome':
        return (
          <Stage
            {...railProps}
            expression="wave"
            eyebrow={eyebrow}
            title={<>Hi{greetName ? ` ${greetName}` : ''} <span className="ob-wave">👋</span></>}
            subtitle="Let's get Daylens set up together. First, what should it call you?"
            centered
            contentKey="welcome"
            primary={{ label: greetName ? 'Nice to meet you' : 'Continue', onClick: () => void handleContinueFromWelcome() }}
          >
            <label className="ob-name-field">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={namePlaceholder || defaultUserName || 'Your name'}
                maxLength={80}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') void handleContinueFromWelcome() }}
              />
            </label>
            <p className="ob-reassure">Private by default · stays on this device · no judgment</p>
          </Stage>
        )

      case 'why': {
        const beat = WHY_BEATS[Math.min(whyIndex, WHY_BEATS.length - 1)]
        const last = whyIndex >= WHY_BEATS.length - 1
        return (
          <Stage
            {...railProps}
            expression={beat.expression}
            eyebrow={`${eyebrow} · ${whyIndex + 1} of ${WHY_BEATS.length}`}
            title={beat.title}
            subtitle={beat.body}
            centered
            contentKey={`why-${beat.scene}`}
            primary={{ label: last ? "Makes sense, let's go" : 'Continue', onClick: () => advanceWhy() }}
            skip={{ label: 'Skip', onClick: () => skipWhy() }}
          >
            <WhyScene scene={beat.scene} name={greetName} />
            <div className="ob-why-dots" aria-hidden="true">
              {WHY_BEATS.map((_, i) => <span key={i} className={`ob-why-dot${i === whyIndex ? ' is-active' : ''}`} />)}
            </div>
          </Stage>
        )
      }

      case 'permission':
        return (
          <Stage
            {...railProps}
            expression="curious"
            eyebrow={eyebrow}
            title="One quick permission to read window titles"
            subtitle="Daylens needs macOS Accessibility to read just the names of what you have open. No screenshots, no video, ever."
            contentKey="permission"
            primary={{ label: busy ? 'Opening System Settings…' : 'Open Privacy & Security', onClick: () => void beginPermissionRequest(), disabled: busy }}
            secondary={{ label: 'I already enabled it', onClick: () => void refreshPermissionState() }}
            skip={{ label: 'Skip for now', onClick: () => void skipPermission() }}
          >
            <SettingsPreview />
            <div className={`ob-status ob-status-${permissionStatusTone}`}>
              <span className="ob-status-dot" />
              <span className="ob-status-label">{permissionStatusLabel}</span>
              {settingsHandoff && (
                <span className="ob-status-note">Keep this window open. We'll pick up the moment the toggle flips.</span>
              )}
            </div>
            {permissionDetails && (
              <div className="ob-status ob-status-pending">
                <span className="ob-status-label">
                  Accessibility: {permissionDetails.accessibility === 'granted' ? 'Enabled' : 'Missing'}
                </span>
              </div>
            )}
          </Stage>
        )

      case 'relaunch_required':
        return (
          <Stage
            {...railProps}
            expression="idle"
            eyebrow={eyebrow}
            title="One restart and we're set"
            subtitle="Daylens has the permission. macOS just needs a quick restart to hand it over."
            contentKey="relaunch"
            primary={{ label: 'Restart Daylens', onClick: () => void ipc.app.relaunch() }}
          >
            <div className="ob-callout">
              <div className="onboarding-handoff-beam" aria-hidden="true"><div className="onboarding-handoff-pulse" /></div>
              <div>
                <div className="ob-callout-title">What happens next</div>
                <div className="ob-callout-body">Daylens closes and reopens. Your setup picks up exactly where you left it, no data resets, no lost progress.</div>
              </div>
            </div>
          </Stage>
        )

      case 'verifying_permission':
        return (
          <Stage
            {...railProps}
            expression="watch"
            eyebrow={eyebrow}
            title="Checking in with macOS…"
            subtitle="Warming up the tracker. This takes a second or two."
            contentKey="verifying"
          >
            <div className="ob-callout">
              <div className="onboarding-breath" aria-hidden="true"><span /><span /><span /></div>
              <div>
                <div className="ob-callout-title">Verifying capture permissions</div>
                <div className="ob-callout-body">If it takes longer, macOS may not have saved the toggle, and we'll recover automatically.</div>
              </div>
            </div>
          </Stage>
        )

      case 'proof':
        return (
          <Stage
            {...railProps}
            expression={proof.ready ? 'happy' : 'watch'}
            eyebrow={eyebrow}
            title={proof.ready ? "Here's what I can already see" : 'Watching for your first signal…'}
            subtitle={proof.ready
              ? 'Real activity from this machine, captured the Daylens way, not a canned demo.'
              : 'No fake progress bars. The moment real work shows up, it lands right here.'}
            contentKey={proof.ready ? 'proof-ready' : 'proof-wait'}
            primary={{ label: proof.ready ? 'Continue' : 'Waiting for the first signal…', onClick: () => void continueFromProof(), disabled: !proof.ready }}
          >
            {proof.ready ? (
              <div className="onboarding-live-activity">
                {proof.liveSession && (
                  <div className="onboarding-live-row onboarding-live-row-active">
                    <div className="onboarding-live-pulse" aria-hidden="true" />
                    <div>
                      <div className="onboarding-live-app">{proof.liveSession.appName}</div>
                      {proof.liveSession.windowTitle && (
                        <div className="onboarding-live-title">{proof.liveSession.windowTitle}</div>
                      )}
                    </div>
                  </div>
                )}
                {proof.timeline && proof.timeline.totalSeconds > 0 && (
                  <div className="onboarding-live-row">
                    <div className="onboarding-live-stat">{Math.round(proof.timeline.totalSeconds / 60)}m</div>
                    <div className="onboarding-live-label">tracked today across {proof.timeline.blocks.length} session{proof.timeline.blocks.length !== 1 ? 's' : ''}</div>
                  </div>
                )}
                {proof.timeline && proof.timeline.siteCount > 0 && (
                  <div className="onboarding-live-row">
                    <div className="onboarding-live-stat">{proof.timeline.siteCount}</div>
                    <div className="onboarding-live-label">browser site{proof.timeline.siteCount !== 1 ? 's' : ''} already flowing in</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="ob-proof-pending">
                {proofLoadError ? (
                  <p>Daylens could not check the first signal yet: {proofLoadError}. It will retry automatically.</p>
                ) : (
                  <div className="onboarding-breath" aria-hidden="true"><span /><span /><span /></div>
                )}
                {!proofLoadError && isLinux && linuxTracking && linuxTracking.supportLevel !== 'ready' ? (
                  <p>{linuxTracking.supportMessage} Open Settings → Capture health after setup for the full picture.</p>
                ) : !proofLoadError ? (
                  <p>Go about your day. Daylens keeps listening for real work signal.</p>
                ) : null}
              </div>
            )}
          </Stage>
        )

      case 'tour': {
        const isLast = tourIndex >= STORY_BEATS.length - 1
        return (
          <Stage
            {...railProps}
            expression={isLast ? 'happy' : 'watch'}
            eyebrow={eyebrow}
            title="One ordinary day, told back to you"
            subtitle="This is how Daylens turns scattered apps into a day you'd actually recognise."
            contentKey="tour"
            primary={{ label: isLast ? 'Make it mine' : tourIndex === 0 ? 'Begin' : 'Continue', onClick: () => advanceTour() }}
            skip={{ label: 'Skip the tour', onClick: () => void persistOnboarding('superpowers') }}
          >
            <TourStory index={tourIndex} name={greetName} />
          </Stage>
        )
      }

      case 'superpowers':
        return (
          <Stage
            {...railProps}
            expression="happy"
            eyebrow={eyebrow}
            title="Things only Daylens can answer"
            subtitle="ChatGPT can write you a poem. It just has no clue what you actually did on Tuesday. Daylens does."
            contentKey="superpowers"
            primary={{ label: 'Love it, keep going', onClick: () => continueFromSuperpowers() }}
            skip={{ label: 'Skip', onClick: () => continueFromSuperpowers() }}
          >
            <div className="ob-super">
              {SUPERPOWERS.map((s, i) => (
                <div key={s.you} className="ob-super-row" style={{ animationDelay: `${i * 0.12}s` }}>
                  <div className="ob-super-you">“{s.you}”</div>
                  <div className="ob-super-them"><span className="ob-super-x">ChatGPT</span> {s.them}</div>
                </div>
              ))}
            </div>
          </Stage>
        )

      case 'about':
        return (
          <Stage
            {...railProps}
            expression="curious"
            eyebrow={eyebrow}
            title={`A little about you${greetName ? `, ${greetName}` : ''}`}
            subtitle="So your recaps sound like your work, not a stranger's. Pick all that fit."
            contentKey="about"
            primary={{ label: 'Continue', onClick: () => void continueFromAbout() }}
          >
            <div className="ob-section">
              <div className="ob-label">What do you do? <span className="ob-label-opt">pick any</span></div>
              <div className="ob-chipwrap">
                {ROLES.map((r) => {
                  const selected = roleIds.has(r.id)
                  return (
                    <button key={r.id} className={`ob-chip${selected ? ' is-selected' : ''}`} onClick={() => toggleRole(r)}>
                      <span className="ob-chip-emoji">{r.emoji}</span> {r.label}
                    </button>
                  )
                })}
              </div>
              <div className="ob-quip-slot">
                {roleQuip
                  ? <div className="ob-quip" key={roleQuip}>{roleQuip}</div>
                  : roleIds.size > 0 && <div className="ob-reflect">Got it. Daylens will tune your day for {userRoleLabel.toLowerCase()} work. ✨</div>}
              </div>
            </div>

            <div className="ob-section">
              <div className="ob-label">Why are you here? <span className="ob-label-opt">optional</span></div>
              <div className="ob-chipwrap">
                {INTENTS.map((intent) => {
                  const selected = goals.has(intent.id)
                  return (
                    <button key={intent.id} className={`ob-chip${selected ? ' is-selected' : ''}`} onClick={() => toggleIntent(intent.id)}>
                      {intent.label}
                    </button>
                  )
                })}
              </div>
              <textarea
                value={intentDraft}
                onChange={(e) => setIntentDraft(e.target.value)}
                placeholder="Tap a few above, or write it in your own words…"
                maxLength={400}
                rows={2}
                className="ob-textarea"
              />
            </div>
          </Stage>
        )

      case 'voice':
        return (
          <Stage
            {...railProps}
            expression="happy"
            eyebrow={eyebrow}
            title="How should Daylens sound?"
            subtitle="The same day, three voices. This really does change how every recap reads, so pick the one that feels like you."
            contentKey="voice"
            primary={{ label: 'Continue', onClick: () => void continueFromVoice() }}
            note="Change anytime in Settings"
          >
            <div className="ob-cards">
              {VOICE_SAMPLES.map((v) => {
                const selected = summaryVoice === v.voice
                return (
                  <button
                    key={v.voice}
                    className={`ob-card${selected ? ' is-selected' : ''}`}
                    onClick={() => void chooseVoice(v.voice)}
                    aria-pressed={selected}
                  >
                    <div className="ob-card-head">
                      <span className="ob-card-title">{v.label}</span>
                      <span className="ob-card-tag">{v.tagline}</span>
                      {selected && <span className="ob-card-check">✓</span>}
                    </div>
                    <div className="ob-card-body">{v.sample}</div>
                  </button>
                )
              })}
            </div>
          </Stage>
        )

      case 'work':
        return (
          <Stage
            {...railProps}
            expression="idle"
            eyebrow={eyebrow}
            title="What counts as real work?"
            subtitle="Pick what matters to you, and which of your own apps are the real thing. Daylens uses this to name your day."
            contentKey="work"
            primary={{ label: 'Continue', onClick: () => void continueFromWork() }}
          >
            <div className="ob-section">
              <div className="ob-label">What do you most want to see?</div>
              <div className="ob-chipwrap">
                {INTEREST_CATEGORIES.map((c) => {
                  const selected = interestedCategories.has(c.id)
                  return (
                    <button key={c.id} className={`ob-chip${selected ? ' is-selected' : ''}`} onClick={() => toggleInSet(c.id, setInterestedCategories)}>
                      <span className="ob-chip-emoji">{c.emoji}</span> {c.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="ob-section">
              <div className="ob-label">Which of your apps are real work?</div>
              <div className="ob-hint">{topApps.length > 0 ? 'Pulled from what you actually use most.' : 'A few common ones to start; your real apps replace these as you go.'}</div>
              <div className="ob-chipwrap">
                {appChoices.map((app) => {
                  const selected = focusApps.has(app)
                  return (
                    <button key={app} className={`ob-chip${selected ? ' is-selected' : ''}`} onClick={() => toggleInSet(app, setFocusApps)}>
                      {app}
                    </button>
                  )
                })}
                {customFocusApps.map((app) => (
                  <button key={app} className="ob-chip is-selected" onClick={() => toggleInSet(app, setFocusApps)}>
                    {app}
                  </button>
                ))}
              </div>
              <AddItemRow
                value={customAppDraft}
                onChange={setCustomAppDraft}
                onAdd={addCustomApp}
                placeholder="Add one: Excel, PowerPoint, Premiere…"
                maxLength={60}
              />
              <div className="ob-hint ob-hint-wink">Don't see your favorite app? Add it, or don't. Daylens tracks them all anyway. I just got tired of listing them. 😅</div>
            </div>
          </Stage>
        )

      case 'connections':
        return (
          <Stage
            {...railProps}
            expression="curious"
            eyebrow={eyebrow}
            title="Who you work with, and when"
            subtitle="Optional, and it helps Daylens group your time by client and time your morning brief right."
            contentKey="connections"
            primary={{ label: 'Continue', onClick: () => void continueFromConnections() }}
            skip={{ label: 'Skip', onClick: () => void continueFromConnections() }}
          >
            <div className="ob-section">
              <div className="ob-label">Add your clients or projects <span className="ob-label-opt">optional</span></div>
              <div className="ob-hint">Name the ones you bill or want time grouped under. Daylens then spots them in your window titles and docs, so it can tell you "3.5h on Acme this week" without you logging a thing.</div>
              <AddItemRow
                value={clientDraft}
                onChange={setClientDraft}
                onAdd={addClient}
                placeholder="Type a client or project name…"
                maxLength={80}
              />
              {clients.length === 0 && <div className="ob-hint ob-hint-quiet">Nothing here yet. Add as many as you like, or skip and add them later.</div>}
              <TokenChips
                items={clients}
                kind="token"
                onRemove={(client) => setClients((current) => current.filter((item) => item !== client))}
                removeLabel={(client) => `Remove ${client}`}
              />
            </div>

            <div className="ob-section">
              <div className="ob-label">When do you usually work?</div>
              <div className="ob-cards ob-cards-tight">
                {RHYTHMS.map((r) => {
                  const selected = workRhythm === r.id
                  return (
                    <button
                      key={r.id}
                      className={`ob-card ob-card-row${selected ? ' is-selected' : ''}`}
                      onClick={() => setWorkRhythm(selected ? undefined : r.id)}
                      aria-pressed={selected}
                    >
                      <span className="ob-card-emoji">{r.emoji}</span>
                      <span className="ob-card-rowtext">
                        <span className="ob-card-title">{r.label}</span>
                        <span className="ob-card-tag">{r.hint}</span>
                      </span>
                      {selected && <span className="ob-card-check">✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          </Stage>
        )

      case 'privacy':
        return (
          <Stage
            {...railProps}
            expression="idle"
            eyebrow={eyebrow}
            title="Anything to keep private?"
            subtitle="Name any app or website Daylens should never track. Nothing here is ever recorded, and you can change it anytime in Settings."
            contentKey="privacy"
            primary={{ label: 'Continue', onClick: () => void continueFromPrivacy() }}
            skip={excludedApps.size > 0 ? undefined : { label: 'Nothing to hide', onClick: () => void continueFromPrivacy() }}
          >
            <div className="ob-section">
              <div className="ob-addbox">
                <AddItemRow
                  value={privateDraft}
                  onChange={setPrivateDraft}
                  onAdd={addPrivateApp}
                  placeholder="Start typing an app or site… (Messages, reddit.com)"
                  maxLength={80}
                  buttonLabel="Keep private"
                />
                {privateMatches.length > 0 && (
                  <div className="ob-suggest">
                    {privateMatches.map((app) => (
                      <button key={app} className="ob-suggest-item" onClick={() => addPrivateApp(app)}>
                        <span>{app}</span><span className="ob-suggest-plus">+</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <TokenChips
                items={Array.from(excludedApps)}
                kind="private"
                onRemove={(app) => toggleInSet(app, setExcludedApps)}
                removeLabel={(app) => `Stop keeping ${app} private`}
              />
            </div>
          </Stage>
        )

      case 'ai_setup':
        return (
          <Stage
            {...railProps}
            expression="happy"
            eyebrow={eyebrow}
            title={managedAvailable ? "Pick how you'll power AI" : 'Turn on Daylens AI'}
            subtitle={managedAvailable
              ? 'Start free on us, go unlimited when you want, or bring your own key. Capture and your timeline work without any of this.'
              : 'Connect a provider so Daylens can answer questions about your work. Capture and your timeline work fully without it.'}
            contentKey="ai"
            primary={{ label: 'Continue', onClick: () => void continueFromAiSetup(), disabled: busy }}
            note="Change anytime in Settings"
          >
            {managedAvailable && (
              <>
                <div className="ob-plan ob-plan-free">
                  <div className="ob-plan-head">
                    <span className="ob-plan-name">Free, on us</span>
                    <span className="ob-plan-badge">$5 once</span>
                  </div>
                  <div className="ob-plan-body">$5 of AI credit to get started. No card, no key. You are on this the moment you open Daylens.</div>
                </div>
                <div className="ob-plan ob-plan-plus">
                  <div className="ob-plan-head">
                    <span className="ob-plan-name">Daylens Plus</span>
                    <span className="ob-plan-badge ob-plan-badge-plus">Unlimited</span>
                  </div>
                  <div className="ob-plan-body">Unlimited AI chat, deeper weekly and monthly wraps, and bigger questions across your whole history.</div>
                  <button className="ob-btn-primary ob-btn-sm" onClick={() => void openCheckout()} disabled={billingBusy}>
                    {billingBusy ? 'Opening…' : 'Subscribe to Plus'}
                  </button>
                </div>
              </>
            )}

            <details className="ob-ai-byok" open={!managedAvailable}>
              <summary>
                <span className="ob-ai-byok-title">Bring your own AI</span>
                <span className="ob-ai-byok-sub">Use an API key, or route through your local Claude, ChatGPT or Gemini CLI if it is installed.</span>
              </summary>
              <div className="ob-ai-byok-body">
                <ConnectAI
                  variant="embedded"
                  initialProvider={settings.aiProvider}
                  hasSavedAccess={aiConnected}
                  onConnected={() => setAiConnected(true)}
                />
              </div>
            </details>

            <div className="ob-callout">
              <div>
                <div className="ob-callout-title">Morning briefs and evening wraps</div>
                <div className="ob-callout-body">
                  Daylens can nudge you at the start and end of your day, plus warn when focus drifts. We need notification permission before you finish setup.
                </div>
              </div>
              <div className={`ob-status ob-status-${notificationStatusTone}`} style={{ marginTop: 12 }}>
                <span className="ob-status-dot" />
                <span className="ob-status-label">{notificationStatusLabel}</span>
              </div>
              <NotificationPermissionButton
                permission={notificationPermission}
                busy={busy}
                onRequest={requestNotificationPermission}
                onOpenSettings={openNotificationSettings}
              />
              {notificationPermission === 'denied' && (
                <div className="ob-callout-body" style={{ marginTop: 8 }}>
                  Notifications are off for Daylens. Open your system's notification settings and allow alerts for Daylens.
                </div>
              )}
            </div>
          </Stage>
        )

      case 'ready':
        return (
          <Stage
            {...railProps}
            expression="happy"
            eyebrow={eyebrow}
            title={greetName ? `You're all set, ${greetName}` : "You're all set"}
            subtitle="Daylens is watching quietly in the background. Here's what I learned about you, so your timeline names every stretch by what you were actually doing."
            centered
            contentKey="ready"
            primary={{ label: busy ? 'Opening Daylens…' : 'Open Daylens', onClick: () => void finishOnboarding(), disabled: busy }}
          >
            <div className="ob-ready-recap">
              <div className="ob-ready-recap-label">Your evening recaps will sound like this</div>
              <div className="ob-ready-recap-body">{voiceSample?.sample}</div>
            </div>

            <div className="ob-profile">
              {userRoleLabel && <div className="ob-profile-row"><span>You</span><strong>{userRoleLabel}</strong></div>}
              {voiceSample && <div className="ob-profile-row"><span>Voice</span><strong>{voiceSample.label}</strong></div>}
              {focusApps.size > 0 && <div className="ob-profile-row"><span>Real work</span><strong>{Array.from(focusApps).slice(0, 3).join(', ')}{focusApps.size > 3 ? ` +${focusApps.size - 3}` : ''}</strong></div>}
              {clients.length > 0 && <div className="ob-profile-row"><span>Clients</span><strong>{clients.slice(0, 3).join(', ')}{clients.length > 3 ? ` +${clients.length - 3}` : ''}</strong></div>}
              {excludedApps.size > 0 && <div className="ob-profile-row"><span>Private</span><strong>🔒 {excludedApps.size} app{excludedApps.size !== 1 ? 's' : ''}</strong></div>}
            </div>

            <div className="ob-try">
              <div className="ob-label">New here? Try asking Daylens</div>
              {READY_QUESTIONS.map((q) => (
                <div key={q} className="ob-try-chip">{q}</div>
              ))}
            </div>

            {notificationPermission !== 'granted' && notificationPermission !== 'unsupported' && (
              <div className="ob-callout" style={{ marginTop: 16 }}>
                <div className="ob-callout-title">Notifications still off</div>
                <div className="ob-callout-body">
                  {notificationPermission === 'denied'
                    ? "Daylens cannot send morning briefs or evening wraps until you allow Daylens in your system's notification settings."
                    : 'Allow notifications so Daylens can reach you with briefs, wraps, and focus nudges.'}
                </div>
                <NotificationPermissionButton
                  permission={notificationPermission}
                  busy={busy}
                  onRequest={requestNotificationPermission}
                  onOpenSettings={openNotificationSettings}
                />
              </div>
            )}
          </Stage>
        )

      default:
        return null
    }
  }

  return (
    <div className="ob-root">
      {renderStage()}
      {errorMessage && <div className="ob-error">{errorMessage}</div>}
      <style>{ONBOARDING_CSS}</style>
    </div>
  )
}

const ONBOARDING_CSS = `
/* ── Surround: a designed, warm backdrop — light card never floats in a void ── */
.ob-root {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  -webkit-app-region: drag;
  background:
    radial-gradient(120% 80% at 12% 0%, rgba(111,134,240,0.16), transparent 52%),
    radial-gradient(120% 80% at 100% 8%, rgba(200,167,239,0.16), transparent 50%),
    radial-gradient(140% 120% at 50% 120%, rgba(90,179,255,0.10), transparent 60%),
    #f4f5fb;
  /* Pin a light palette so embedded pieces (ConnectAI) never render light-on-dark. */
  --color-surface: #ffffff;
  --color-surface-low: #fafbff;
  --color-surface-container: #ffffff;
  --color-surface-high: #f3f4fa;
  --color-surface-highest: #e9ebf4;
  --color-surface-card: #ffffff;
  --color-border-ghost: rgba(17,24,39,0.12);
  --color-text-primary: #1f2633;
  --color-text-secondary: #5c6474;
  --color-text-tertiary: #8b93a3;
  --color-primary: #4f6ef0;
  --color-primary-contrast: #ffffff;
  --color-accent: #4f6ef0;
  --color-accent-dim: rgba(79,110,240,0.10);
  --color-focus-green: #0f766e;
  --gradient-primary: linear-gradient(135deg, #6f86f0 0%, #5ab3ff 100%);
  --ob-ink: #1f2633;
  --ob-ink-2: #5c6474;
  --ob-ink-3: #8b93a3;
  --ob-line: rgba(17,24,39,0.10);
  --ob-accent: #4f6ef0;
  --ob-grad: linear-gradient(135deg, #6f86f0 0%, #5ab3ff 100%);
  font-feature-settings: 'cv01','ss01';
}

/* ── The stage: fixed size, identical every screen, footer always visible ── */
.ob-stage {
  -webkit-app-region: no-drag;
  position: relative;
  width: clamp(520px, 94vw, 600px);
  height: min(680px, calc(100vh - 40px));
  background: #ffffff;
  border: 1px solid rgba(17,24,39,0.07);
  border-radius: 26px;
  box-shadow: 0 30px 80px rgba(26,33,68,0.18), 0 2px 8px rgba(26,33,68,0.06);
  overflow: hidden;
  display: grid;
  grid-template-rows: auto 1fr auto;
}
/* the one recurring flourish: an aurora bleed at the top of the stage */
.ob-stage::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 180px;
  background:
    radial-gradient(120% 150% at 0% 0%, #6f86f0 0%, rgba(111,134,240,0) 55%),
    radial-gradient(120% 150% at 100% 0%, #c8a7ef 0%, rgba(200,167,239,0) 56%),
    radial-gradient(130% 130% at 50% 0%, #dfe4ff 0%, rgba(223,228,255,0) 60%);
  opacity: 0.5;
  filter: blur(20px);
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.35) 55%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.35) 55%, transparent 100%);
  pointer-events: none; z-index: 0;
}
.ob-stage > * { position: relative; z-index: 1; }

/* rail: back + progress segments */
.ob-rail { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 22px 0; }
.ob-back {
  -webkit-app-region: no-drag; background: none; border: none; cursor: pointer;
  color: var(--ob-ink-3); font-size: 12.5px; font-weight: 650; padding: 4px 8px; margin-left: -8px;
  border-radius: 8px; transition: color 140ms ease, background 140ms ease;
}
.ob-back:hover { color: var(--ob-ink); background: rgba(17,24,39,0.05); }
.ob-back-ph { width: 1px; height: 1px; }
.ob-rail-right { display: flex; align-items: center; gap: 14px; }
.ob-help {
  -webkit-app-region: no-drag; display: inline-flex; align-items: center; gap: 5px;
  background: none; border: none; cursor: pointer; color: var(--ob-ink-3);
  font-size: 12.5px; font-weight: 650; padding: 4px 8px; margin-right: -8px;
  border-radius: 8px; transition: color 140ms ease, background 140ms ease;
}
.ob-help:hover { color: var(--ob-ink); background: rgba(17,24,39,0.05); }
.ob-progress { display: flex; align-items: center; gap: 5px; }
.ob-seg { width: 14px; height: 5px; border-radius: 999px; background: rgba(17,24,39,0.10); transition: width 320ms ease, background 320ms ease; }
.ob-seg.is-done { background: rgba(79,110,240,0.42); }
.ob-seg.is-active { width: 26px; background: var(--ob-grad); }

/* header zone — same place every screen, Lumen a persistent companion */
/* normal (non-hero) middle: fixed header + scrolling content */
.ob-body { min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.ob-header { display: grid; grid-template-columns: 54px 1fr; gap: 14px; align-items: start; padding: 14px 26px 16px; }
.ob-lumen { width: 54px; height: 54px; display: inline-grid; place-items: center; }
/* hero middle: Lumen + title + content as one centred column */
.ob-content-hero { text-align: center; }
.ob-hero { display: grid; justify-items: center; gap: 13px; width: 100%; max-width: 44ch; margin: 0 auto; }
.ob-hero .ob-title { margin: 2px 0 0; }
.ob-hero .ob-sub { margin: 0 auto; }
.ob-hero .ob-name-field { width: min(360px, 100%); margin-top: 4px; }
.ob-lumen-hero { display: inline-grid; place-items: center; margin-bottom: 2px; }
.ob-headtext { min-width: 0; padding-top: 1px; }
.ob-eyebrow { font-size: 10.5px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ob-accent); opacity: 0.85; }
.ob-title { margin: 6px 0 0; font-size: 25px; line-height: 1.14; letter-spacing: -0.02em; color: var(--ob-ink); font-weight: 760; }
.ob-wave { display: inline-block; animation: obWave 1.8s ease-in-out infinite; transform-origin: 70% 70%; }
.ob-sub { margin: 8px 0 0; font-size: 14.5px; line-height: 1.6; color: var(--ob-ink-2); max-width: 52ch; }

/* content zone — the ONLY changing part; scrolls inside the frame with soft fades */
.ob-content {
  overflow-y: auto; overflow-x: hidden;
  padding: 4px 26px 8px;
  /* max-content auto-rows so an overflow:hidden child (profile, settings mock,
     BYOK panel) can never collapse below its content and clip; the frame
     scrolls instead. "safe center" vertically centres short screens but falls
     back to top-aligned scrolling the moment content would overflow. */
  display: grid; align-content: safe center; grid-auto-rows: max-content; gap: 18px;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%);
  scrollbar-width: thin; scrollbar-color: rgba(17,24,39,0.18) transparent;
  animation: obContentIn 380ms cubic-bezier(.2,.8,.2,1) both;
}
.ob-content::-webkit-scrollbar { width: 7px; }
.ob-content::-webkit-scrollbar-thumb { background: rgba(17,24,39,0.16); border-radius: 999px; }
.ob-content-center { justify-items: center; text-align: center; }
.ob-content-center .ob-name-field { width: min(360px, 100%); }

/* footer — pinned, never scrolls away */
.ob-footer {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 26px 18px;
  border-top: 1px solid rgba(17,24,39,0.06);
  background: linear-gradient(180deg, rgba(255,255,255,0), #ffffff 40%);
}
.ob-footer-spacer { flex: 1 1 auto; }
.ob-note { font-size: 11.5px; color: var(--ob-ink-3); }
.ob-skip {
  -webkit-app-region: no-drag; background: none; border: none; cursor: pointer;
  color: var(--ob-ink-3); font-size: 12.5px; padding: 6px 6px; border-radius: 8px;
  transition: color 140ms ease;
}
.ob-skip:hover { color: var(--ob-ink-2); }

/* buttons */
.ob-btn-primary, .ob-btn-secondary {
  -webkit-app-region: no-drag; height: 42px; padding: 0 20px; border-radius: 12px;
  font-size: 13.5px; font-weight: 720; cursor: pointer;
  transition: transform 140ms ease, box-shadow 180ms ease, border-color 140ms ease, opacity 140ms ease;
}
.ob-btn-primary { border: none; background: var(--ob-grad); color: #fff; box-shadow: 0 10px 26px rgba(79,110,240,0.30); }
.ob-btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 16px 34px rgba(79,110,240,0.40); }
.ob-btn-primary:disabled { opacity: 0.5; cursor: default; box-shadow: none; }
.ob-btn-secondary { background: #fff; border: 1px solid var(--ob-line); color: var(--ob-ink); }
.ob-btn-secondary:hover:not(:disabled) { border-color: rgba(79,110,240,0.45); }
.ob-btn-secondary:disabled { opacity: 0.5; cursor: default; }
.ob-btn-sm { height: 38px; font-size: 12.5px; padding: 0 16px; }

/* name + inputs */
.ob-name-field input {
  width: 100%; border: 1px solid var(--ob-line); border-radius: 14px; background: #fff;
  color: var(--ob-ink); padding: 13px 16px; font-size: 16px; font-weight: 600; outline: none;
  text-align: center; transition: border-color 140ms ease, box-shadow 140ms ease;
}
.ob-name-field input::placeholder { color: #a2a8b4; font-weight: 500; }
.ob-name-field input:focus { border-color: rgba(79,110,240,0.6); box-shadow: 0 0 0 4px rgba(79,110,240,0.12); }
.ob-reassure { margin: 0; font-size: 11.5px; color: var(--ob-ink-3); }

.ob-input {
  flex: 1 1 auto; min-width: 0; border: 1px solid var(--ob-line); border-radius: 12px; background: #fff;
  color: var(--ob-ink); padding: 11px 14px; font-size: 14px; outline: none;
  transition: border-color 140ms ease;
}
.ob-input:focus { border-color: rgba(79,110,240,0.55); }
.ob-textarea {
  width: 100%; resize: none; font-family: inherit; border: 1px solid var(--ob-line); border-radius: 12px;
  background: #fff; color: var(--ob-ink); padding: 11px 14px; font-size: 14px; line-height: 1.6; outline: none;
}
.ob-textarea:focus { border-color: rgba(79,110,240,0.55); }
.ob-addrow { display: flex; gap: 8px; }
.ob-add-btn {
  -webkit-app-region: no-drag; flex-shrink: 0; height: 42px; padding: 0 16px; border-radius: 12px;
  border: 1px solid var(--ob-line); background: #fff; color: var(--ob-ink); font-size: 13px; font-weight: 700; cursor: pointer;
  transition: border-color 140ms ease, opacity 140ms ease;
}
.ob-add-btn:hover:not(:disabled) { border-color: rgba(79,110,240,0.45); }
.ob-add-btn:disabled { opacity: 0.45; cursor: default; }

/* sections & labels — one spacing rhythm */
.ob-section { display: grid; gap: 10px; }
.ob-label { font-size: 13.5px; font-weight: 700; color: var(--ob-ink); }
.ob-label-opt { font-size: 11px; font-weight: 600; color: var(--ob-ink-3); text-transform: none; letter-spacing: 0; }
.ob-hint { font-size: 12.5px; line-height: 1.5; color: var(--ob-ink-3); margin-top: -4px; }
.ob-hint-quiet { color: var(--ob-ink-3); opacity: 0.8; }
.ob-hint-wink { color: var(--ob-ink-3); font-style: italic; margin-top: 2px; }
.ob-reflect { font-size: 12.5px; color: var(--ob-accent); font-weight: 600; animation: obContentIn 280ms ease both; }

/* Duolingo-style joke toast: fades up from the bottom, then away on its own. */
.ob-quip-slot { min-height: 22px; }
.ob-quip {
  display: inline-block; font-size: 12.5px; font-weight: 650; color: #8a4b16;
  background: linear-gradient(180deg, #fff5e6, #ffeccf); border: 1px solid rgba(214,140,40,0.3);
  padding: 8px 13px; border-radius: 12px; box-shadow: 0 8px 22px rgba(214,140,40,0.18);
  animation: obQuipIn 360ms cubic-bezier(.2,1.2,.3,1) both;
}
@keyframes obQuipIn { from { opacity: 0; transform: translateY(14px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }

/* keep-private autosuggest */
.ob-addbox { position: relative; display: grid; gap: 0; }
.ob-suggest {
  margin-top: 8px; display: grid; gap: 2px; border: 1px solid var(--ob-line); border-radius: 12px;
  background: #fff; overflow: hidden; box-shadow: 0 10px 26px rgba(26,33,68,0.08);
}
.ob-suggest-item {
  -webkit-app-region: no-drag; display: flex; align-items: center; justify-content: space-between;
  border: none; background: transparent; cursor: pointer; padding: 10px 14px; font-size: 13.5px;
  color: var(--ob-ink); text-align: left; transition: background 120ms ease;
}
.ob-suggest-item:hover { background: #f5f7ff; }
.ob-suggest-plus { color: var(--ob-accent); font-weight: 800; }

/* AI plan cards */
.ob-plan { padding: 15px 16px; border-radius: 16px; border: 1px solid var(--ob-line); background: #fff; display: grid; gap: 7px; }
.ob-plan-free { border-color: rgba(79,110,240,0.3); background: linear-gradient(180deg, rgba(79,110,240,0.07), rgba(90,179,255,0.03)); }
.ob-plan-plus { border-color: rgba(178,120,240,0.32); background: linear-gradient(180deg, rgba(178,120,240,0.06), rgba(111,134,240,0.03)); }
.ob-plan-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ob-plan-name { font-size: 14.5px; font-weight: 760; color: var(--ob-ink); }
.ob-plan-badge { font-size: 11.5px; font-weight: 800; color: #2a3da8; background: rgba(79,110,240,0.12); padding: 3px 10px; border-radius: 999px; }
.ob-plan-badge-plus { color: #6b32b0; background: rgba(178,120,240,0.14); }
.ob-plan-body { font-size: 13px; line-height: 1.55; color: var(--ob-ink-2); }
.ob-plan-plus .ob-btn-primary { margin-top: 4px; justify-self: start; background: linear-gradient(135deg, #8a7cff 0%, #6f86f0 100%); }

/* superpowers: things only Daylens can answer */
.ob-super { display: grid; gap: 12px; }
.ob-super-row { padding: 14px 16px; border-radius: 16px; border: 1px solid var(--ob-line); background: #fff; box-shadow: 0 6px 18px rgba(26,33,68,0.05); animation: obFadeUp 420ms cubic-bezier(.2,.8,.2,1) both; }
.ob-super-you { font-size: 14.5px; font-weight: 680; color: var(--ob-ink); line-height: 1.5; }
.ob-super-them { margin-top: 7px; font-size: 12.5px; line-height: 1.5; color: var(--ob-ink-3); }
.ob-super-x { display: inline-block; font-size: 10.5px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: #9aa0ad; background: rgba(17,24,39,0.05); padding: 2px 7px; border-radius: 999px; margin-right: 4px; }

/* one chip language */
.ob-chipwrap { display: flex; flex-wrap: wrap; gap: 8px; }
.ob-chip {
  -webkit-app-region: no-drag; display: inline-flex; align-items: center; gap: 6px;
  min-height: 36px; padding: 8px 13px; border-radius: 10px; border: 1px solid var(--ob-line);
  background: #fff; color: var(--ob-ink); font-size: 13px; font-weight: 550; cursor: pointer; text-align: left;
  transition: border-color 150ms ease, background 150ms ease, transform 120ms ease;
}
.ob-chip:hover:not(.is-selected) { border-color: rgba(79,110,240,0.38); background: #f7f8ff; }
.ob-chip:active { transform: scale(0.98); }
.ob-chip.is-selected { border-color: rgba(79,110,240,0.6); background: rgba(79,110,240,0.10); color: #2a3da8; }
.ob-chip-emoji { font-size: 14px; }
.ob-chip.is-token { padding-right: 6px; background: rgba(79,110,240,0.08); border-color: rgba(79,110,240,0.30); color: #2a3da8; cursor: default; }
.ob-chip.is-private { padding-right: 6px; background: rgba(17,24,39,0.05); border-color: rgba(17,24,39,0.30); color: var(--ob-ink); cursor: default; }
.ob-chip.is-ghost { border-style: dashed; color: var(--ob-ink-2); background: transparent; }
.ob-chip.is-ghost:hover { border-color: rgba(17,24,39,0.32); background: rgba(17,24,39,0.03); }
.ob-token-x {
  -webkit-app-region: no-drag; border: none; background: rgba(17,24,39,0.10); color: var(--ob-ink-2);
  width: 18px; height: 18px; border-radius: 50%; cursor: pointer; font-size: 13px; line-height: 1;
  display: inline-grid; place-items: center; margin-left: 2px;
}
.ob-token-x:hover { background: rgba(17,24,39,0.18); }

/* one selection-card language (voice, rhythm, AI) */
.ob-cards { display: grid; gap: 10px; }
.ob-cards-tight { gap: 8px; }
.ob-card {
  -webkit-app-region: no-drag; display: grid; gap: 7px; text-align: left; cursor: pointer;
  padding: 14px 16px; border-radius: 14px; background: #fff; border: 1px solid var(--ob-line);
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease, transform 120ms ease;
}
.ob-card:hover:not(.is-selected) { border-color: rgba(79,110,240,0.35); background: #f9faff; }
.ob-card:active { transform: scale(0.995); }
.ob-card.is-selected { border-color: rgba(79,110,240,0.6); background: linear-gradient(180deg, rgba(79,110,240,0.07), rgba(90,179,255,0.03)); box-shadow: 0 8px 24px rgba(79,110,240,0.12); }
.ob-card-head { display: flex; align-items: center; gap: 8px; }
.ob-card-title { font-size: 14px; font-weight: 740; color: var(--ob-ink); }
.ob-card-tag { font-size: 11.5px; color: var(--ob-ink-3); }
.ob-card-check { margin-left: auto; color: var(--ob-accent); font-weight: 900; }
.ob-card-body { font-size: 13px; line-height: 1.6; color: var(--ob-ink-2); }
.ob-card-row { grid-template-columns: 26px 1fr auto; align-items: center; gap: 12px; }
.ob-card-emoji { font-size: 19px; }
.ob-card-rowtext { display: grid; gap: 2px; }

/* status (permission) */
.ob-status {
  display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 14px; border-radius: 12px; border: 1px solid var(--ob-line); background: #f7f8fb;
  font-size: 12.5px; color: var(--ob-ink-2);
}
.ob-status-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(140,150,170,0.55); }
.ob-status-ok .ob-status-dot { background: #1aa463; box-shadow: 0 0 0 3px rgba(26,164,99,0.16); }
.ob-status-waiting .ob-status-dot { background: #e0a020; animation: obPulse 1.6s ease-out infinite; }
.ob-status-label { font-weight: 650; color: var(--ob-ink); }
.ob-status-note { color: var(--ob-ink-3); }

/* callout (relaunch/verify) */
.ob-callout { display: grid; grid-template-columns: 110px 1fr; gap: 16px; align-items: center; padding: 16px; border-radius: 16px; border: 1px solid var(--ob-line); background: #fafbff; }
.ob-callout-title { font-size: 10.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ob-ink-3); }
.ob-callout-body { font-size: 13px; line-height: 1.6; color: var(--ob-ink-2); margin-top: 4px; }

/* proof */
.onboarding-live-activity { display: grid; gap: 14px; padding: 4px 0; }
.onboarding-live-row { display: flex; align-items: center; gap: 14px; }
.onboarding-live-row-active { padding: 4px 0 4px 13px; border-left: 3px solid var(--ob-accent); }
.onboarding-live-pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--ob-accent); flex-shrink: 0; box-shadow: 0 0 0 0 rgba(79,110,240,0.5); animation: obPulse 1.6s ease-out infinite; }
.onboarding-live-app { font-size: 15px; font-weight: 680; color: var(--ob-ink); }
.onboarding-live-title { font-size: 12.5px; color: var(--ob-ink-3); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 42ch; }
.onboarding-live-stat { font-size: 22px; font-weight: 740; color: var(--ob-ink); min-width: 44px; }
.onboarding-live-label { font-size: 13.5px; color: var(--ob-ink-2); }
.ob-proof-pending { display: grid; justify-items: start; gap: 12px; padding: 6px 0; }
.ob-proof-pending .onboarding-breath { justify-content: flex-start; height: auto; }
.ob-proof-pending p { margin: 0; color: var(--ob-ink); font-size: 19px; line-height: 1.45; max-width: 34ch; }

/* AI money moment */
.ob-ai-hero {
  position: relative; padding: 18px 18px 16px; border-radius: 16px;
  border: 1px solid rgba(79,110,240,0.28);
  background: linear-gradient(135deg, rgba(111,134,240,0.10), rgba(90,179,255,0.06));
  box-shadow: 0 10px 30px rgba(79,110,240,0.12);
}
.ob-ai-hero-badge {
  display: inline-block; font-size: 10.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
  color: #fff; background: var(--ob-grad); padding: 4px 10px; border-radius: 999px;
}
.ob-ai-hero-amount { margin-top: 10px; font-size: 34px; font-weight: 800; letter-spacing: -0.03em; color: var(--ob-ink); }
.ob-ai-hero-amount span { font-size: 15px; font-weight: 600; color: var(--ob-ink-2); margin-left: 6px; letter-spacing: 0; }
.ob-ai-hero-body { margin-top: 6px; font-size: 13px; line-height: 1.6; color: var(--ob-ink-2); max-width: 46ch; }
.ob-ai-hero-actions { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }
.ob-ai-byok { border: 1px solid var(--ob-line); border-radius: 14px; background: #fff; overflow: hidden; }
.ob-ai-byok > summary { list-style: none; cursor: pointer; padding: 14px 16px; display: grid; gap: 3px; }
.ob-ai-byok > summary::-webkit-details-marker { display: none; }
.ob-ai-byok-title { font-size: 14px; font-weight: 740; color: var(--ob-ink); }
.ob-ai-byok-sub { font-size: 12.5px; line-height: 1.55; color: var(--ob-ink-2); }
.ob-ai-byok[open] > summary { border-bottom: 1px solid var(--ob-line); }
.ob-ai-byok-body { padding: 16px; }

/* ready */
.ob-ready-recap { padding: 16px; border-radius: 16px; border: 1px solid rgba(79,110,240,0.30); background: linear-gradient(180deg, rgba(79,110,240,0.07), rgba(90,179,255,0.03)); box-shadow: 0 8px 24px rgba(79,110,240,0.12); text-align: left; }
.ob-ready-recap-label { font-size: 10.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ob-ink-3); }
.ob-ready-recap-body { margin-top: 8px; font-size: 14px; line-height: 1.6; color: var(--ob-ink); }
.ob-profile { display: grid; gap: 0; border: 1px solid var(--ob-line); border-radius: 14px; overflow: hidden; text-align: left; width: 100%; }
.ob-profile-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; font-size: 13px; border-top: 1px solid var(--ob-line); }
.ob-profile-row:first-child { border-top: none; }
.ob-profile-row span { color: var(--ob-ink-3); }
.ob-profile-row strong { color: var(--ob-ink); font-weight: 680; text-align: right; }
.ob-try { display: grid; gap: 8px; text-align: left; width: 100%; }
.ob-try-chip { font-size: 13px; color: var(--ob-ink-2); padding: 9px 13px; border-radius: 10px; border: 1px solid var(--ob-line); background: #fafbff; }

/* why story scenes */
.ob-why-scene { display: grid; place-items: center; min-height: 168px; padding: 6px 0; }
.ob-why-diary { position: relative; width: 230px; padding: 22px 20px 26px; border-radius: 16px; background: #fff; border: 1px solid var(--ob-line); box-shadow: 0 16px 40px rgba(26,33,68,0.12); display: grid; gap: 10px; animation: obContentIn 420ms ease both; }
.ob-why-diary-line { height: 9px; border-radius: 999px; background: rgba(17,24,39,0.10); }
.ob-why-diary-seal { position: absolute; right: -10px; bottom: -10px; font-size: 10.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: #fff; background: var(--ob-grad); padding: 6px 12px; border-radius: 999px; box-shadow: 0 8px 20px rgba(79,110,240,0.3); }
.ob-why-device { display: grid; place-items: center; }
.ob-why-device-screen { width: 168px; height: 104px; border-radius: 12px; background: linear-gradient(160deg, #eef1ff, #fff); border: 1px solid var(--ob-line); display: grid; place-items: center; box-shadow: 0 16px 40px rgba(26,33,68,0.12); }
.ob-why-lock { font-size: 34px; animation: obFloat 3s ease-in-out infinite; }
.ob-why-device-base { width: 200px; height: 9px; border-radius: 0 0 10px 10px; background: linear-gradient(180deg, #d9def0, #c7cde6); }
.ob-why-tags { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 16px; }
.ob-why-tag { font-size: 12px; font-weight: 600; color: var(--ob-ink-2); padding: 6px 12px; border-radius: 999px; background: #fff; border: 1px solid var(--ob-line); animation: obChipFloat 420ms cubic-bezier(.2,.8,.2,1) both; }
.ob-why-recap { width: min(380px, 100%); padding: 16px; border-radius: 16px; background: linear-gradient(180deg, rgba(79,110,240,0.07), rgba(90,179,255,0.03)); border: 1px solid rgba(79,110,240,0.3); box-shadow: 0 12px 32px rgba(79,110,240,0.12); animation: obContentIn 420ms ease both; }
.ob-why-recap-label { font-size: 10.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ob-ink-3); }
.ob-why-recap-body { margin-top: 8px; font-size: 14px; line-height: 1.6; color: var(--ob-ink); }
.ob-why-dots { display: flex; gap: 7px; justify-content: center; }
.ob-why-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(17,24,39,0.14); transition: all 280ms ease; }
.ob-why-dot.is-active { width: 22px; border-radius: 999px; background: var(--ob-grad); }

/* error */
.ob-error { position: absolute; bottom: 16px; max-width: 560px; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(220,80,80,0.3); background: #fff5f5; color: #b42323; font-size: 13px; line-height: 1.5; box-shadow: 0 10px 30px rgba(180,35,35,0.14); }

/* ── Tour / story (light) — reused from the narrated-day component ── */
.onboarding-story { display: grid; gap: 16px; }
.onboarding-daybar { display: grid; gap: 6px; }
.onboarding-daybar-track { position: relative; height: 4px; border-radius: 999px; background: rgba(17,24,39,0.08); }
.onboarding-daybar-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: linear-gradient(90deg, #f5c662, #5ab3ff 60%, #8a7cff); transition: width 420ms cubic-bezier(.2,.8,.2,1); }
.onboarding-daybar-marker { position: absolute; top: 50%; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: #4f6ef0; transform: translateY(-50%); box-shadow: 0 0 0 4px rgba(79,110,240,0.18); transition: left 420ms cubic-bezier(.2,.8,.2,1); }
.onboarding-daybar-ends { display: flex; justify-content: space-between; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ob-ink-3); }
.onboarding-story-scene { min-height: 132px; display: flex; flex-direction: column; justify-content: center; gap: 10px; animation: obContentIn 360ms ease both; }
.onboarding-story-caption { display: grid; gap: 4px; min-height: 48px; }
.onboarding-story-time { font-size: 11px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ob-accent); }
.onboarding-story-line { margin: 0; font-size: 16px; line-height: 1.5; color: var(--ob-ink); max-width: 46ch; }
.onboarding-story-stack { display: grid; gap: 8px; }
.onboarding-story-cap { font-size: 11.5px; color: var(--ob-ink-2); display: flex; align-items: center; gap: 7px; }
.onboarding-story-pill { font-size: 11px; font-weight: 600; color: var(--ob-ink); padding: 2px 9px; border-radius: 999px; background: rgba(17,24,39,0.05); border: 1px solid var(--ob-line); }
.onboarding-story-apps { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; padding: 14px 0; }
.onboarding-story-appchip { font-size: 13px; font-weight: 600; color: var(--ob-ink); padding: 10px 16px; border-radius: 12px; background: #fff; border: 1px solid var(--ob-line); animation: obChipFloat 420ms cubic-bezier(.2,.8,.2,1) both; }
.onboarding-story-intro { display: grid; gap: 8px; padding: 6px 0; }
.onboarding-story-ghost { height: 26px; border-radius: 9px; background: rgba(17,24,39,0.05); animation: obContentIn 500ms ease both; }
.onboarding-tour-block { border-radius: 10px; display: flex; align-items: center; padding: 0 12px; font-size: 12.5px; font-weight: 600; color: var(--ob-ink); box-shadow: inset 0 0 0 1px rgba(17,24,39,0.04); animation: obBlockIn 0.5s cubic-bezier(.2,.8,.2,1) both; }
.onboarding-tour-block[data-tone="a"] { background: linear-gradient(135deg, rgba(123,143,247,0.22), rgba(90,179,255,0.16)); }
.onboarding-tour-block[data-tone="c"] { background: linear-gradient(135deg, rgba(178,160,255,0.22), rgba(123,143,247,0.16)); }
.onboarding-tour-block-static { flex-direction: column; align-items: stretch; justify-content: center; gap: 10px; padding: 12px; width: 100%; text-align: left; }
.onboarding-tour-block-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.onboarding-tour-block-label { font-size: 13px; font-weight: 650; color: var(--ob-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.onboarding-tour-block-time { font-size: 11px; color: var(--ob-ink-3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.onboarding-tour-relabel { animation: obFadeUp 260ms ease both; }
.onboarding-tour-saved { flex-shrink: 0; font-size: 11px; font-weight: 700; color: var(--color-focus-green); animation: obFadeUp 240ms ease both; }
.onboarding-tour-notif { border-radius: 13px; border: 1px solid var(--ob-line); background: #fafbff; padding: 12px 14px; animation: obFadeUp 300ms ease both; }
.onboarding-tour-notif-head { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: var(--ob-ink-3); text-transform: uppercase; }
.onboarding-tour-notif-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ob-accent); }
.onboarding-tour-notif-body { margin-top: 7px; font-size: 13.5px; line-height: 1.55; color: var(--ob-ink); }
.onboarding-tour-stats { display: flex; gap: 10px; animation: obFadeUp 300ms ease both; }
.onboarding-tour-stats > div { flex: 1; text-align: center; border-radius: 11px; padding: 12px 6px; background: #fafbff; border: 1px solid var(--ob-line); }
.onboarding-tour-stats strong { display: block; font-size: 18px; font-weight: 760; color: var(--ob-ink); }
.onboarding-tour-stats span { font-size: 10.5px; color: var(--ob-ink-3); }
.onboarding-tour-chatlog { display: grid; gap: 8px; min-height: 96px; align-content: start; }
.onboarding-tour-bubble { font-size: 13px; line-height: 1.55; padding: 10px 13px; border-radius: 13px; max-width: 86%; }
.onboarding-tour-bubble-q { justify-self: end; background: var(--ob-grad); color: #fff; border-bottom-right-radius: 4px; }
.onboarding-tour-bubble-a { justify-self: start; background: #f3f4f6; color: var(--ob-ink); border: 1px solid var(--ob-line); border-bottom-left-radius: 4px; }
.onboarding-tour-thinking { display: inline-flex; gap: 5px; align-items: center; width: max-content; }
.onboarding-tour-thinking span { width: 7px; height: 7px; border-radius: 50%; background: rgba(79,110,240,0.55); animation: obBreath 1.2s ease-in-out infinite; }
.onboarding-tour-thinking span:nth-child(2) { animation-delay: 0.18s; }
.onboarding-tour-thinking span:nth-child(3) { animation-delay: 0.36s; }
.onboarding-tour-caret { display: inline-block; width: 7px; height: 14px; margin-left: 2px; vertical-align: -2px; background: var(--ob-accent); border-radius: 1px; animation: obCaret 0.9s steps(1) infinite; }
.onboarding-tour-privacy { font-size: 11.5px; color: #2a3da8; text-align: center; padding: 8px 12px; border-radius: 10px; background: rgba(79,110,240,0.07); border: 1px solid rgba(79,110,240,0.16); }

/* settings mock (permission) */
.onboarding-settings-mock { border-radius: 14px; border: 1px solid var(--ob-line); background: #fff; overflow: hidden; box-shadow: 0 14px 36px rgba(26,33,68,0.10); }
.onboarding-settings-mock-header { display: flex; align-items: center; gap: 6px; padding: 9px 12px; background: #f6f7fb; border-bottom: 1px solid rgba(17,24,39,0.05); }
.onboarding-settings-mock-dot { width: 10px; height: 10px; border-radius: 50%; }
.onboarding-settings-mock-title { margin-left: 8px; font-size: 10.5px; color: var(--ob-ink-2); font-weight: 600; }
.onboarding-settings-mock-body { padding: 8px 4px; }
.onboarding-settings-mock-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; margin: 0 6px; }
.onboarding-settings-mock-row-target { background: rgba(79,110,240,0.08); box-shadow: inset 0 0 0 1px rgba(79,110,240,0.32); animation: obMockHighlight 2.8s ease-in-out infinite; }
.onboarding-settings-mock-app { font-size: 12px; color: var(--ob-ink); font-weight: 500; }
.onboarding-settings-mock-badge { font-weight: 700; color: #2a3da8; }
.onboarding-settings-mock-toggle { width: 28px; height: 17px; border-radius: 999px; position: relative; }
.onboarding-settings-mock-toggle::after { content: ''; position: absolute; top: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.25); transition: left 240ms ease; }
.onboarding-settings-mock-toggle.on { background: #34c759; }
.onboarding-settings-mock-toggle.on::after { left: 13px; }
.onboarding-settings-mock-toggle.off { background: rgba(17,24,39,0.18); }
.onboarding-settings-mock-toggle.off::after { left: 2px; }
.onboarding-settings-mock-row-target .onboarding-settings-mock-toggle::after { animation: obToggleKnob 2.8s ease-in-out infinite; }
.onboarding-settings-mock-row-target .onboarding-settings-mock-toggle { animation: obToggleTease 2.8s ease-in-out infinite; }
.onboarding-settings-mock-hint { padding: 10px 14px 14px; font-size: 11px; color: var(--ob-ink-3); text-align: center; border-top: 1px solid rgba(17,24,39,0.05); }

/* handoff/verify visuals */
.onboarding-handoff-beam { height: 84px; border-radius: 12px; background: radial-gradient(circle at 50% 50%, rgba(79,110,240,0.18), transparent 65%); position: relative; overflow: hidden; }
.onboarding-handoff-pulse { position: absolute; inset: 0; background: linear-gradient(180deg, transparent, rgba(79,110,240,0.32), transparent); animation: obBeam 2.4s linear infinite; }
.onboarding-breath { height: 84px; display: flex; align-items: center; justify-content: center; gap: 10px; }
.onboarding-breath span { width: 10px; height: 10px; border-radius: 50%; background: var(--ob-grad); animation: obBreath 1.4s ease-in-out infinite; }
.onboarding-breath span:nth-child(2) { animation-delay: 0.2s; }
.onboarding-breath span:nth-child(3) { animation-delay: 0.4s; }

/* keyframes */
@keyframes obContentIn { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
@keyframes obFadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes obBlockIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
@keyframes obChipFloat { from { opacity: 0; transform: translateY(10px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes obPulse { 0% { box-shadow: 0 0 0 0 rgba(79,110,240,0.5); } 70% { box-shadow: 0 0 0 8px rgba(79,110,240,0); } 100% { box-shadow: 0 0 0 0 rgba(79,110,240,0); } }
@keyframes obBreath { 0%,100% { transform: scale(0.7); opacity: 0.5; } 50% { transform: scale(1); opacity: 1; } }
@keyframes obBeam { 0% { transform: translateY(-100%); } 100% { transform: translateY(100%); } }
@keyframes obCaret { 0%,50% { opacity: 1; } 50.01%,100% { opacity: 0; } }
@keyframes obWave { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(16deg); } 75% { transform: rotate(-8deg); } }
@keyframes obFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
@keyframes obMockHighlight { 0%,100% { box-shadow: inset 0 0 0 1px rgba(79,110,240,0.32); } 50% { box-shadow: inset 0 0 0 1px rgba(79,110,240,0.6), 0 0 0 2px rgba(79,110,240,0.16); } }
@keyframes obToggleTease { 0%,40% { background: rgba(17,24,39,0.18); } 50%,100% { background: #34c759; } }
@keyframes obToggleKnob { 0%,40% { left: 2px; } 50%,100% { left: 13px; } }

@media (prefers-reduced-motion: reduce) {
  .ob-content, .ob-wave, .ob-why-lock, .ob-why-tag, .onboarding-story-scene, .onboarding-story-appchip,
  .onboarding-tour-block, .onboarding-tour-notif, .onboarding-tour-stats, .onboarding-handoff-pulse,
  .onboarding-breath span, .onboarding-tour-thinking span, .onboarding-settings-mock-row-target,
  .onboarding-settings-mock-row-target .onboarding-settings-mock-toggle,
  .onboarding-settings-mock-row-target .onboarding-settings-mock-toggle::after,
  .onboarding-live-pulse, .ob-reflect, .ob-why-diary, .ob-why-recap, .ob-quip, .ob-super-row {
    animation: none !important;
  }
}

@media (max-height: 640px) {
  .ob-title { font-size: 22px; }
  .ob-sub { font-size: 13.5px; }
  .ob-header { padding-top: 10px; padding-bottom: 12px; }
}
`
