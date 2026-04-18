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

function SummaryTile({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="onboarding-summary-tile">
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
      label: 'Current activity',
      value: snapshot.liveSession.appName,
      detail: snapshot.liveSession.windowTitle || 'Live session detected right now',
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
        detail: 'Named pages and browser context are already flowing in.',
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
  const onboardingTrackedRef = useRef(false)
  const proofTrackedRef = useRef(false)

  const platform = settings.onboardingState.platform
  const stage = settings.onboardingState.stage
  const isMac = platform === 'macos'
  const proofTiles = useMemo(() => proofDetail(proof), [proof])

  useEffect(() => {
    if (onboardingTrackedRef.current) return
    onboardingTrackedRef.current = true
    track(ANALYTICS_EVENT.ONBOARDING_STARTED, {
      stage,
      surface: 'onboarding',
      trigger: 'navigation',
    })
  }, [stage])

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
        if (settings.onboardingState.proofState !== nextProofState || settings.onboardingState.stage !== 'proof') {
          const nextState = {
            ...settings.onboardingState,
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
  }, [settings, stage])

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

  return (
    <div className="onboarding-root">
      <div className="onboarding-shell">
        {stage === 'welcome' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="Welcome"
              title="Daylens turns raw activity into a real picture of your work."
              body={isMac
                ? 'Everything stays grounded in local activity. On Mac, Daylens needs Screen Recording permission so it can read window titles and context. It does not record or upload video.'
                : 'Everything starts locally on this machine. Daylens will begin reconstructing today into real work blocks, so the Timeline has proof before you ever touch AI.'}
            />
            <div className="onboarding-callout">
              <div className="onboarding-callout-title">What to expect</div>
              <div className="onboarding-callout-body">
                {isMac
                  ? 'A quick permission step, then a restart, then Daylens shows you real tracked proof before any personalization.'
                  : 'A quick proof step, one optional personalization pass, and then you land in Timeline with real activity already showing up.'}
              </div>
            </div>
            <button className="onboarding-btn-primary" onClick={() => void handleContinueFromWelcome()}>
              Continue
            </button>
          </div>
        )}

        {stage === 'permission' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="Screen Recording"
              title="macOS calls this Screen Recording. Daylens uses it for context, not video."
              body="Without this permission, Daylens cannot read the active window title or reconstruct what you were actually working on. Nothing here records your screen or uploads video anywhere."
            />
            <div className="onboarding-callout">
              <div className="onboarding-callout-title">How it works</div>
              <div className="onboarding-callout-body">
                Open System Settings, enable Daylens under Screen Recording, then come back here. Once it is enabled, Daylens needs one restart before tracking becomes fully available.
              </div>
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void beginPermissionRequest()} disabled={busy}>
                {busy ? 'Opening settings…' : 'Open Screen Recording Settings'}
              </button>
              <button className="onboarding-btn-secondary" onClick={() => void refreshPermissionState()}>
                I already enabled it
              </button>
            </div>
            <div className="onboarding-hint">
              Permission status: {permissionState === 'granted' ? 'Enabled' : permissionState === 'awaiting_relaunch' ? 'Ready for restart' : 'Still missing'}
            </div>
          </div>
        )}

        {stage === 'relaunch_required' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="Almost there"
              title="Daylens is ready. One restart makes the permission take effect."
              body="macOS only unlocks window titles for apps that relaunch after Screen Recording is granted. Restart Daylens now and it will come back into proof mode."
            />
            <button className="onboarding-btn-primary" onClick={() => void ipc.app.relaunch()}>
              Restart Daylens
            </button>
          </div>
        )}

        {stage === 'verifying_permission' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="Verifying"
              title="Checking Screen Recording access and starting Daylens."
              body="Daylens is confirming the macOS permission after relaunch so the Timeline can open with real window titles and context instead of an empty shell."
            />
            <div className="onboarding-proof-card">
              <div className="onboarding-proof-pending">
                <span className="onboarding-spinner" aria-hidden="true" />
                <div>
                  <div className="onboarding-callout-title">Verifying permission</div>
                  <div className="onboarding-callout-body">
                    If macOS kept the permission, Daylens will move straight into proof. If not, you will land back on the permission step with the exact next action.
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {stage === 'proof' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="Proof"
              title={proof.ready ? 'Daylens is working.' : 'Looking for your first real signal…'}
              body={proof.ready
                ? 'This is the moment Daylens should earn trust: real activity, live context, and a Timeline that will not open empty.'
                : 'Keep Daylens open for a moment while it detects live work or reconstructs the first useful block from local history.'}
            />
            <div className="onboarding-proof-card">
              {!proof.ready && (
                <div className="onboarding-proof-pending">
                  <span className="onboarding-spinner" aria-hidden="true" />
                  <div>
                    <div className="onboarding-callout-title">Gathering local proof</div>
                    <div className="onboarding-callout-body">
                      Daylens is waiting for a live session, browser evidence, or the first reconstructed work block.
                    </div>
                  </div>
                </div>
              )}
              {proofTiles.length > 0 && (
                <div className="onboarding-summary-grid">
                  {proofTiles.map((item) => (
                    <SummaryTile key={item.label} label={item.label} value={item.value} detail={item.detail} />
                  ))}
                </div>
              )}
            </div>
            <button className="onboarding-btn-primary" disabled={!proof.ready} onClick={() => void continueFromProof()}>
              Open the last step
            </button>
          </div>
        )}

        {stage === 'personalize' && (
          <div className="onboarding-screen">
            <StageHeading
              eyebrow="Personalize"
              title="Pick what you want Daylens to help with first."
              body="This is optional and lightweight. It only tunes what Daylens emphasizes once you land in the real app."
            />
            <div className="onboarding-goals-grid">
              {GOALS.map((goal) => {
                const selected = goals.has(goal.id)
                return (
                  <button
                    key={goal.id}
                    className="onboarding-goal-card"
                    onClick={() => toggleGoal(goal.id)}
                    style={{
                      borderColor: selected ? 'rgba(125, 193, 255, 0.45)' : 'var(--color-border-ghost)',
                      background: selected ? 'rgba(97, 165, 255, 0.10)' : 'var(--color-surface)',
                    }}
                  >
                    <div className="onboarding-goal-dot" />
                    <span>{goal.label}</span>
                  </button>
                )
              })}
            </div>
            <div className="onboarding-actions">
              <button className="onboarding-btn-primary" onClick={() => void finishOnboarding()} disabled={busy}>
                {busy ? 'Opening Timeline…' : 'Open Timeline'}
              </button>
              <button className="onboarding-btn-secondary" onClick={() => void finishOnboarding()} disabled={busy}>
                Skip this part
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
            radial-gradient(circle at top left, rgba(92, 151, 255, 0.14), transparent 38%),
            radial-gradient(circle at bottom right, rgba(79, 219, 200, 0.10), transparent 34%),
            #0b0f16;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 36px 24px;
          -webkit-app-region: drag;
        }
        .onboarding-shell {
          width: min(720px, 100%);
          border-radius: 28px;
          border: 1px solid rgba(173, 198, 255, 0.14);
          background: rgba(9, 13, 20, 0.88);
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
          padding: 34px 34px 28px;
          -webkit-app-region: no-drag;
          backdrop-filter: blur(22px);
        }
        .onboarding-screen {
          display: grid;
          gap: 22px;
        }
        .onboarding-eyebrow {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--color-text-tertiary);
        }
        .onboarding-title {
          margin: 0;
          font-size: 34px;
          line-height: 1.04;
          letter-spacing: -0.04em;
          color: var(--color-text-primary);
        }
        .onboarding-sub {
          margin: 0;
          font-size: 14.5px;
          line-height: 1.75;
          color: var(--color-text-secondary);
          max-width: 62ch;
        }
        .onboarding-callout,
        .onboarding-proof-card {
          border-radius: 20px;
          border: 1px solid var(--color-border-ghost);
          background: rgba(255, 255, 255, 0.02);
          padding: 18px 18px 16px;
        }
        .onboarding-callout-title,
        .onboarding-summary-label {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--color-text-tertiary);
        }
        .onboarding-callout-body,
        .onboarding-summary-detail,
        .onboarding-hint {
          font-size: 13px;
          line-height: 1.7;
          color: var(--color-text-secondary);
        }
        .onboarding-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .onboarding-btn-primary,
        .onboarding-btn-secondary {
          height: 42px;
          padding: 0 16px;
          border-radius: 12px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 140ms ease, border-color 140ms ease, opacity 140ms ease;
        }
        .onboarding-btn-primary {
          border: none;
          background: linear-gradient(135deg, #7bb7ff 0%, #4fd3c6 100%);
          color: #07131b;
        }
        .onboarding-btn-secondary {
          border: 1px solid var(--color-border-ghost);
          background: transparent;
          color: var(--color-text-primary);
        }
        .onboarding-btn-primary:disabled,
        .onboarding-btn-secondary:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .onboarding-summary-grid,
        .onboarding-goals-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
        }
        .onboarding-summary-tile,
        .onboarding-goal-card {
          border-radius: 18px;
          border: 1px solid var(--color-border-ghost);
          background: rgba(255, 255, 255, 0.025);
          padding: 16px 16px 14px;
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
          margin-top: 18px;
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
        @media (max-width: 720px) {
          .onboarding-shell {
            padding: 24px 20px 20px;
            border-radius: 24px;
          }
          .onboarding-title {
            font-size: 28px;
          }
        }
      `}</style>
    </div>
  )
}
