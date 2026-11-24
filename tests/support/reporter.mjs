// Custom node:test reporter. Collects every case registered through
// tests/support/case.ts and writes the unit-testing table:
//   tests/report/unit-test-report.md   (tables, one per module)
//   tests/report/unit-test-report.csv  (same rows, for Word/Excel)
// Set TESTER="Surname, Given N." to fill the Proponent column.
import { mkdirSync, writeFileSync } from "node:fs";

const SEP = " || ";
const MODULE_ORDER = [
  "Admin: Access Control",
  "Admin: User Suspension",
  "Admin: Reports and Listings",
  "Admin: ID Verification and Hubs",
  "Admin: Moderation Rules",
  "Admin: Reporting and Utilities",
];

const today = new Date();
const DATE = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
const PROPONENT = process.env.TESTER || "—";

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const csv = (s) => `"${String(s).replace(/"/g, '""')}"`;

export default async function* reporter(source) {
  const rows = [];
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const parts = ev.data.name.split(SEP);
    if (parts.length !== 4) continue;
    const [module, unit, description, expected] = parts;
    const failed = ev.type === "test:fail";
    const reason = failed ? String(ev.data.details?.error?.cause?.message ?? ev.data.details?.error?.message ?? "error").split("\n")[0] : "";
    rows.push({
      module, unit, description, expected,
      actual: failed ? `Did not perform as expected: ${reason}` : "Performed as expected",
      result: failed ? "FAILED" : "PASSED",
      file: ev.data.file ?? "", line: ev.data.line ?? 0,
    });
  }

  const rank = (m) => { const i = MODULE_ORDER.indexOf(m); return i === -1 ? 99 : i; };
  rows.sort((a, b) => rank(a.module) - rank(b.module) || a.file.localeCompare(b.file) || a.line - b.line);

  const counters = new Map();
  for (const r of rows) {
    const n = (counters.get(r.module) ?? 0) + 1;
    counters.set(r.module, n);
    r.id = `Case-${String(n).padStart(3, "0")}`;
  }

  const head = "| Proponent | Module Name | Unit Name | Date Tested | Test Case ID | Test Case Description | Expected Result | Actual Result | Result |\n|---|---|---|---|---|---|---|---|---|";
  const line = (r) => `| ${esc(PROPONENT)} | ${esc(r.module)} | ${esc(r.unit)} | ${DATE} | ${r.id} | ${esc(r.description)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.result} |`;

  const passed = rows.filter((r) => r.result === "PASSED").length;
  let md = `# Unit Testing Report\n\nGenerated ${DATE}. ${rows.length} cases, ${passed} passed, ${rows.length - passed} failed.\n`;
  let t = 0;
  for (const m of [...counters.keys()]) {
    t++;
    md += `\n## Table ${t}: Unit Testing — ${m}\n\n${head}\n${rows.filter((r) => r.module === m).map(line).join("\n")}\n`;
  }

  const header = ["Proponent", "Module Name", "Unit Name", "Date Tested", "Test Case ID", "Test Case Description", "Expected Result", "Actual Result", "Result"];
  const csvText = [header.map(csv).join(","), ...rows.map((r) => [PROPONENT, r.module, r.unit, DATE, r.id, r.description, r.expected, r.actual, r.result].map(csv).join(","))].join("\n");

  mkdirSync("tests/report", { recursive: true });
  writeFileSync("tests/report/unit-test-report.md", md);
  writeFileSync("tests/report/unit-test-report.csv", csvText + "\n");
  yield `\nUnit-testing table: ${rows.length} cases (${passed} passed) -> tests/report/unit-test-report.md and .csv\n`;
}
