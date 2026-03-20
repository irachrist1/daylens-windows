import { useEffect, useRef, useState } from 'react'
import { ipc } from '../lib/ipc'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export default function Insights() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ipc.ai.getHistory().then((history) => {
      setMessages(history as Message[])
    })
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)
    try {
      const reply = (await ipc.ai.sendMessage(text)) as string
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Error: ' + String(err) },
      ])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-7 py-5 border-b border-[var(--color-border)]">
        <div>
          <p className="section-label mb-0.5">AI</p>
          <h1 className="text-[17px] font-semibold text-[var(--color-text-primary)] tracking-tight leading-none">
            Insights
          </h1>
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => ipc.ai.clearHistory().then(() => setMessages([]))}
            className="text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors px-3 py-1.5 rounded-lg hover:bg-[var(--color-surface-high)]"
          >
            New chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-7 py-5 flex flex-col gap-4">
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-3xl mb-3 opacity-20">✦</div>
            <p className="text-[14px] font-medium text-[var(--color-text-primary)] mb-1">Ask about your day</p>
            <p className="text-[13px] text-[var(--color-text-secondary)]">
              "How was my focus this week?" · "Which app used most of my time?"
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === 'user' ? 'self-end max-w-lg' : 'self-start max-w-2xl'}
          >
            <div
              className={[
                'px-4 py-3 rounded-xl text-[13px] leading-relaxed',
                m.role === 'user'
                  ? 'bg-[var(--color-accent)] text-[var(--color-surface)]'
                  : 'bg-[var(--color-surface-card)] text-[var(--color-text-primary)] border border-[var(--color-border)]',
              ].join(' ')}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="self-start">
            <div className="px-4 py-3 rounded-xl bg-[var(--color-surface-card)] border border-[var(--color-border)] text-[var(--color-text-secondary)] text-[13px]">
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="px-7 py-4 border-t border-[var(--color-border)]">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask about your productivity…"
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-card)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50 transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-5 py-2.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-surface)] text-[13px] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity shrink-0"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
