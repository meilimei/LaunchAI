import { Sparkles, ArrowRight } from 'lucide-react'

export default function LaunchPage() {
  return (
    <main className="flex h-full min-h-[calc(100vh-4rem)] flex-col items-center justify-center p-6 md:p-12">
      <div className="flex w-full max-w-2xl flex-col items-center gap-8 text-center">
        
        {/* Title Section */}
        <div className="space-y-4">
          <div className="inline-flex items-center justify-center rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
            <Sparkles className="mr-2 h-4 w-4" />
            AI Launch Agent
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl md:text-6xl text-foreground">
            Start a New Launch
          </h1>
          <p className="mx-auto max-w-lg text-lg text-muted-foreground">
            Paste your Chrome Web Store URL. LaunchAI handles competitor analysis, 
            messaging, and generates a multi-channel launch package in minutes.
          </p>
        </div>

        {/* Input Section */}
        <form
          className="relative w-full group"
          action="/api/launch"
          method="POST"
        >
          {/* Subtle Glow Effect behind input */}
          <div className="absolute -inset-1 rounded-2xl bg-primary/20 opacity-0 blur-xl transition-all duration-500 group-hover:opacity-100 group-focus-within:opacity-100"></div>
          
          <div className="relative flex flex-col sm:flex-row items-center rounded-2xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-primary/50 transition-all">
            <input
              type="url"
              name="url"
              required
              placeholder="https://chromewebstore.google.com/detail/..."
              className="w-full flex-1 bg-transparent px-4 py-3 text-base placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              type="submit"
              className="mt-2 sm:mt-0 w-full sm:w-auto inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              Generate
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </form>

        {/* Helper Text */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex h-1.5 w-1.5 rounded-full bg-green-500"></span>
          Ready to analyze. Supports Chrome Web Store URLs only.
        </div>
      </div>
    </main>
  )
}

