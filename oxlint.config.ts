// Lint config for oxlint. Formatting is in .oxfmtrc.jsonc.
//
// The config is TypeScript, not JSON, because only a JS or TS config can
// load the anti-slop plugin through `jsPlugins`.
//
// oxlint does not check rule names. A rule name with a typo has no effect.
// Check a new name in node_modules/oxlint/configuration_schema.json.
import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "**/node_modules",
    "**/dist",
    "**/.wrangler",
    // The vendored plugin source. See tools/oxlint/README.md.
    "tools/oxlint/anti-slop/**",
    // An agent worktree is a full checkout with its own oxlint.config.ts.
    // Without this entry, oxlint registers the plugin two times and stops.
    "**/.claude/**",
  ],
  plugins: [
    "eslint",
    "typescript",
    "unicorn",
    "oxc",
    "react",
    "import",
    "promise",
  ],
  categories: {
    correctness: "error",
    suspicious: "error",
  },
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "typescript/consistent-type-imports": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "off",
    "no-shadow": "off",
    "unicorn/consistent-function-scoping": "off",
    "import/no-named-as-default": "off",
    "import/no-named-as-default-member": "off",
    "react/react-in-jsx-scope": "off",

    // anti-slop: every generic rule, at "error".
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    // A named type guard is the sanctioned place for a runtime check.
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    {
      files: ["ui/src/main.tsx"],
      rules: { "import/no-unassigned-import": "off" },
    },
  ],
});
