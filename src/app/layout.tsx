import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'LaunchAI — Autonomous launch agent for Chrome extensions',
  description:
    'Drop your Chrome Web Store URL. LaunchAI auto-analyzes competitors and generates your full multi-channel launch package.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
