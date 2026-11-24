import { test } from "node:test";

/**
 * One row of the unit-testing table.
 *
 *   const c = suite("Authentication");
 *   c("Register", "User inputs an invalid email format",
 *     "Account will not be registered", () => { ...assertions... });
 *
 * The four labels travel in the test name; tests/support/reporter.mjs splits
 * them back out and builds the report. Case IDs, dates and PASSED/FAILED are
 * filled in by the reporter, so nothing here is hand-numbered.
 */
export const SEP = " || ";

export function suite(moduleName: string) {
  return (unit: string, description: string, expected: string, fn: () => void | Promise<void>) => {
    test([moduleName, unit, description, expected].join(SEP), fn);
  };
}
