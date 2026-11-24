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
  const integ = [];
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const parts = ev.data.name.split(SEP);
    if (parts[0] === "INTEG" && parts.length === 6) {
      const failed = ev.type === "test:fail";
      const reason = failed ? String(ev.data.details?.error?.cause?.message ?? ev.data.details?.error?.message ?? "error").split("\n")[0] : "";
      integ.push({
        m1: parts[1], process: parts[2], m2: parts[3], pre: parts[4], expected: parts[5],
        actual: failed ? `Did not perform as expected: ${reason}` : "Performed as expected",
        result: failed ? "FAILED" : "PASSED", file: ev.data.file ?? "", line: ev.data.line ?? 0,
      });
      continue;
    }
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

  if (integ.length > 0) {
    integ.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    integ.forEach((r, i) => (r.id = `IntegTestCase-${String(i + 1).padStart(2, "0")}`));
    const ih = "| Proponent | Test Case ID | Module 1 | Integration Process | Module 2 | Pre-condition | Expected Result | Result | Remarks |\n|---|---|---|---|---|---|---|---|---|";
    const il = (r) => `| ${esc(PROPONENT)} | ${r.id} | ${esc(r.m1)} | ${esc(r.process)} | ${esc(r.m2)} | ${esc(r.pre)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.result} |`;
    const ip = integ.filter((r) => r.result === "PASSED").length;
    const imd = `# Integration Testing Report\n\nGenerated ${DATE}. ${integ.length} cases, ${ip} passed, ${integ.length - ip} failed.\n\n## Table 1: Integration Testing\n\n${ih}\n${integ.map(il).join("\n")}\n`;
    const icsv = [["Proponent", "Test Case ID", "Module 1", "Integration Process", "Module 2", "Pre-condition", "Expected Result", "Result", "Remarks"].map(csv).join(","), ...integ.map((r) => [PROPONENT, r.id, r.m1, r.process, r.m2, r.pre, r.expected, r.actual, r.result].map(csv).join(","))].join("\n");
    mkdirSync("tests/report", { recursive: true });
    writeFileSync("tests/report/integration-test-report.md", imd);
    writeFileSync("tests/report/integration-test-report.csv", icsv + "\n");
    yield `\nIntegration-testing table: ${integ.length} cases (${ip} passed) -> tests/report/integration-test-report.md and .csv\n`;
  }
  if (rows.length === 0) return;

  const rank = (m) => { const i = MODULE_ORDER.indexOf(m); return i === -1 ? 99 : i; };
  rows.sort((a, b) => rank(a.module) - rank(b.module) || a.file.localeCompare(b.file) || a.line - b.line);

  // Case IDs run continuously down the whole table, like a thesis test table.
  let n = 0;
  for (const r of rows) r.id = `Case-${String(++n).padStart(3, "0")}`;
  const counters = new Map(rows.map((r) => [r.module, 1]));

  const head = "| Proponent | Module Name | Unit Name | Date Tested | Test Case ID | Test Case Description | Expected Result | Actual Result | Result |\n|---|---|---|---|---|---|---|---|---|";
  const line = (r) => `| ${esc(PROPONENT)} | ${esc(r.module)} | ${esc(r.unit)} | ${DATE} | ${r.id} | ${esc(r.description)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.result} |`;

  const passed = rows.filter((r) => r.result === "PASSED").length;
  let md = `# Unit Testing Report\n\nGenerated ${DATE}. ${rows.length} cases, ${passed} passed, ${rows.length - passed} failed.\n`;
  md += `\n## Table 1: Unit Testing\n\n${head}\n${rows.map(line).join("\n")}\n`;

  const header = ["Proponent", "Module Name", "Unit Name", "Date Tested", "Test Case ID", "Test Case Description", "Expected Result", "Actual Result", "Result"];
  const csvText = [header.map(csv).join(","), ...rows.map((r) => [PROPONENT, r.module, r.unit, DATE, r.id, r.description, r.expected, r.actual, r.result].map(csv).join(","))].join("\n");

  mkdirSync("tests/report", { recursive: true });
  writeFileSync("tests/report/unit-test-report.md", md);
  writeFileSync("tests/report/unit-test-report.csv", csvText + "\n");
  yield `\nUnit-testing table: ${rows.length} cases (${passed} passed) -> tests/report/unit-test-report.md and .csv\n`;
}
