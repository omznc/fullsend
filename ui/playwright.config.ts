import { defineConfig, devices } from "@playwright/test";

// The smoke test runs against a local Worker. It does not use the real
// Cloudflare API: the command below sets AUTH_MODE=dev and clears the two
// Cloudflare secrets, so a .dev.vars file of the developer has no effect.
// The D1 and R2 state is in ui/.e2e-state and starts empty on each run.
const PORT = 8799;

const STATE = "ui/.e2e-state";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The working directory is the repo root.
    cwd: "..",
    command: [
      `rm -rf ${STATE}`,
      "pnpm build",
      `pnpm exec wrangler d1 migrations apply DB --local --persist-to ${STATE}`,
      `pnpm exec wrangler dev --port ${PORT} --persist-to ${STATE} --var AUTH_MODE:dev --var CF_API_TOKEN: --var CF_ACCOUNT_ID:`,
    ].join(" && "),
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
