// Harness for test-post-cutover-guards.ts: runs the server's startup gate
// (checkV2Database, exactly what src/instrumentation.ts calls) once, against
// the DATABASE_URL it is given. On a refusal the gate itself exits 1 with its
// message; on success this exits 0. It only reads (to_regclass lookups).
import { checkV2Database } from "../../src/instrumentation-node"

;(async () => {
  await checkV2Database()
  process.exit(0) // the Prisma pool would otherwise keep the process alive
})()
