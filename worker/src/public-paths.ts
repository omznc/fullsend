// The one list of the public API paths. This file has no imports, so the
// Vite config in ui/ can import it too. A path here is public: Access
// bypasses it, the Worker serves the Resend API or the tracking links
// there, and the dev proxy sends it to the Worker.
//
// Add a new public path here only. A deploy that has Access already does
// not get the new path (see setup.ts).
export const PUBLIC_PATHS: readonly string[] = [
  "/emails",
  "/domains",
  "/api-keys",
  "/webhooks",
  "/t",
  "/health",
];
