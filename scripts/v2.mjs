// The ONE way to run schema-v2 code against the scratch copy.
//
//   npm run dev:v2                          next dev -H 0.0.0.0 on the copy
//   npm run v2:tsx -- scripts/verify-x.ts   any tsx script on the copy
//   npm run v2:prisma -- migrate status     any Prisma CLI command on the copy
//
// It reads DATABASE_URL from .env.v2 (gitignored), checks it names a
// schema_v2_* schema, and starts the child with THAT url in its environment.
// Next.js and dotenv never override a variable that is already set, so the
// child's .env (live) cannot win. DATABASE_POOL_URL is removed from the child
// as well: it is the live transaction pooler, and nothing here may reach it.
//
// Nothing else on this branch reads .env.v2, and nothing on the pre-v2
// branches knows it exists, so plain `npm run dev` stays exactly as it was.
import { readFileSync, existsSync } from "node:fs"
import { spawn } from "node:child_process"

const [mode, ...rest] = process.argv.slice(2)
const die = (msg) => { console.error(`\n  [v2] REFUSING: ${msg}\n`); process.exit(1) }

if (!existsSync(".env.v2")) die(".env.v2 is missing. It holds DATABASE_URL=...?schema=schema_v2_wk1")
const line = readFileSync(".env.v2", "utf8").split(/\r?\n/).filter((l) => /^\s*DATABASE_URL\s*=/.test(l)).pop()
if (!line) die(".env.v2 has no DATABASE_URL")
const url = line.replace(/^\s*DATABASE_URL\s*=\s*"?([^"]*)"?\s*$/, "$1")
let schema
try { schema = new URL(url).searchParams.get("schema") } catch { die(".env.v2 DATABASE_URL is not a URL") }
if (!schema || !/^schema_v2_[a-z0-9_]+$/.test(schema)) die(`.env.v2 must name a schema_v2_* schema (got ${schema ?? "none, which is public = LIVE"})`)

const env = { ...process.env, DATABASE_URL: url }
delete env.DATABASE_POOL_URL

const bin = (name) => (process.platform === "win32" ? `node_modules\\.bin\\${name}.cmd` : `node_modules/.bin/${name}`)
const cmds = {
  dev: [bin("next"), ["dev", "-H", "0.0.0.0", ...rest]],
  tsx: [bin("tsx"), ["--env-file=.env", ...rest]],
  prisma: [bin("prisma"), rest],
}
if (!cmds[mode]) die(`unknown mode "${mode}" (dev | tsx | prisma)`)
// tsx's --env-file loads .env for the OTHER secrets; it does not override
// DATABASE_URL, which is already in the environment.
console.log(`  [v2] ${mode} on schema "${schema}"`)
const [cmd, args] = cmds[mode]
const child = spawn(cmd, args, { env, stdio: "inherit", shell: process.platform === "win32" })
child.on("exit", (code) => process.exit(code ?? 1))
