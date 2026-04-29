import { useEffect, useMemo, useRef, useState } from 'react'
import { ANALYTICS_EVENT, blockCountBucket, trackedTimeBucket } from '@shared/analytics'
import type { AppSettings, DayTimelinePayload, LiveSession, OnboardingStage, ProofState, TrackingPermissionState } from '@shared/types'
import { nextMacStageAfterGrantedPermission } from '@shared/onboarding'
import { ipc } from '../lib/ipc'
import { track } from '../lib/analytics'
import { todayString } from '../lib/format'

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
  title,
  body,
}: {
  title: string
  body?: string
}) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <h1 className="onboarding-title">{title}</h1>
      {body && <p className="onboarding-sub">{body}</p>}
    </div>
  )
}

function ProgressDots({ count, activeIndex }: { count: number; activeIndex: number }) {
  return (
    <div className="onboarding-dots" aria-label="Setup progress">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`onboarding-dot${i === activeIndex ? ' onboarding-dot-active' : i < activeIndex ? ' onboarding-dot-done' : ''}`}
        />
      ))}
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
  const [defaultUserName, setDefaultUserName] = useState('')
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
        userName: nameDraft.trim(),
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
        <ProgressDots count={steps.length} activeIndex={activeStepIndex} />

        {stage === 'welcome' && (
          <div className="onboarding-screen">
            <h1 className="onboarding-title onboarding-title-large">
              {isMac
                ? 'Daylens watches how you work, so you don\'t have to.'
                : 'Daylens watches how you work, so you don\'t have to.'}
            </h1>
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void handleContinueFromWelcome()}>
                {isMac ? 'Get started' : 'Start tracking'}
              </button>
            </div>
          </div>
        )}

        {stage === 'permission' && (
          <div className="onboarding-screen">
            <StageHeading title="macOS calls it Screen Recording. Daylens only reads window titles — no video, ever." />
            <SettingsPreview />
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void beginPermissionRequest()} disabled={busy}>
                {busy ? 'Opening System Settings…' : 'Open Screen Recording'}
              </button>
              <button className="onboarding-btn-secondary" onClick={() => void refreshPermissionState()}>
                I already enabled it
              </button>
            </div>
            <p className="onboarding-reassurance">Everything stays on your device. No screenshots, no video, ever.</p>
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
            <StageHeading title="Daylens has the permission. macOS needs one restart to hand it over." />
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
            <StageHeading title="Checking in with macOS and warming up the tracker." />
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
            {proof.ready ? (
              <>
                <StageHeading title="Here's what we've picked up so far." />
                <div className="onboarding-proof-visual">
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
                </div>
              </>
            ) : (
              <div className="onboarding-proof-pending">
                <div className="onboarding-breath" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <p>Have a great day. Daylens will keep listening for real work signal.</p>
              </div>
            )}
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" disabled={!proof.ready} onClick={() => void continueFromProof()}>
                {proof.ready ? 'Continue' : 'Waiting for the first signal…'}
              </button>
            </div>
          </div>
        )}

        {stage === 'personalize' && (
          <div className="onboarding-screen">
            <StageHeading title="Make it yours." />
            <label className="onboarding-name-field">
              <input
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                placeholder={defaultUserName || 'Your name'}
                maxLength={80}
              />
            </label>
            <div className="onboarding-goals-grid">
              {GOALS.map((goal) => {
                const selected = goals.has(goal.id)
                return (
                  <button
                    key={goal.id}
                    className={`onboarding-goal-chip${selected ? ' onboarding-goal-chip-selected' : ''}`}
                    onClick={() => toggleGoal(goal.id)}
                  >
                    {goal.label}
                  </button>
                )
              })}
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void finishOnboarding()} disabled={busy}>
                {busy ? 'Opening Timeline…' : 'Open Daylens'}
              </button>
            </div>
            <button className="onboarding-skip-link" onClick={() => void finishOnboarding()} disabled={busy}>
              Skip for now
            </button>
          </div>
        )}

        {errorMessage && <div className="onboarding-error">{errorMessage}</div>}
      </div>

      <style>{`
        .onboarding-root {
          position: fixed;
          inset: 0;
          background:
            radial-gradient(circle at 18% 12%, rgba(26, 111, 212, 0.14), transparent 42%),
            radial-gradient(circle at 86% 88%, rgba(90, 179, 255, 0.10), transparent 40%),
            #07090f;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 36px 24px;
          -webkit-app-region: drag;
        }
        .onboarding-shell {
          width: min(780px, 100%);
          border-radius: 32px;
          border: 1px solid rgba(173, 198, 255, 0.18);
          background: linear-gradient(180deg, rgba(12, 18, 27, 0.92), rgba(8, 12, 18, 0.92));
          box-shadow: 0 30px 90px rgba(0, 0, 0, 0.45);
          padding: 28px 32px 26px;
          -webkit-app-region: no-drag;
          backdrop-filter: blur(22px);
          display: grid;
          gap: 22px;
        }
        .onboarding-dots {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .onboarding-dot {
          height: 6px;
          width: 6px;
          border-radius: 3px;
          background: rgba(255, 255, 255, 0.1);
          transition: width 300ms ease, background 300ms ease;
        }
        .onboarding-dot-done {
          background: rgba(90, 179, 255, 0.52);
        }
        .onboarding-dot-active {
          width: 18px;
          background: linear-gradient(145deg, #1a6fd4 0%, #5ab3ff 100%);
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
          color: rgba(194,198,214,0.5);
        }
        .onboarding-title {
          margin: 0;
          font-size: 30px;
          line-height: 1.1;
          letter-spacing: -0.03em;
          color: #f0f4ff;
        }
        .onboarding-title-large {
          font-size: 40px;
          line-height: 1.08;
        }
        .onboarding-sub {
          margin: 0;
          font-size: 14.5px;
          line-height: 1.7;
          color: #c2c6d6;
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
          color: #c2c6d6;
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
          color: #f0f4ff;
          letter-spacing: -0.01em;
        }
        .onboarding-steps-body {
          font-size: 12.5px;
          color: #c2c6d6;
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
          background: linear-gradient(135deg, #1a6fd4 0%, #5ab3ff 100%);
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
          color: rgba(194,198,214,0.5);
        }
        .onboarding-callout-body,
        .onboarding-summary-detail,
        .onboarding-hint {
          font-size: 12.5px;
          line-height: 1.65;
          color: #c2c6d6;
        }
        .onboarding-hint-quiet {
          font-size: 11.5px;
          color: rgba(194,198,214,0.5);
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
          background: linear-gradient(145deg, #1a6fd4 0%, #5ab3ff 100%);
          color: #fff;
          box-shadow: 0 10px 28px rgba(26, 111, 212, 0.32), 0 0 0 1px rgba(173, 198, 255, 0.10) inset;
        }
        .onboarding-btn-primary:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 16px 36px rgba(26, 111, 212, 0.44), 0 0 0 1px rgba(240, 248, 255, 0.16) inset;
        }
        .onboarding-btn-secondary {
          border: 1px solid rgba(255,255,255,0.08);
          background: transparent;
          color: #f0f4ff;
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
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255, 255, 255, 0.02);
          font-size: 12.5px;
          color: #c2c6d6;
        }
        .onboarding-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: rgba(180, 200, 220, 0.45);
        }
        .onboarding-status-ok .onboarding-status-dot { background: #4ad18b; box-shadow: 0 0 0 3px rgba(74, 209, 139, 0.18); }
        .onboarding-status-waiting .onboarding-status-dot { background: #f5c662; animation: onboardingPulse 1.6s ease-out infinite; }
        .onboarding-status-label { font-weight: 600; color: #f0f4ff; }
        .onboarding-status-note { color: rgba(194,198,214,0.5); }
        .onboarding-summary-grid,
        .onboarding-goals-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 12px;
        }
        .onboarding-name-field {
          display: grid;
          gap: 0;
        }
        .onboarding-name-field input {
          width: 100%;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.03);
          color: #f0f4ff;
          padding: 12px 14px;
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0;
          text-transform: none;
          outline: none;
        }
        .onboarding-name-field input:focus {
          border-color: rgba(90, 179, 255, 0.58);
          box-shadow: 0 0 0 3px rgba(26, 111, 212, 0.14);
        }
        .onboarding-summary-tile,
        .onboarding-goal-card {
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.08);
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
          color: #f0f4ff;
        }
        .onboarding-goal-chip {
          min-height: 48px;
          padding: 13px 17px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255, 255, 255, 0.025);
          color: #f0f4ff;
          font-size: 14px;
          font-weight: 500;
          text-align: left;
          cursor: pointer;
          transition: border-color 160ms ease, background 160ms ease;
        }
        .onboarding-goal-chip-selected {
          border-color: rgba(90, 179, 255, 0.52);
          background: rgba(26, 111, 212, 0.13);
          color: #d9edff;
        }
        .onboarding-goal-chip:hover:not(.onboarding-goal-chip-selected) {
          border-color: rgba(173, 198, 255, 0.28);
          background: rgba(255, 255, 255, 0.04);
        }
        .onboarding-proof-visual {
          padding: 4px 0 0;
          min-height: 90px;
        }
        .onboarding-live-activity {
          display: grid;
          gap: 14px;
        }
        .onboarding-live-row {
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .onboarding-live-row-active {
          padding: 4px 0 4px 13px;
          border-left: 3px solid #5ab3ff;
        }
        .onboarding-live-pulse {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #5ab3ff;
          flex-shrink: 0;
          box-shadow: 0 0 0 0 rgba(90, 179, 255, 0.55);
          animation: onboardingPulse 1.6s ease-out infinite;
        }
        .onboarding-live-app {
          font-size: 14px;
          font-weight: 650;
          color: #f0f4ff;
        }
        .onboarding-live-title {
          font-size: 12px;
          color: rgba(194,198,214,0.5);
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 44ch;
        }
        .onboarding-live-stat {
          font-size: 20px;
          font-weight: 720;
          color: #f0f4ff;
          min-width: 36px;
        }
        .onboarding-live-label {
          font-size: 13px;
          color: #c2c6d6;
        }
        .onboarding-reassurance {
          font-size: 12px;
          color: rgba(194,198,214,0.5);
          margin: 0;
        }
        .onboarding-skip-link {
          background: none;
          border: none;
          color: rgba(194,198,214,0.5);
          font-size: 12.5px;
          cursor: pointer;
          padding: 0;
          text-align: center;
          transition: color 140ms ease;
        }
        .onboarding-skip-link:hover {
          color: #c2c6d6;
        }
        .onboarding-proof-pending {
          display: grid;
          justify-items: start;
          gap: 10px;
          padding: 12px 0 2px;
        }
        .onboarding-proof-pending .onboarding-breath {
          height: auto;
          justify-content: flex-start;
        }
        .onboarding-proof-pending p {
          margin: 0;
          color: #f0f4ff;
          font-size: 20px;
          line-height: 1.45;
          max-width: 32ch;
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
