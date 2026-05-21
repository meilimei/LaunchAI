import { Sidebar } from '@/components/layout/sidebar'

export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="relative min-h-screen bg-background">
      <Sidebar />
      <div className="md:ml-64 pt-16 md:pt-0 min-h-screen transition-all duration-200">
        <main className="h-full w-full">
          {children}
        </main>
      </div>
    </div>
  )
}
