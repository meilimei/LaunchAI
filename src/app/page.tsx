import Link from 'next/link'
import { ArrowRight, Sparkles, Zap, Eye, RefreshCw } from 'lucide-react'

export default function Home() {
  return (
    <main className="relative flex min-h-screen flex-col">
      <header className="container flex h-16 items-center justify-between">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <Sparkles className="h-5 w-5" />
          LaunchAI
        </div>
        <nav className="flex items-center gap-6 text-sm text-muted-foreground">
          <Link href="#how" className="hover:text-foreground">
            How it works
          </Link>
          <Link href="#pricing" className="hover:text-foreground">
            Pricing
          </Link>
          <Link
            href="/launch"
            className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:opacity-90"
          >
            Try free
          </Link>
        </nav>
      </header>

      <section className="container flex flex-1 flex-col items-center justify-center gap-8 py-24 text-center">
        <div className="rounded-full border bg-secondary/40 px-3 py-1 text-xs font-medium text-muted-foreground">
          For Chrome extension makers
        </div>

        <h1 className="max-w-3xl text-balance text-5xl font-bold tracking-tight md:text-6xl">
          Drop a URL.<br />
          Ship your launch in <span className="text-primary">5 minutes</span>.
        </h1>

        <p className="max-w-xl text-pretty text-lg text-muted-foreground">
          LaunchAI auto-analyzes your Chrome extension and competitors, then
          generates a full multi-channel launch package — Chrome Store listing,
          Product Hunt, Reddit, Hacker News, X — with each AI decision visible
          and editable.
        </p>

        <Link
          href="/launch"
          className="group inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground transition hover:opacity-90"
        >
          Start your launch
          <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </Link>
      </section>

      <section id="how" className="container border-t py-20">
        <h2 className="mb-12 text-center text-3xl font-bold tracking-tight">
          How LaunchAI works
        </h2>
        <div className="grid gap-8 md:grid-cols-4">
          {[
            {
              icon: Zap,
              title: 'Crawl',
              desc: 'Auto-fetches your product + top 10 competitors from Chrome Web Store.',
            },
            {
              icon: Sparkles,
              title: 'Analyze',
              desc: 'Multi-agent extraction of features, pain points, keywords, tone.',
            },
            {
              icon: Eye,
              title: 'Generate',
              desc: '6 channels × 3 versions, with a critic agent picking the best.',
            },
            {
              icon: RefreshCw,
              title: 'Ship',
              desc: 'One-click copy or deep-link to each platform. You publish, not us.',
            },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-lg border p-6">
              <Icon className="mb-3 h-5 w-5 text-primary" />
              <h3 className="mb-2 font-semibold">{title}</h3>
              <p className="text-sm text-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="container border-t py-8 text-center text-sm text-muted-foreground">
        <p>
          LaunchAI · Autonomous launch agent for indie makers · v0.1
        </p>
      </footer>
    </main>
  )
}
