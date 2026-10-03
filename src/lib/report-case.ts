// Reports are REPORT rows of ModerationCase since schema v2 (Report and
// ListingAppeal were merged). Two helpers keep the report code reading as it
// did:
//
//   REPORT            spread into every report WHERE -- without it a count or
//                     a queue would include listing appeals.
//   asReport(row)     the selected row under the old names: filedBy ->
//                     reporter, decidedBy -> resolvedBy, decidedAt ->
//                     resolvedAt, decisionNote -> resolutionNote (and the *Id
//                     columns), with targetType / targetId / category narrowed
//                     to non-null. The narrowing is not a guess: the
//                     ModerationCase_report_shape_check constraint makes all
//                     three NOT NULL on every REPORT row.
//
// Queries still select the NEW column names; only results are renamed.

export const REPORT = { type: "REPORT" } as const

type Renamed<T> = Omit<T, "filedBy" | "filedById" | "decidedBy" | "decidedById" | "decidedAt" | "decisionNote" | "targetType" | "targetId" | "category"> &
  (T extends { filedBy: infer V } ? { reporter: V } : unknown) &
  (T extends { filedById: infer V } ? { reporterId: V } : unknown) &
  (T extends { decidedBy: infer V } ? { resolvedBy: V } : unknown) &
  (T extends { decidedById: infer V } ? { resolvedById: V } : unknown) &
  (T extends { decidedAt: infer V } ? { resolvedAt: V } : unknown) &
  (T extends { decisionNote: infer V } ? { resolutionNote: V } : unknown) &
  (T extends { targetType: infer V } ? { targetType: NonNullable<V> } : unknown) &
  (T extends { targetId: infer V } ? { targetId: NonNullable<V> } : unknown) &
  (T extends { category: infer V } ? { category: NonNullable<V> } : unknown)

const RENAMES: Record<string, string> = {
  filedBy: "reporter",
  filedById: "reporterId",
  decidedBy: "resolvedBy",
  decidedById: "resolvedById",
  decidedAt: "resolvedAt",
  decisionNote: "resolutionNote",
}

export function asReport<T extends object>(row: T): Renamed<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[RENAMES[k] ?? k] = v
  return out as Renamed<T>
}
