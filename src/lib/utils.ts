import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn/ui standard className helper.
 * Combines clsx with tailwind-merge to handle Tailwind class conflicts.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Generate a short, URL-safe ID using nanoid.
 * Used for job ids, asset ids, etc.
 */
export { nanoid } from 'nanoid'
