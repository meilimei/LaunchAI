'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

export function CopyButton({
  text,
  label = 'Copy',
  className,
  size = 'sm',
}: {
  text: string
  label?: string
  className?: string
  size?: 'xs' | 'sm'
}) {
  const [copied, setCopied] = useState(false)

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Fallback: select-and-copy via a hidden textarea (older browsers).
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } finally {
        document.body.removeChild(ta)
      }
    }
  }

  const isXs = size === 'xs'

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded border bg-background font-medium transition hover:bg-secondary',
        isXs ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs',
        copied && 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
        className,
      )}
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? (
        <Check className={isXs ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      ) : (
        <Copy className={isXs ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      )}
      {copied ? 'Copied' : label}
    </button>
  )
}
