// Stands in for next/headers when route handlers run outside Next.
// See scripts/lib/in-process-routes.ts.
exports.headers = async () => globalThis.__inProcessHeaders ?? new Headers()
exports.cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false })
