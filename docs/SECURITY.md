# Security policy

## Reporting

Do not open public issues for security problems.

Email `security@agentgrove.dev` (placeholder; update before public launch).
GPG key will be published before public launch.

We aim to acknowledge within 72 hours and provide a remediation timeline
within 7 days.

## Scope

- The Rust backend binary `agentgrove-server`.
- The built static frontend served by the binary.
- Default configuration shipped with releases.

Out of scope:

- User-installed agent CLIs (Claude, Codex, Kimi, etc.).
- User-provided OS shells for pre/post scripts.

## Defaults

- Bind: `127.0.0.1` only.
- **Authentication is opt-in.** By default there is none — the server
  trusts whoever can reach the loopback socket. When the Google OAuth
  env vars are set (see [Google login](#google-login-optional)), every
  request outside `/api/auth/*` + `/health` requires a valid session
  cookie. Only enable a remote bind together with auth (or an external
  auth proxy + TLS).
- Remote bind (`AGENTGROVE_BIND=0.0.0.0`) is allowed but the server logs
  a warning. Front it with a reverse proxy that adds TLS, and enable
  auth.
- The Vite dev server (`:5173`) listens on all interfaces and proxies
  the API, so a tunnel to `:5173` exposes the whole app. Its `/@fs` file
  route is outside backend auth; `vite.config.ts` confines it to the FE
  package and denies the state dir (`.data/` holds the OAuth secret,
  session key and DB), `.env*`, keys and `.git`.
- Provider API keys are stored in the OS keyring
  ([`keyring`](https://crates.io/crates/keyring) crate), never in the
  database.

## Google login (optional)

Set these env vars to require Google sign-in (all read from the
environment; the OS-managed service sources them from the gitignored
`.data/auth.env` via `scripts/service-run.sh`):

| Var | Purpose |
| --- | --- |
| `AGENTGROVE_GOOGLE_CLIENT_ID` | OAuth client id. **Required** to enable auth. |
| `AGENTGROVE_GOOGLE_CLIENT_SECRET` | OAuth client secret (server-only; never sent to the browser). **Required.** |
| `AGENTGROVE_AUTH_ALLOWED_DOMAINS` | Comma-separated email domains allowed to sign in. Empty = any Google account. |
| `AGENTGROVE_AUTH_ALLOWED_EMAILS` | Comma-separated exact emails allowed. Empty = don't restrict by email. When set, ONLY these addresses may sign in. |
| `AGENTGROVE_PUBLIC_URL` | BE origin. Builds the OAuth redirect URI (`<PUBLIC_URL>/api/auth/callback`, which Google calls back to). |
| `AGENTGROVE_APP_URL` | FE origin to land on after login. Defaults to `PUBLIC_URL`; set separately in dev (FE `:5173` vs BE `:4317`). |

Both `CLIENT_ID` and `CLIENT_SECRET` must be present or auth stays off.
The domain and email allowlists are ANDed (each is skipped when empty),
so `DOMAINS=theysaid.io` + `EMAILS=arnab@theysaid.io` restricts login to
that single address.

**Google Cloud Console setup** — on the OAuth 2.0 client, add an
Authorized redirect URI of `<AGENTGROVE_PUBLIC_URL>/api/auth/callback`:

- Local dev: `http://localhost:4317/api/auth/callback`
- Prod: `https://agentgrove.poc.dev.theysaid.io/api/auth/callback`

When served through a tunnel or reverse proxy, set **both**
`AGENTGROVE_PUBLIC_URL` and `AGENTGROVE_APP_URL` to the public origin
(e.g. `https://agentgrove.poc.dev.theysaid.io`) — the Vite proxy routes
`/api/auth/callback` to the backend on the same origin. Only one
callback origin is supported at a time, so login then works via the
public URL only (an existing local session keeps working until it
expires). An `https` `PUBLIC_URL` also marks the cookies `Secure`.

**Sessions** are stateless: the cookie is an AEAD-sealed blob
(`{email, name, picture, exp}`) signed with the machine-bound keyring —
there is no session table. Logout clears the cookie; there is no
server-side revocation before the (7-day) expiry.
- Provider API keys are stored in the OS keyring
  ([`keyring`](https://crates.io/crates/keyring) crate), never in the
  database.
