// Stands in for @root/auth (NextAuth) when route handlers run outside Next:
// the cookie path is never signed in. See scripts/lib/in-process-routes.ts.
exports.auth = async () => null
