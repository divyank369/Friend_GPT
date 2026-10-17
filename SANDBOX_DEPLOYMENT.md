# Isolated website preview runner

The existing API deploys as a Render Node web service (`render.yaml`). Render does not provide this app with a Docker daemon, so generated code must not run there. `SandboxRunner/` is a separate service intended for a dedicated, disposable Linux VM with Docker Engine. The main API communicates with its private authenticated lifecycle API; it never shells out to Docker or writes generated files to its host.

## Required environment

Set these only on the Backend service:

- `SANDBOX_SERVICE_URL`: HTTPS URL for the runner's private `/v1` API.
- `SANDBOX_SERVICE_TOKEN`: unique random secret of at least 32 characters, identical on the API and runner. Keep it server-side.
- `SANDBOX_PREVIEW_BASE_URL`: HTTPS origin used by browsers to reach the runner preview ingress, on a separate origin from SigmaGPT.

For the runner, copy `SandboxRunner/.env.example` to its host environment, set the same private token, pin `SANDBOX_NODE_IMAGE` to the approved Node 22 image digest, set `SANDBOX_PUBLIC_ORIGIN` to the preview HTTPS origin, and set `SANDBOX_FRAME_ORIGINS` to the exact SigmaGPT frontend origin. The sandbox service is optional to the rest of SigmaGPT; without these API variables, starting a preview returns a configuration error while chat and project generation continue to work.

## Host setup and network controls

1. Provision a dedicated Linux VM for previews. Do not co-locate MongoDB, the SigmaGPT API, credentials, or other workloads. Mounting the Docker socket grants the runner host-level container control, so this VM is an explicit security boundary.
2. Install Docker Engine and a TLS reverse proxy. Create `/srv/sigmagpt-sandboxes`, then run `SandboxRunner/create-networks.sh` and start the runner with `docker compose -f SandboxRunner/compose.yaml up -d --build`. The runner joins an internal build network and proxies only HTTPS requests to `registry.npmjs.org`; dependency tarball URLs are routed back through that same allowlisted proxy.
3. Keep port 8090 private. Permit `/v1/*` only from the SigmaGPT API over a private network/VPN. Expose only `/p/<64-hex-token>/*` through the HTTPS preview origin. The reverse proxy must not route arbitrary host ports and should set request/body limits and connection timeouts.
4. Keep `sigmagpt-build-egress` Docker network internal. Build containers have no direct Internet egress; the only package path is the runner's fixed-host npm registry proxy. The `npm install` container disables lifecycle scripts, uses a fixed package allowlist, has no secret environment variables, and is subject to CPU, memory, PID, and wall-clock limits. Apply host firewall rules that expose the runner API only to the private SigmaGPT API and TLS proxy.
5. Keep `sigmagpt-preview-internal` Docker network internal. Runtime containers have no external network, a read-only project mount/root filesystem, a non-root UID, dropped capabilities, no-new-privileges, memory/CPU/PID limits, and private loopback-only dynamically assigned ports. `node_modules` lives in a per-session tmpfs volume capped at 512 MB, and source is capped before it is written. The runner proxies previews through opaque temporary tokens; no container port is public.
6. Configure DNS/TLS for `SANDBOX_PREVIEW_BASE_URL` and `SANDBOX_PUBLIC_ORIGIN` on the same dedicated origin. Do not use the SigmaGPT frontend or API origin: the iframe is sandboxed, CSP permits framing only from the configured frontend origin, response referrers are suppressed, and the separate origin limits damage if generated browser code is hostile.

Sessions expire after 20 minutes. The API cleanup worker requests container removal after expiry; the runner also stops sessions independently after its TTL and clears labeled containers and dependency volumes on startup. Each account may run two sessions, and the runner caps total sessions at four (budget at least 6 GB of VM memory for dependency tmpfs volumes, containers, Docker, and OS headroom).

## Phase 3 diagnostics and repairs

The runner reports dependency-install failures and Vite runtime/transform errors through its authenticated session-status API. Preview HTML is instrumented by the preview proxy to report browser `error`, unhandled promise rejection, `console.error`, and failed resource-load events to a token-scoped diagnostics endpoint. Reports are bounded and sanitized; errors originating in cross-origin scripts may be reduced by the browser to a generic `Script error`. Browser reports are treated as untrusted input. The iframe and runner CSP/network restrictions still apply.

