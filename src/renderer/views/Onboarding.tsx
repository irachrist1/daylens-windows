import { useEffect, useMemo, useRef, useState } from 'react'
import { ANALYTICS_EVENT, blockCountBucket, trackedTimeBucket } from '@shared/analytics'
import type { AppSettings, DayTimelinePayload, LiveSession, OnboardingStage, ProofState, TrackingPermissionState } from '@shared/types'
import { nextMacStageAfterGrantedPermission } from '@shared/onboarding'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { formatDuration, todayString } from '../lib/format'

const GOALS = [
  { id: 'deep-work', label: 'See where my focus actually went' },
  { id: 'understand-habits', label: 'Understand my work patterns' },
  { id: 'less-distraction', label: 'Spot noise before it takes over' },
  { id: 'ai-insights', label: 'Ask better questions about my week' },
]

const MAC_STEPS: Array<{ id: OnboardingStage[]; label: string }> = [
  { id: ['welcome'], label: 'Meet Daylens' },
  { id: ['permission', 'relaunch_required', 'verifying_permission'], label: 'Grant access' },
  { id: ['proof'], label: 'First signal' },
  { id: ['personalize'], label: 'Personalize' },
]

const NON_MAC_STEPS: Array<{ id: OnboardingStage[]; label: string }> = [
  { id: ['welcome'], label: 'Meet Daylens' },
  { id: ['proof'], label: 'First signal' },
  { id: ['personalize'], label: 'Personalize' },
]

interface ProofSnapshot {
  liveSession: LiveSession | null
  timeline: DayTimelinePayload | null
  ready: boolean
}

function StageHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string
  title: string
  body: string
}) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="onboarding-eyebrow">{eyebrow}</div>
      <h1 className="onboarding-title">{title}</h1>
      <p className="onboarding-sub">{body}</p>
    </div>
  )
}

