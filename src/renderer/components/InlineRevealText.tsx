import type { CSSProperties } from 'react'

interface InlineRevealTextProps {
  text: string
  className?: string
  style?: CSSProperties
  title?: string
}

export default function InlineRevealText({
  text,
  className,
  style,
  title,
}: InlineRevealTextProps) {
  return (
    <span
      className={className}
      title={title ?? text}
      style={{
        display: 'block',
        width: '100%',
        minWidth: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        ...style,
      }}
    >
      {text}
    </span>
  )
}
