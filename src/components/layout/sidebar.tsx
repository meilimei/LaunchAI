'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sparkles, Rocket, Clock, Settings, Menu } from 'lucide-react'
import { useState } from 'react'

export function Sidebar() {
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)

  const navItems = [
    { name: 'New Launch', href: '/launch', icon: Rocket },
    { name: 'History', href: '/history', icon: Clock },
    { name: 'Settings', href: '/settings', icon: Settings },
  ]

  return (
    <>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed top-4 left-4 z-50 md:hidden p-2 rounded-md bg-background border shadow-sm"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div
        className={`fixed inset-y-0 left-0 z-40 w-64 transform border-r bg-background transition-transform duration-200 ease-in-out md:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        } flex flex-col`}
      >
        <div className="flex h-16 shrink-0 items-center px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-lg text-primary">
            <Sparkles className="h-5 w-5" />
            LaunchAI
          </Link>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto pt-4 pb-4">
          <nav className="flex-1 space-y-1 px-4">
            {navItems.map((item) => {
              const isActive = pathname === item.href
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  <item.icon
                    className={`h-4 w-4 shrink-0 ${
                      isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                    }`}
                  />
                  {item.name}
                </Link>
              )
            })}
          </nav>
        </div>
      </div>
    </>
  )
}