function ProgressStepper({ steps, activeIndex }: { steps: Array<{ label: string }>; activeIndex: number }) {
  return (
    <div className="onboarding-stepper" aria-label="Setup progress">
      {steps.map((step, index) => {
        const state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'upcoming'
        return (
          <div key={step.label} className={`onboarding-step onboarding-step-${state}`}>
            <div className="onboarding-step-dot">
              {state === 'done' ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1.8 5.4L4 7.6L8.2 2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                </svg>
              ) : state === 'active' ? (
                <span className="onboarding-step-pulse" aria-hidden="true" />
              ) : null}
            </div>
            <span className="onboarding-step-label">{step.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function TimelinePreview() {
  return (
    <div className="onboarding-preview" aria-hidden="true">
      <div className="onboarding-preview-axis">
        <span>09:00</span>
        <span>11:00</span>
        <span>13:00</span>
        <span>15:00</span>
        <span>17:00</span>
      </div>
      <div className="onboarding-preview-track">
        <div className="onboarding-preview-block onboarding-preview-block-a" style={{ left: '4%', width: '22%' }}>
          <div className="onboarding-preview-label">Client brief — Figma</div>
        </div>
        <div className="onboarding-preview-block onboarding-preview-block-b" style={{ left: '28%', width: '10%' }}>
          <div className="onboarding-preview-label">Break</div>
        </div>
        <div className="onboarding-preview-block onboarding-preview-block-c" style={{ left: '40%', width: '28%' }}>
          <div className="onboarding-preview-label">Deep work — Repo daylens</div>
        </div>
        <div className="onboarding-preview-block onboarding-preview-block-d" style={{ left: '70%', width: '12%' }}>
          <div className="onboarding-preview-label">Calls</div>
        </div>
        <div className="onboarding-preview-block onboarding-preview-block-e" style={{ left: '84%', width: '14%' }}>
          <div className="onboarding-preview-label">Research</div>
        </div>
      </div>
      <div className="onboarding-preview-caption">A preview. In a day or two, this is your own week.</div>
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
        <div className="onboarding-settings-mock-title">Privacy & Security — Screen Recording</div>
      </div>
      <div className="onboarding-settings-mock-body">
        <div className="onboarding-settings-mock-row onboarding-settings-mock-row-other">
          <span className="onboarding-settings-mock-app">Loom</span>
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

function SummaryTile({
  label,
  value,
  detail,
  highlight,
}: {
  label: string
  value: string
  detail?: string
  highlight?: boolean
}) {
  return (
    <div className={`onboarding-summary-tile${highlight ? ' onboarding-summary-tile-highlight' : ''}`}>
      <div className="onboarding-summary-label">{label}</div>
      <div className="onboarding-summary-value">{value}</div>
      {detail && <div className="onboarding-summary-detail">{detail}</div>}
    </div>
  )
}

function proofDetail(snapshot: ProofSnapshot): Array<{ label: string; value: string; detail?: string }> {
  const items: Array<{ label: string; value: string; detail?: string }> = []
  if (snapshot.liveSession) {
    items.push({
      label: 'Live right now',
      value: snapshot.liveSession.appName,
      detail: snapshot.liveSession.windowTitle || 'Daylens can see what you are working on.',
    })
  }
  if (snapshot.timeline) {
    if (snapshot.timeline.totalSeconds > 0) {
      items.push({
        label: 'Tracked today',
        value: formatDuration(snapshot.timeline.totalSeconds),
        detail: `${snapshot.timeline.blocks.length} work block${snapshot.timeline.blocks.length === 1 ? '' : 's'} reconstructed so far`,
      })
    }
    if (snapshot.timeline.siteCount > 0) {
      items.push({
        label: 'Browser evidence',
        value: `${snapshot.timeline.siteCount} site${snapshot.timeline.siteCount === 1 ? '' : 's'}`,
        detail: 'Page titles and sites are already flowing in.',
      })
    }
  }
  return items.slice(0, 3)
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
  const [permissionState, setPermissionState] = useState<TrackingPermissionState>(initialSettings.onboardingState.trackingPermissionState)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [proof, setProof] = useState<ProofSnapshot>({ liveSession: null, timeline: null, ready: false })
  const [settingsHandoff, setSettingsHandoff] = useState(false)
  const onboardingTrackedRef = useRef(false)
  const proofTrackedRef = useRef(false)
  const onboardingStateRef = useRef(settings.onboardingState)

  const platform = settings.onboardingState.platform
  const stage = settings.onboardingState.stage
  const isMac = platform === 'macos'
  const proofTiles = useMemo(() => proofDetail(proof), [proof])

  const steps = isMac ? MAC_STEPS : NON_MAC_STEPS
  const activeStepIndex = useMemo(() => {
    const idx = steps.findIndex((s) => s.id.includes(stage))
    if (idx >= 0) return idx
    return stage === 'complete' ? steps.length : 0
  }, [steps, stage])

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

  async function persistOnboarding(
    nextStage: OnboardingStage,
    partial: Partial<AppSettings['onboardingState']> = {},
  ) {
    const nextState = {
      ...settings.onboardingState,
      ...partial,
      stage: nextStage,
    }
    setSettings((current) => ({ ...current, onboardingState: nextState }))
    await ipc.settings.set({ onboardingState: nextState })
  }

  async function refreshPermissionState() {
    if (!isMac) return
    const nextState = await ipc.tracking.getPermissionState()
    setPermissionState(nextState)

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
        const [timeline, liveSession] = await Promise.all([
          ipc.db.getTimelineDay(todayString()).catch(() => null),
          ipc.tracking.getLiveSession().catch(() => null),
        ])
        if (cancelled) return

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
          setErrorMessage(err instanceof Error ? err.message : String(err))
        }
      }
    }

    void loadProof()
    const interval = window.setInterval(() => { void loadProof() }, 2_500)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [stage])

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

  function toggleGoal(id: string) {
    setGoals((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
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
      completedAt,
    }

    try {
      await ipc.settings.set({
        onboardingComplete: true,
        onboardingState: nextOnboardingState,
        userGoals: Array.from(goals),
      })
      await ipc.app.completeOnboarding()
      track(ANALYTICS_EVENT.ONBOARDING_COMPLETED, {
        platform,
        selected_goal_count: goals.size,
        surface: 'onboarding',
      })
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

  async function handleContinueFromWelcome() {
    track(ANALYTICS_EVENT.ONBOARDING_STEP_COMPLETED, {
      platform,
      step: 'welcome',
      surface: 'onboarding',
    })
    await persistOnboarding(isMac ? 'permission' : 'proof', {
      proofState: isMac ? 'idle' : 'collecting',
    })
  }

  async function continueFromProof() {
    track(ANALYTICS_EVENT.ONBOARDING_STEP_COMPLETED, {
      platform,
      step: 'proof',
      surface: 'onboarding',
    })
    await persistOnboarding('personalize', {
      proofState: proof.ready ? 'ready' : settings.onboardingState.proofState,
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

  return (
    <div className="onboarding-root">
      <div className="onboarding-shell">
        <ProgressStepper steps={steps} activeIndex={activeStepIndex} />

        {stage === 'welcome' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="WELCOME"
              title={isMac
                ? 'Know where your time actually went — before anyone asks.'
                : 'Daylens quietly turns your workday into answers you can trust.'}
              body={isMac
                ? 'Daylens stays local and sips context from your active window so Timeline, Apps, and AI can answer real questions: what happened between 2 and 4 pm, how long that client really took, why yesterday felt different.'
                : 'No clocking in, no manual tagging. Just a calm record of how you actually worked, so you can ask grounded questions when it matters.'}
            />
            <TimelinePreview />
            <div className="onboarding-reassure">
              <div className="onboarding-reassure-pill">Local-only</div>
              <div className="onboarding-reassure-pill">No video recorded</div>
              <div className="onboarding-reassure-pill">Private by default</div>
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void handleContinueFromWelcome()}>
                {isMac ? 'Get started' : 'Start tracking'}
              </button>
              {isMac && (
                <span className="onboarding-hint onboarding-hint-quiet">
                  Two quick steps. Takes less than a minute.
                </span>
              )}
            </div>
          </div>
        )}

        {stage === 'permission' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="ONE ACCESS TOGGLE"
              title="macOS calls it Screen Recording. Daylens only reads window titles — no video, ever."
              body="This is the single switch that lets Daylens see what you are working in. Nothing is recorded. Nothing leaves this machine. Without it, Timeline opens empty and AI has nothing honest to say."
            />

            <div className="onboarding-permission-grid">
              <div className="onboarding-permission-narrative">
                <ol className="onboarding-steps-list">
                  <li>
                    <span className="onboarding-steps-index">1</span>
                    <div>
                      <div className="onboarding-steps-title">Open Privacy &amp; Security → Screen Recording</div>
                      <div className="onboarding-steps-body">We will jump you straight there and hold your place here.</div>
                    </div>
                  </li>
                  <li>
                    <span className="onboarding-steps-index">2</span>
                    <div>
                      <div className="onboarding-steps-title">Flip the Daylens toggle on</div>
                      <div className="onboarding-steps-body">macOS may ask for your password. That is system-level, not Daylens.</div>
                    </div>
                  </li>
                  <li>
                    <span className="onboarding-steps-index">3</span>
                    <div>
                      <div className="onboarding-steps-title">Come back. Daylens will notice.</div>
                      <div className="onboarding-steps-body">No need to click anything when you return — we watch for the permission.</div>
                    </div>
                  </li>
                </ol>
              </div>
              <SettingsPreview />
            </div>

            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void beginPermissionRequest()} disabled={busy}>
                {busy ? 'Opening System Settings…' : 'Open Screen Recording'}
              </button>
              <button className="onboarding-btn-secondary" onClick={() => void refreshPermissionState()}>
                I already enabled it
              </button>
            </div>

            <div className={`onboarding-status onboarding-status-${permissionStatusTone}`}>
              <span className="onboarding-status-dot" />
              <span className="onboarding-status-label">{permissionStatusLabel}</span>
              {settingsHandoff && (
                <span className="onboarding-status-note">
                  Keep this window open — we will pick up the moment the toggle flips.
                </span>
              )}
            </div>
          </div>
        )}

        {stage === 'relaunch_required' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="ONE RESTART"
              title="Daylens has the permission. macOS needs one restart to hand it over."
              body="This is a macOS quirk, not a Daylens one: apps can only use Screen Recording after relaunching with it enabled. Daylens will reopen right back to this flow."
            />
            <div className="onboarding-handoff">
              <div className="onboarding-handoff-beam" aria-hidden="true">
                <div className="onboarding-handoff-pulse" />
              </div>
              <div className="onboarding-handoff-copy">
                <div className="onboarding-callout-title">What happens next</div>
                <div className="onboarding-callout-body">
                  Daylens closes and reopens. Your setup picks up exactly where you left it — no data resets, no lost progress.
                </div>
              </div>
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void ipc.app.relaunch()}>
                Restart Daylens
              </button>
            </div>
          </div>
        )}

        {stage === 'verifying_permission' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="CONFIRMING"
              title="Checking in with macOS and warming up the tracker."
              body="If the permission stuck, you will land straight in proof. If something reverted, we will walk you back to the right step — no dead ends."
            />
            <div className="onboarding-verify">
              <div className="onboarding-breath" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div className="onboarding-verify-copy">
                <div className="onboarding-callout-title">Verifying Screen Recording</div>
                <div className="onboarding-callout-body">
                  This should take a second or two. If it is taking longer, macOS may not have saved the toggle — we will recover automatically.
                </div>
              </div>
            </div>
          </div>
        )}

        {stage === 'proof' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow={proof.ready ? 'IT WORKS' : 'LISTENING'}
              title={proof.ready
                ? 'This is the first real slice of your day.'
                : 'Daylens is tuning in. Keep working as normal.'}
              body={proof.ready
                ? 'Everything you see below came from your own activity on this machine in the last minute. Timeline will keep filling in the more you work.'
                : 'We are waiting for a live window title, browser evidence, or the first reconstructed block. This usually happens within 60 seconds once you switch to anything real.'}
            />
            <div className="onboarding-proof-card">
              {!proof.ready && (
                <div className="onboarding-proof-pending">
                  <span className="onboarding-spinner" aria-hidden="true" />
                  <div>
                    <div className="onboarding-callout-title">Gathering local proof</div>
                    <div className="onboarding-callout-body">
                      Open a browser tab, a doc, or an editor — Daylens will pick it up.
                    </div>
                  </div>
                </div>
              )}
              {proofTiles.length > 0 && (
                <div className="onboarding-summary-grid">
                  {proofTiles.map((item, index) => (
                    <SummaryTile
                      key={item.label}
                      label={item.label}
                      value={item.value}
                      detail={item.detail}
                      highlight={index === 0}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" disabled={!proof.ready} onClick={() => void continueFromProof()}>
                {proof.ready ? 'Continue' : 'Waiting for the first signal…'}
              </button>
            </div>
          </div>
        )}

        {stage === 'personalize' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="LAST STEP"
              title="What do you want Daylens to lean into first?"
              body="Optional. It just tunes which prompts and summaries show up sooner. You can change this any time in Settings."
            />
            <div className="onboarding-goals-grid">
              {GOALS.map((goal) => {
                const selected = goals.has(goal.id)
                return (
                  <button
                    key={goal.id}
                    className={`onboarding-goal-card${selected ? ' onboarding-goal-card-selected' : ''}`}
                    onClick={() => toggleGoal(goal.id)}
                  >
                    <div className="onboarding-goal-dot" />
                    <span>{goal.label}</span>
                  </button>
                )
              })}
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void finishOnboarding()} disabled={busy}>
                {busy ? 'Opening Timeline…' : 'Open Daylens'}
              </button>
              <button className="onboarding-btn-secondary" onClick={() => void finishOnboarding()} disabled={busy}>
                Skip
              </button>
            </div>
          </div>
        )}

        {errorMessage && <div className="onboarding-error">{errorMessage}</div>}
      </div>

      <style>{`
        .onboarding-root {
          position: fixed;
          inset: 0;
          background:
            radial-gradient(circle at 18% 12%, rgba(79, 220, 200, 0.14), transparent 42%),
            radial-gradient(circle at 86% 88%, rgba(125, 191, 255, 0.12), transparent 40%),
            #0a0f16;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 36px 24px;
          -webkit-app-region: drag;
        }
        .onboarding-shell {
          width: min(780px, 100%);
          border-radius: 28px;
          border: 1px solid rgba(173, 198, 255, 0.14);
          background: linear-gradient(180deg, rgba(12, 18, 27, 0.92), rgba(8, 12, 18, 0.92));
          box-shadow: 0 30px 90px rgba(0, 0, 0, 0.45);
          padding: 28px 32px 26px;
          -webkit-app-region: no-drag;
          backdrop-filter: blur(22px);
          display: grid;
          gap: 22px;
        }
        .onboarding-stepper {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          padding-bottom: 4px;
          border-bottom: 1px solid rgba(173, 198, 255, 0.06);
        }
        .onboarding-step {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 4px 10px 4px 4px;
          border-radius: 999px;
          transition: background 160ms ease, color 160ms ease;
        }
        .onboarding-step-dot {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1.5px solid rgba(173, 198, 255, 0.22);
          background: rgba(255, 255, 255, 0.02);
          color: #9fd4c6;
          flex-shrink: 0;
        }
        .onboarding-step-label {
          font-size: 11.5px;
          font-weight: 600;
          letter-spacing: 0.04em;
          color: var(--color-text-tertiary);
          white-space: nowrap;
        }
        .onboarding-step-done .onboarding-step-dot {
          background: linear-gradient(135deg, #4fd3c6 0%, #7bb7ff 100%);
          border-color: transparent;
          color: #07131b;
        }
        .onboarding-step-done .onboarding-step-label { color: var(--color-text-secondary); }
        .onboarding-step-active .onboarding-step-dot {
          border-color: rgba(125, 191, 255, 0.55);
          background: rgba(125, 191, 255, 0.08);
        }
        .onboarding-step-active .onboarding-step-label {
          color: var(--color-text-primary);
          font-weight: 700;
        }
        .onboarding-step-pulse {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: linear-gradient(135deg, #7bb7ff 0%, #4fd3c6 100%);
          box-shadow: 0 0 0 0 rgba(125, 191, 255, 0.55);
          animation: onboardingPulse 1.6s ease-out infinite;
        }
        .onboarding-screen {
          display: grid;
          gap: 22px;
        }
        .onboarding-eyebrow {
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--color-text-tertiary);
        }
        .onboarding-title {
          margin: 0;
          font-size: 30px;
          line-height: 1.1;
          letter-spacing: -0.03em;
          color: var(--color-text-primary);
        }
        .onboarding-sub {
          margin: 0;
          font-size: 14.5px;
          line-height: 1.7;
          color: var(--color-text-secondary);
          max-width: 62ch;
        }
        .onboarding-reassure {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .onboarding-reassure-pill {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          padding: 5px 11px;
          border-radius: 999px;
          border: 1px solid rgba(173, 198, 255, 0.16);
          background: rgba(255, 255, 255, 0.02);
          color: var(--color-text-secondary);
        }
        .onboarding-preview {
          display: grid;
          gap: 8px;
          padding: 18px 18px 14px;
          border-radius: 18px;
          border: 1px solid rgba(173, 198, 255, 0.10);
          background: linear-gradient(180deg, rgba(14, 24, 34, 0.82), rgba(9, 14, 22, 0.82));
        }
        .onboarding-preview-axis {
          display: flex;
          justify-content: space-between;
          font-family: 'SF Mono', ui-monospace, monospace;
          font-size: 10px;
          color: rgba(180, 200, 220, 0.45);
          letter-spacing: 0.08em;
        }
        .onboarding-preview-track {
          position: relative;
          height: 44px;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.025);
          overflow: hidden;
        }
        .onboarding-preview-block {
          position: absolute;
          top: 6px;
          bottom: 6px;
          border-radius: 7px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          color: rgba(225, 236, 248, 0.88);
          font-size: 10.5px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          animation: onboardingBlockIn 1.2s cubic-bezier(.2,.8,.2,1) both;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
        }
        .onboarding-preview-block-a { background: linear-gradient(135deg, rgba(125, 191, 255, 0.35), rgba(79, 220, 200, 0.25)); animation-delay: 0s; }
        .onboarding-preview-block-b { background: rgba(255, 255, 255, 0.05); color: rgba(180, 200, 220, 0.5); animation-delay: 0.15s; }
        .onboarding-preview-block-c { background: linear-gradient(135deg, rgba(79, 220, 200, 0.38), rgba(125, 191, 255, 0.26)); animation-delay: 0.3s; }
        .onboarding-preview-block-d { background: linear-gradient(135deg, rgba(178, 160, 255, 0.32), rgba(125, 191, 255, 0.22)); animation-delay: 0.45s; }
        .onboarding-preview-block-e { background: linear-gradient(135deg, rgba(255, 191, 143, 0.32), rgba(219, 146, 102, 0.22)); animation-delay: 0.6s; }
        .onboarding-preview-caption {
          font-size: 11.5px;
          color: rgba(180, 200, 220, 0.55);
        }
        .onboarding-permission-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(240px, 300px);
          gap: 16px;
          align-items: start;
        }
        .onboarding-steps-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 12px;
        }
        .onboarding-steps-list li {
          display: grid;
          grid-template-columns: 28px 1fr;
          gap: 12px;
          align-items: start;
        }
        .onboarding-steps-index {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: rgba(125, 191, 255, 0.12);
          color: #b7d3ff;
          font-size: 11.5px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-top: 1px;
        }
        .onboarding-steps-title {
          font-size: 13.5px;
          font-weight: 650;
          color: var(--color-text-primary);
          letter-spacing: -0.01em;
        }
        .onboarding-steps-body {
          font-size: 12.5px;
          color: var(--color-text-secondary);
          line-height: 1.55;
          margin-top: 2px;
        }
        .onboarding-settings-mock {
          border-radius: 16px;
          border: 1px solid rgba(173, 198, 255, 0.14);
          background: linear-gradient(180deg, rgba(30, 36, 46, 0.96), rgba(18, 24, 32, 0.96));
          overflow: hidden;
          box-shadow: 0 18px 44px rgba(0, 0, 0, 0.4);
        }
        .onboarding-settings-mock-header {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 9px 12px;
          background: rgba(255, 255, 255, 0.03);
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }
        .onboarding-settings-mock-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }
        .onboarding-settings-mock-title {
          margin-left: 8px;
          font-size: 10.5px;
          color: rgba(220, 230, 240, 0.8);
          font-weight: 600;
        }
        .onboarding-settings-mock-body {
          padding: 8px 4px;
        }
        .onboarding-settings-mock-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px;
          border-radius: 8px;
          margin: 0 6px;
          transition: background 160ms ease;
        }
        .onboarding-settings-mock-row-target {
          background: rgba(125, 191, 255, 0.10);
          box-shadow: inset 0 0 0 1px rgba(125, 191, 255, 0.35);
          animation: onboardingMockHighlight 2.8s ease-in-out infinite;
        }
        .onboarding-settings-mock-app {
          font-size: 12px;
          color: rgba(225, 235, 245, 0.82);
          font-weight: 500;
        }
        .onboarding-settings-mock-badge {
          font-weight: 700;
          color: #eef6ff;
        }
        .onboarding-settings-mock-toggle {
          width: 28px;
          height: 17px;
          border-radius: 999px;
          position: relative;
          transition: background 180ms ease;
        }
        .onboarding-settings-mock-toggle::after {
          content: '';
          position: absolute;
          top: 2px;
          width: 13px;
          height: 13px;
          border-radius: 50%;
          background: #f5f7fa;
          transition: left 240ms ease;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
        }
        .onboarding-settings-mock-toggle.on { background: #4ac06e; }
        .onboarding-settings-mock-toggle.on::after { left: 13px; }
        .onboarding-settings-mock-toggle.off { background: rgba(255, 255, 255, 0.14); }
        .onboarding-settings-mock-toggle.off::after { left: 2px; }
        .onboarding-settings-mock-row-target .onboarding-settings-mock-toggle {
          animation: onboardingToggleTease 2.8s ease-in-out infinite;
        }
        .onboarding-settings-mock-hint {
          padding: 10px 14px 14px;
          font-size: 11px;
          color: rgba(180, 200, 220, 0.65);
          text-align: center;
          border-top: 1px solid rgba(255, 255, 255, 0.04);
        }
        .onboarding-handoff,
        .onboarding-verify,
        .onboarding-callout,
        .onboarding-proof-card {
          border-radius: 18px;
          border: 1px solid rgba(173, 198, 255, 0.12);
          background: rgba(255, 255, 255, 0.02);
          padding: 18px 18px 16px;
        }
        .onboarding-handoff {
          display: grid;
          grid-template-columns: 120px 1fr;
          gap: 18px;
          align-items: center;
        }
        .onboarding-handoff-beam {
          height: 90px;
          border-radius: 14px;
          background:
            radial-gradient(circle at 50% 50%, rgba(125, 191, 255, 0.22), transparent 65%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.01));
          position: relative;
          overflow: hidden;
        }
        .onboarding-handoff-pulse {
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, transparent, rgba(125, 191, 255, 0.35), transparent);
          animation: onboardingBeam 2.4s linear infinite;
        }
        .onboarding-verify {
          display: grid;
          grid-template-columns: 120px 1fr;
          gap: 18px;
          align-items: center;
        }
        .onboarding-breath {
          height: 90px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        }
        .onboarding-breath span {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: linear-gradient(135deg, #7bb7ff 0%, #4fd3c6 100%);
          animation: onboardingBreath 1.4s ease-in-out infinite;
        }
        .onboarding-breath span:nth-child(2) { animation-delay: 0.2s; }
        .onboarding-breath span:nth-child(3) { animation-delay: 0.4s; }
        .onboarding-callout-title,
        .onboarding-summary-label {
          font-size: 10.5px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--color-text-tertiary);
        }
        .onboarding-callout-body,
        .onboarding-summary-detail,
        .onboarding-hint {
          font-size: 12.5px;
          line-height: 1.65;
          color: var(--color-text-secondary);
        }
        .onboarding-hint-quiet {
          font-size: 11.5px;
          color: var(--color-text-tertiary);
          align-self: center;
        }
        .onboarding-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: center;
        }
        .onboarding-btn-primary,
        .onboarding-btn-secondary {
          height: 42px;
          padding: 0 18px;
          border-radius: 12px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 140ms ease, border-color 140ms ease, opacity 140ms ease, box-shadow 180ms ease;
        }
        .onboarding-btn-primary {
          border: none;
          background: linear-gradient(135deg, #7bb7ff 0%, #4fd3c6 100%);
          color: #07131b;
          box-shadow: 0 8px 22px rgba(79, 211, 198, 0.22);
        }
        .onboarding-btn-primary:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 12px 26px rgba(79, 211, 198, 0.32);
        }
        .onboarding-btn-secondary {
          border: 1px solid var(--color-border-ghost);
          background: transparent;
          color: var(--color-text-primary);
        }
        .onboarding-btn-secondary:hover:not(:disabled) {
          border-color: rgba(173, 198, 255, 0.32);
        }
        .onboarding-btn-primary:disabled,
        .onboarding-btn-secondary:disabled {
          opacity: 0.55;
          cursor: default;
          box-shadow: none;
        }
        .onboarding-status {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          padding: 10px 14px;
          border-radius: 12px;
          border: 1px solid var(--color-border-ghost);
          background: rgba(255, 255, 255, 0.02);
          font-size: 12.5px;
          color: var(--color-text-secondary);
        }
        .onboarding-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: rgba(180, 200, 220, 0.45);
        }
        .onboarding-status-ok .onboarding-status-dot { background: #4ad18b; box-shadow: 0 0 0 3px rgba(74, 209, 139, 0.18); }
        .onboarding-status-waiting .onboarding-status-dot { background: #f5c662; animation: onboardingPulse 1.6s ease-out infinite; }
        .onboarding-status-label { font-weight: 600; color: var(--color-text-primary); }
        .onboarding-status-note { color: var(--color-text-tertiary); }
        .onboarding-summary-grid,
        .onboarding-goals-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
        }
        .onboarding-summary-tile,
        .onboarding-goal-card {
          border-radius: 16px;
          border: 1px solid var(--color-border-ghost);
          background: rgba(255, 255, 255, 0.025);
          padding: 14px 14px 12px;
          transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
        }
        .onboarding-summary-tile-highlight {
          border-color: rgba(125, 191, 255, 0.45);
          background: linear-gradient(180deg, rgba(125, 191, 255, 0.08), rgba(79, 220, 200, 0.04));
          box-shadow: 0 8px 26px rgba(79, 211, 198, 0.14);
        }
        .onboarding-summary-value {
          margin-top: 8px;
          font-size: 18px;
          font-weight: 720;
          color: var(--color-text-primary);
        }
        .onboarding-goal-card {
          display: flex;
          align-items: center;
          gap: 10px;
          text-align: left;
          color: var(--color-text-primary);
          cursor: pointer;
        }
        .onboarding-goal-card-selected {
          border-color: rgba(125, 191, 255, 0.45);
          background: rgba(97, 165, 255, 0.10);
        }
        .onboarding-goal-card:hover:not(.onboarding-goal-card-selected) {
          border-color: rgba(173, 198, 255, 0.28);
          background: rgba(255, 255, 255, 0.035);
        }
        .onboarding-goal-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: linear-gradient(135deg, #7bb7ff 0%, #4fd3c6 100%);
          flex-shrink: 0;
        }
        .onboarding-proof-pending {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 14px;
        }
        .onboarding-spinner {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid rgba(255, 255, 255, 0.14);
          border-top-color: #7bb7ff;
          animation: onboardingSpin 1s linear infinite;
          flex-shrink: 0;
        }
        .onboarding-error {
          padding: 12px 14px;
          border-radius: 14px;
          border: 1px solid rgba(248, 113, 113, 0.26);
          background: rgba(248, 113, 113, 0.08);
          color: #fecaca;
          font-size: 13px;
          line-height: 1.6;
        }
        @keyframes onboardingSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes onboardingPulse {
          0% { box-shadow: 0 0 0 0 rgba(125, 191, 255, 0.55); }
          70% { box-shadow: 0 0 0 8px rgba(125, 191, 255, 0); }
          100% { box-shadow: 0 0 0 0 rgba(125, 191, 255, 0); }
        }
        @keyframes onboardingBreath {
          0%, 100% { transform: scale(0.7); opacity: 0.5; }
          50% { transform: scale(1.0); opacity: 1; }
        }
        @keyframes onboardingBeam {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100%); }
        }
        @keyframes onboardingBlockIn {
          from { opacity: 0; transform: translateX(-6px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes onboardingMockHighlight {
          0%, 100% { box-shadow: inset 0 0 0 1px rgba(125, 191, 255, 0.35); }
          50% { box-shadow: inset 0 0 0 1px rgba(125, 191, 255, 0.6), 0 0 0 2px rgba(125, 191, 255, 0.18); }
        }
        @keyframes onboardingToggleTease {
          0%, 40% { background: rgba(255, 255, 255, 0.14); }
          50%, 100% { background: #4ac06e; }
          0%, 40% {}
          45% {}
        }
        .onboarding-settings-mock-row-target .onboarding-settings-mock-toggle::after {
          animation: onboardingToggleKnob 2.8s ease-in-out infinite;
        }
        @keyframes onboardingToggleKnob {
          0%, 40% { left: 2px; }
          50%, 100% { left: 13px; }
        }
        @media (max-width: 720px) {
          .onboarding-shell {
            padding: 22px 20px 20px;
            border-radius: 24px;
          }
          .onboarding-title {
            font-size: 26px;
          }
          .onboarding-permission-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .onboarding-handoff,
          .onboarding-verify {
            grid-template-columns: 1fr;
          }
          .onboarding-handoff-beam,
          .onboarding-breath {
            height: 72px;
          }
        }
      `}</style>
    </div>
  )
}
