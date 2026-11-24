/**
 * A fake database and session for running the REAL admin route handlers.
 * Import this module FIRST in a test file (its mocks must exist before a route
 * is imported). Any table the test did not fake throws "DB touched", which is
 * how a test proves a request was refused before it reached the database.
 */
import { mock } from "node:test"
import { NextRequest } from "next/server"

export interface FakeUser {
  id: string
  name?: string | null
  email?: string | null
  role: "USER" | "ADMIN"
  deletedAt?: Date | null
  suspensions: { startsAt: Date; endsAt: Date | null; liftedAt: Date | null; reason?: string; level?: number }[]
}

export const env = {
  sessionUserId: null as string | null,
  users: {} as Record<string, FakeUser>,
  suspensionCount: 0,
  created: [] as unknown[],
  audits: [] as { action: string; targetId: string; reason: string; detail: string | null }[],
  lifted: 0,
  tables: {} as Record<string, unknown>,
}

export function reset() {
  env.sessionUserId = null
  env.users = {}
  env.suspensionCount = 0
  env.created = []
  env.audits = []
  env.lifted = 0
  env.tables = {}
}

export function signInAs(user: FakeUser) {
  env.users[user.id] = user
  env.sessionUserId = user.id
}

const txBase: Record<string, unknown> = {
  suspension: {
    count: async () => env.suspensionCount,
    create: async (a: { data: unknown }) => void env.created.push(a.data),
    updateMany: async () => void env.lifted++,
  },
  adminAction: {
    create: async (a: { data: { action: string; targetId: string; reason: string; detail: string | null } }) =>
      void env.audits.push(a.data),
  },
}

const tx = new Proxy(txBase, { get: (t, k) => (k in t ? t[k as string] : env.tables[k as string]) }) as typeof txBase & Record<string, never>

const base: Record<string, unknown> = {
  user: { findUnique: async ({ where }: { where: { id: string } }) => env.users[where.id] ?? null },
  $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
}
const prisma = new Proxy(base, {
  get(target, key) {
    if (typeof key === "symbol" || key === "__esModule" || key === "then") return undefined
    if (key in target) return target[key as string]
    if (typeof key === "string" && key in env.tables) return env.tables[key]
    return new Proxy({}, {
      get: (_t, method) => () => {
        throw new Error(`DB touched: ${String(key)}.${String(method)}`)
      },
    })
  },
})

mock.module("next/headers", { namedExports: { headers: async () => new Headers() } })
mock.module("@root/auth", {
  namedExports: { auth: async () => (env.sessionUserId ? { user: { id: env.sessionUserId, name: "Test", email: "t@example.com" } } : null) },
})
mock.module("@/lib/prisma", { defaultExport: prisma })

export const admin = (over: Partial<FakeUser> = {}): FakeUser => ({ id: "admin-1", role: "ADMIN", suspensions: [], ...over })
export const member = (over: Partial<FakeUser> = {}): FakeUser => ({ id: "user-1", role: "USER", suspensions: [], ...over })

export function call(handler: unknown, method: string, body?: unknown, id = "target-1") {
  const req = new NextRequest("http://localhost/api/admin/x", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined || method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  })
  return (handler as (r: unknown, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ id }) })
}