The authenticated Backend stores the React + Vite source for the temporary preview session and a bounded history of at most ten successful repair revisions. The AI provider receives sanitized runner diagnostics and project source needed to prepare a minimal, structured file patch. It never receives backend environment variables or provider/service credentials. The user reviews the proposed diff and must explicitly apply it. Each approved operation can make at most three candidate builds; duplicate patches stop the loop. A candidate runs in a separate container/session, and replaces the current preview only after the runner reports it ready. Failed candidates are removed and preserve the previous project files and running preview. Revert is also a reviewed request that rebuilds the prior content. Session documents expire through the MongoDB TTL index after the same 20-minute preview lifetime. Pre-Phase-3 sessions did not persist source files and must be started again before repair is available.

No new environment variables are required for Phase 3. The existing `GROQ_API_KEY` remains Backend-only, while `SANDBOX_SERVICE_URL`, `SANDBOX_SERVICE_TOKEN`, and the preview-origin settings remain on their respective services. Browser error capture requires that the preview reverse proxy preserve the `/p/<token>/*` paths, including the small POST to `/p/<token>/__sigmagpt_diagnostics`; allow that path and method with a small request-body limit. Keep the API's private `/v1/*` endpoints unexposed publicly.

## Important limitations

The development server is untrusted code running inside Docker. Isolation quality depends on the dedicated host kernel, Docker configuration, firewall, image provenance, reverse proxy, and operational cleanup. This is not a multi-tenant hardened VM boundary such as gVisor or Kata Containers. The current local workspace has no Docker CLI/daemon, and Render's configured Node service cannot host the runner, so real container startup, Vite diagnostics, and browser-to-runner telemetry cannot be verified locally. Backend lifecycle tests use a fake Docker command; the browser UI smoke check uses a mocked API and preview. Deploy the runner on the isolated VM and connect the private API before enabling real previews for users.

## Phase 4 static publishing

Publishing supports React + Vite projects only. A user must have a running isolated preview and confirm the public release. The API verifies the session owner and runner state, then asks the separate sandbox runner to execute the fixed `npm run build` task in a resource-limited container with no network. The runner returns only validated `dist/` regular files (no symlinks) under an 18 MB/500 file cap. The API validates relative paths, file hashes, index.html, and common private-key/credential patterns before uploading assets. Generated build output is never executed on the API host. The user's page is served as static content from an isolated Cloudflare Pages project.

Cloudflare Pages Direct Upload is the first provider adapter. Configure these secrets on the **Backend Render service only**:

- `CLOUDFLARE_ACCOUNT_ID`: 32-character Cloudflare account identifier.
- `CLOUDFLARE_API_TOKEN`: account API token restricted to Cloudflare Pages **Edit** permission (Pages Write). Do not use a Global API Key.

Create the Cloudflare account token from the Cloudflare dashboard's Account API Tokens page with only the Pages Edit permission, then set both variables in Render's Backend environment. No token is needed in Vite or the frontend. Until both are configured, deployment APIs return a safe configuration error and existing generation, preview, and chat remain available. The adapter uses the documented Pages project, upload-token, asset check/upload, and deployment APIs; deployment success is shown only after provider confirmation. Cloudflare's Pages project namespace and public URL are provider-managed; users cannot select a hostname in this phase.

Authenticated API: `POST /api/website-builder/projects/:projectId/deployments` with `{ "confirmed": true }`, `GET /api/website-builder/deployments?projectId=...`, `GET /api/website-builder/deployments/:deploymentId`, `POST /api/website-builder/deployments/:deploymentId/redeploy` with confirmation, and `DELETE /api/website-builder/deployments/:deploymentId`. Cloudflare can delete non-current deployments; its API can refuse deletion of the current live deployment, which SigmaGPT reports without claiming it was removed. A user can publish at most three project sites and make five deployment requests in 24 hours; the API also rate limits deployment endpoints. Each preview project's provider project name is stable across redeployments, while every attempted deployment and source revision hash is recorded separately in MongoDB. Provider credentials are not stored with those records.

Static publishing does not provide a backend/server runtime, custom domains, billing, domain transfer, deletion/disable UI, scheduled deployments, or a review/approval workflow for provider terms. Public HTML and JavaScript remain untrusted; Cloudflare Pages serves them as user-controlled static sites. The sandbox runner must be upgraded/redeployed with the new bounded `/v1/sessions/:id/build` endpoint before publishing can work. Build and upload limits should be reviewed against the selected Cloudflare account plan and API quotas.
