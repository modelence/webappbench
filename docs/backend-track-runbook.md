# Backend-track runbook (Phase 3): scoring a real backend app

How to score a real backend-bearing submission with F7 (auth round-trip), F8 (cross-session persistence), and S4 (backend security probes). **The only per-app input is two test accounts** — the harness signs in through the real UI and discovers everything else (the data endpoint, the record to probe, the session token) by observing each session's traffic. No DevTools, no anon keys, no record ids.

See [s4-backend-security-plan.md](./s4-backend-security-plan.md) for the design and [METRICS.md](../METRICS.md) for F7/F8/S4 mechanics.

> **Discipline.** Account creation is **manual**. Do not automate signup for tools that prohibit it (Lovable bans Playwright-driven accounts — see the `lovable-anti-automation` memory). Use a recognizable throwaway domain, e.g. `bench-a@<your-domain>.test`. The probes are read-only.

---

## Step 1 — Generate the app

Drive the sitebuilder's UI manually with the `crm-contacts` prompt ([prompts/corpus/crm-contacts.yaml](../prompts/corpus/crm-contacts.yaml)). Wait for a deployed URL with working login + a contacts table. If the tool ships no real backend (frontend-only v0, Claude Artifacts), stop — F7/F8/S4 correctly score **N/A**.

## Step 2 — Create two accounts (manual)

Sign up two accounts in the deployed app by hand:

- **User A** — `bench-a@<your-domain>.test`
- **User B** — `bench-b@<your-domain>.test`

Then, **logged in as B**, create at least one contact (any content — the harness will discover it automatically). This ensures B's dashboard has data for S4 to observe. That's it — no record ids to copy, no markers to invent.

## Step 3 — Add to `submissions.yaml`

```yaml
runs:
  - tool: lovable
    prompt: crm-contacts
    url: https://example-crm.lovable.app/
    backend:
      user_a: { email: bench-a@your-domain.test, password: "..." }
      user_b: { email: bench-b@your-domain.test, password: "..." }
      # backend_url: https://api.example-crm.com   # OPTIONAL — only if the API is on a different origin than `url`
```

## Step 4 — Score

```bash
npm run bench -- score lovable --prompt crm-contacts
```

The `score` command reads the `backend` block, runs F7/F8/S4 (only because credentials are present), and regenerates `leaderboard.html`. Then:

```bash
npm run bench -- audit artifacts/lovable/crm-contacts/0
open leaderboard.html
```

---

## How S4 works (so you can interpret it)

S4 is fully credential-driven:

1. Signs in as **B** through the real login form and watches B's dashboard fetch its data. It auto-selects the JSON response that returns the largest record array (B's contacts) and extracts a stable identifier from it (a record `id`, email, etc.).
2. Requests that exact endpoint with **no session** (unauth probe) — must be rejected (401/403), and must not serve B's data.
3. Signs in as **A** in a fresh context and requests B's endpoint from **A's authenticated session** (cross-user probe) — A's response must **not** contain B's identifier.

If A's response contains B's identifier → `crossTenantLeak: true`, the canonical RLS-off breach.

---

## Reading the results

### S4 — the security signal
- `details.crossTenantLeak: true` → **A read B's data.** RLS-off breach. The audit names the failing probe and the fix (Supabase: enable RLS + an `auth.uid() = user_id` policy).
- All probes pass → unauth reads rejected and A could not see B's identifier.
- `score: null` + `note` → N/A. The note says why (could not sign in as B, no JSON data response observed, etc.).

### F7 — auth round-trip
`details.steps[]` lists each lifecycle step (`initial_login`, `create_contact`, `logout`, `relogin`, `persists_after_relogin`) with pass/fail. Pass requires the created record to survive create → logout → re-login.

### F8 — cross-session
`details.crossedSessions: true` → record created in context A appeared in a fresh context B = real backend. `false` → it didn't cross contexts = localStorage masquerading as a backend (or login failed in B — check `steps`).

---

## Known Phase-3 failure modes

The browser login driver and S4's discovery are validated against a mock; first contact with a real app is where these surface:

1. **Login heuristics miss the form.** [login.ts](../src/scorers/backend/login.ts) guesses locators (`getByLabel(/email/i)`, `input[type=password]`, a submit button matching `/log ?in|sign ?in/i`). A magic-link / OAuth-only / multi-step login fails with `could not locate email/password fields` or `still on login screen`. Today: confirm the app has a standard email+password form. Tracked follow-up: an optional `login_selectors` override.
2. **S4 discovers the wrong response.** It picks the largest JSON record array B's dashboard fetches. If B has no contacts (Step 2 skipped) or the data loads via WebSocket/SSR-only (no observable JSON XHR), S4 reports N/A (`no JSON record list captured`). Mitigation: ensure B has ≥1 contact and the app fetches data via a normal API call.
3. **Identifier not discriminating.** If the extracted identifier (e.g. a status enum) is shared across users, the cross-user probe could false-positive. The extractor prefers `id`/`_id`/`uuid`/`email` fields, which are per-record; a poorly-shaped API could still trip it. Inspect `details.discoveredEndpoint` in the artifact if a result looks wrong.

---

## Validation checklist (closes Phase 3)

- [ ] One backend-shipping tool scored with all three scorers producing non-null results.
- [ ] A tool known to ship RLS-off actually trips `crossTenantLeak: true`.
- [ ] A frontend-only tool scores N/A on F7/F8/S4 — confirming the N/A path.
- [ ] F7/F8/S4 successfully sign in against ≥1 real login form (or `login_selectors` lands if the heuristics prove too brittle).
