# ui

`@fullsend/ui`: the dashboard. React 19, Vite, Tailwind v4. The Worker
serves the build (`ui/dist`) through Workers Static Assets. Read the root
`CLAUDE.md` first.

## Traps

- **A dashboard page must never use a path that the public API owns.** The
  public API owns `/emails`, `/domains`, `/api-keys`, `/webhooks`,
  `/suppressions`, `/logs`, `/t` and `/health`, and Cloudflare Access
  bypasses them. The Worker also owns `/api` and Access owns `/cdn-cgi`.
  All dashboard pages live under `/dashboard`. A direct load of `/emails` gets the Resend API, not the UI.
- **Let the router add `/dashboard`.** `BASE` and `toUrl` are in
  `src/lib/router.tsx`. Screens and `ROUTES` in `src/App.tsx` use paths
  without the base (`/emails/:id`). `Link`, `navigate` and `toUrl` add it.
  `useLocation` removes it. Do not write `/dashboard` in a screen, and do
  not set `window.location` to a dashboard path by hand.
- **`/api/` and `/cdn-cgi/` paths get no base.** A click on a `Link` to one
  of them does a normal page load (for example the logout URL).
- **pixelarticons stays on 1.x** (`^1.8.1`, locked at 1.8.1). Version 2
  renamed the icons. `Icon` takes a plain string and makes the class
  `pixelart-icons-font-<name>`. A wrong name shows nothing and no check
  finds it. Look up a name in
  `node_modules/pixelarticons/fonts/pixelart-icons-font.css`.
- **In pixelarticons 1.8.1, the checkbox names are reversed.** `checkbox`
  is the box with the check mark. `checkbox-on` is the empty box. See
  `Checkbox` in `src/components/ui.tsx`.
- **Some icon glyphs do not fill their box.** `link` is 8 px tall in a
  16 px icon, and it sits high next to lowercase text. In a button, use
  a glyph that fills the box (`login`, `lock-open`, `reload`).
- **`Hint` in `screens/wizard/parts.tsx` flows its text inline.** For a
  list of lines, give each line `className="block"`.
- **The wizard footer is sticky** (`StepFrame`). It holds the main action
  of each step. Do not put the only action of a step in the step body.

## Lint rules that fail most often

oxlint runs the React rules as errors. Run `pnpm exec oxlint ui` for a fast
check. The full list is in `pnpm exec oxlint --print-config`.

- `react/set-state-in-effect`: do not call a setState function
  synchronously in an effect body. Set state in a promise callback, an
  event handler or a subscription callback. `useApi` in
  `src/lib/hooks.ts` shows the pattern.
- `react/refs`: do not read or write `ref.current` during render. Do it in
  an effect or an event handler (see `usePoll`).
- `react/purity`: do not call an impure function such as `Date.now()` or
  `Math.random()` during render. Use `useNow()` from `src/lib/hooks.ts`, or
  a `useState` initializer function.
- `react/set-state-in-render`: do not call a setState function during
  render.
- `react/immutability`: do not change props, state or a hook value in
  place. Make a new object.
- `react/static-components` and `react/no-unstable-nested-components`: do
  not define a component inside a component.
- `react/exhaustive-deps` is an error. Give every dependency.
- `react/iframe-missing-sandbox` is an error. Each iframe needs a
  `sandbox` attribute (see the previews in `EmailDetail.tsx` and
  `Playground.tsx`).
- `typescript/consistent-type-imports`: `import { type X }` or
  `import type`.
- `promise/always-return`: each `.then()` callback returns a value. Use
  `.then(() => undefined)` after a callback that returns nothing.

## Layout

- `src/main.tsx` mounts `App` in `ToastProvider`. `src/App.tsx` loads
  `/api/session`. It shows `screens/Login.tsx` until `session.state` is
  `ready`. Then it shows `screens/Wizard.tsx` for `/setup`, or `Shell` with
  the route table `ROUTES`.
- `src/components/ui.tsx` is the shared UI kit: `Button`, `Icon`, `Badge`,
  `Field`, `Dialog`, `ConfirmDialog`, `CodeBlock`, `EmptyState`,
  `ErrorState`, `Skeleton`, `TableRow`, `Pager`, toasts, and more. Use it
  before you write a new component. `src/components/Shell.tsx` is the
  sidebar and the top bar.
- `src/screens/` has one file per screen. A large screen has a folder for
  its parts (`domains/`, `webhooks/`, `wizard/`).
- `src/api.ts` is the client for `/api` and holds the response types.
  `src/lib/hooks.ts` has `useApi`, `useNow`, `usePoll`, `useNarrow`,
  `useLatest`, `useDebounce` and `useTitle`. `src/session.tsx` has `useSession` and `apiBase` (the public
  API URL for snippets).
- `src/lib/format.ts` formats times, numbers, sizes and addresses.

## API calls

- Use `api()` from `src/api.ts`, or `useApi()` for a GET. `api()` adds the
  `/api` prefix, and it adds `X-Fullsend-Dashboard: 1` to every non-GET
  request. The Worker refuses a change without that header (CSRF guard).
- A failed call throws `ApiRequestError` with `status`, `body` and `code`.
  Show it with `ErrorState` or `errorText()`.
- When you add a type to `src/api.ts`, check the JSON that
  `worker/src/dashboard/` returns. Nothing makes these types from the
  Worker.

## Styles

- Tailwind v4, with the tokens in `src/index.css`. The CSS variables for
  each theme are in `:root, [data-theme="dark"]` and
  `[data-theme="light"]`. `@theme` maps them to utilities (`bg-panel`,
  `text-fg2`, `border-line`, `text-accent-fg`, `text-red`, and so on).
  There is no `tailwind.config`.
- Use the tokens, not raw colors. A new color needs a variable in both
  theme blocks and a `--color-*` entry in `@theme`.
- `tint-<color>` is a custom utility: a 13% background and the text in that
  color.
- The design has square corners, rules instead of cards, and lime
  (`accent`) as the only accent.
- The theme is `system`, `dark` or `light` (`src/lib/theme.ts`). A script
  in `index.html` sets it before the first paint. Keep the two in step.

## Dev server

`pnpm dev:ui` runs Vite on port 5173. `vite.config.ts` proxies `/api` and
each path in `PUBLIC_PATHS` to the Worker on port 8787. `PUBLIC_PATHS` is in
`worker/src/public-paths.ts`, the one list. Start the Worker with `pnpm dev`
at the root. Do not copy the list into the UI. `Settings.tsx` reads it from
`GET /api/settings`.
