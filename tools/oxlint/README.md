# oxlint tools

## anti-slop

`anti-slop/` is [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)
(MIT, upstream commit `c44ef22`). The upstream project publishes no npm
package. It expects each repository to keep and edit its own copy.

- The copy holds `src/index.ts`, `src/rules`, `src/shared` and
  `src/vendor`. The rule tests and the Effect rules are not copied. This
  repository does not use Effect.
- `oxlint.config.ts` loads the plugin through `jsPlugins` and turns on each
  generic rule at `"error"`.
- oxlint and oxfmt ignore the directory. Keep the files the same as
  upstream, so that an update gives a clean diff.
- Keep `oxlint` and `@oxlint/plugins` at the same exact version in the root
  `package.json`. The plugin API can change between minor versions, so
  update the two packages together.

### How to fix a finding

Fix the cause. Do not disable a rule, and do not add an `oxlint-disable`
comment.

- `require-safety-comment-for-type-assertion`: remove the assertion where
  possible. Parse a network or JSON response with zod, and narrow an error
  with `instanceof`. If an assertion must stay, add a `// SAFETY:` comment
  that states the invariant that TypeScript cannot see.
- `no-runtime-typeof`: delete the check if the type already covers it, or
  move it into a named type predicate. The config allows `typeof` inside a
  type guard (`allowInTypeGuards`).
- `no-unsafe-dictionary-type`, `no-unknown-parameters` and
  `no-unknown-returns`: give the value a real type, for example `JsonValue`
  for parsed JSON.
- `no-known-value-widening`: name the return type. A constant table that is
  read with a runtime string can become a `Map`.
- `no-conditional-empty-object-spread`: set the key in a statement.
- `require-readable-spacing` adds blank lines. `pnpm lint` fixes it.
