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
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Insights</h1>
        <button
          onClick={() => ipc.ai.clearHistory().then(() => setMessages([]))}
          className="text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        {messages.length === 0 && !loading && (
          <p className="text-[var(--color-text-secondary)] text-[13px]">
            Ask anything about your activity — e.g. "How was my focus this week?"
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === 'user' ? 'self-end max-w-lg' : 'self-start max-w-2xl'}
          >
            <div
              className={[
                'px-4 py-2.5 rounded-xl text-[13px] leading-relaxed',
                m.role === 'user'
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] border border-[var(--color-border)]',
              ].join(' ')}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="self-start">
            <div className="px-4 py-2.5 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-secondary)] text-[13px]">
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-[var(--color-border)]">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask about your productivity…"
            disabled={loading}
            className="flex-1 px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-md bg-[var(--color-accent)] text-white text-[13px] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
