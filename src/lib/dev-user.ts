import { db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'

/**
 * Phase C-1: bootstrap a single dev user so the API can run without auth.
 * Phase C-2 (later): replace with Clerk-derived userId.
 */
export const DEV_USER_ID = 'dev-user'

export async function ensureDevUser(): Promise<string> {
  await db
    .insert(users)
    .values({
      id: DEV_USER_ID,
      email: 'dev@launchai.local',
      plan: 'pro',
    })
    .onConflictDoNothing({ target: users.id })
  return DEV_USER_ID
}
