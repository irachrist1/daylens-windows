import { useState } from 'react'
import { track } from '../lib/analytics'

interface Props {
  onClose: () => void
}

export default function FeedbackModal({ onClose }: Props) {
  const [score, setScore] = useState<number | null>(null)
  const [comment, setComment] = useState('')

  function handleSubmit() {
    if (score === null) return
    track('feedback_submitted', { score, has_comment: comment.length > 0 })
    onClose()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: 'var(--color-surface-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 16,
          padding: 28,
          width: 420,
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <div>
          <p
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: 'var(--color-text-primary)',
              margin: 0,
              letterSpacing: '-0.3px',
            }}
          >
            How's Daylens working for you?
          </p>
        </div>

        {/* NPS row */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
            const selected = score === n
            return (
              <button
                key={n}
                onClick={() => setScore(n)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  border: selected
                    ? '1.5px solid var(--color-brand-light)'
                    : '1px solid var(--color-border)',
                  background: selected
                    ? 'var(--color-brand-light)'
                    : 'var(--color-surface-high)',
                  color: selected ? '#051425' : 'var(--color-text-secondary)',
                  fontSize: 13,
                  fontWeight: selected ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'background 150ms, border-color 150ms, color 150ms',
                  fontFamily: 'inherit',
                }}
              >
                {n}
              </button>
            )
          })}
        </div>

        {/* Optional comment */}
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="What's on your mind?"
          maxLength={500}
          rows={3}
          style={{
            width: '100%',
            padding: '10px 12px',
            background: 'var(--color-surface-high)',
            border: '1px solid var(--color-border)',
            borderRadius: 10,
            fontSize: 13,
            color: 'var(--color-text-primary)',
            resize: 'vertical',
            outline: 'none',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-accent)'
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border)'
          }}
        />

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSubmit}
            disabled={score === null}
            style={{
              flex: 1,
              padding: '10px 0',
              borderRadius: 10,
              border: 'none',
              background: score !== null ? 'var(--color-accent)' : 'var(--color-surface-high)',
              color: score !== null ? 'var(--color-surface)' : 'var(--color-text-tertiary)',
              fontSize: 13,
              fontWeight: 600,
              cursor: score !== null ? 'pointer' : 'not-allowed',
              transition: 'background 150ms, color 150ms',
              fontFamily: 'inherit',
            }}
          >
            Submit
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 13,
              color: 'var(--color-text-tertiary)',
              cursor: 'pointer',
              padding: '4px 0',
              fontFamily: 'inherit',
              transition: 'color 150ms',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--color-text-secondary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--color-text-tertiary)'
            }}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
