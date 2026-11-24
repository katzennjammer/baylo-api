import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // React Compiler readiness rules. The compiler is NOT enabled (no
  // reactCompiler in next.config.ts), so these flag nothing that runs
  // differently today -- most hits are Date.now() in server components and the
  // retired /dashboard web UI. Warnings, not errors, until the compiler is on.
  {
    // The same files eslint-config-next registers the react-hooks plugin for.
    // Without this the block also matched files that plugin does not cover,
    // and ESLint stopped with "could not find plugin react-hooks".
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
