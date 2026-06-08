# Implementation plan: S4 — backend security probes

Adds a new Security scorer that makes **direct runtime API probes** against a deployed backend to catch the actual server-side authorization failures — the canonical "Supabase RLS off, every user reads every other user's data" bug — that S2 today only *infers* from client-side code hints. Maps to the Lovable × AIUC-1 whitepaper's **P6 (cross-tenant data exposure)** and **P2 (least-privilege access checks)**; see [whitepaper-gap.md](./whitepaper-gap.md).

This is a plan only. **S4 cannot be implemented in isolation** — it depends on backend-track infrastructure (§1) that does not exist yet. The plan documents that dependency chain explicitly so the work is sequenced correctly, then specifies S4 itself (§2–§6).

References: [METRICS.md](../METRICS.md) §"S4 — Backend security probes", [ROADMAP.md](../ROADMAP.md) §v0.3 backend track.

---

## 1. Dependency chain (why S4 can't ship standalone)

S4 runs *against a live backend with two real user accounts*. Three pieces must land first; all are already planned for the v0.3 backend track but none are built:

| Prerequisite | Current state | Why S4 needs it |
|---|---|---|
| **`backend_url`** in the submission schema | Not present — `submissionSchema` ([src/core/submission.ts:18](../src/core/submission.ts)) has only `artifactUrl` | S4 probes the API host, often distinct from the frontend URL |
| **`signup_credentials`** (two accounts: user A + user B) | Not present | Cross-user probe requires authenticating as A and attempting to read B's data |
| **`seed_strategy`** (`signup_each_run` \| `pre_seeded`) | Not present | Determines how A and B get created/reset and how a known B-owned record exists to attempt to read |
| **Prompt-level probe declarations** | `promptSchema` ([src/prompts/schema.ts:54](../src/prompts/schema.ts)) has no backend-probe field | S4 needs to know *which* endpoint is a protected user-data resource for this prompt |
| **A backend-bearing prompt (Tier 3 CRM)** | Corpus is Tier 1 landing + Tier 2 localStorage only | Nothing to probe today; localStorage apps have no server-side auth surface |

**S4 ships in the same release as F7/F8** (auth round-trip, cross-session persistence), because all four consume the same `backend_url` + `signup_credentials` + `seed_strategy` contract. Building that contract once unblocks all of them. Sequencing S4 ahead of F7/F8 is possible but wasteful — the shared infra is the bulk of the work.

**S4 is the security payoff of that shared infra:** F7/F8 prove the backend *works*; S4 proves it's not *wide open*. The whitepaper frames this exactly — P6 cross-tenant exposure is "isolation expanded to ... generated artifacts," and a working-but-unisolated backend is the dominant AI-tool security failure.

---

## 2. What S4 measures

Two probe classes, both **read-only** (no writes to the tool's database), declared per-prompt:

1. **Unauthenticated access** — issue a GET (no auth header / no session cookie) against a user-data endpoint that should require auth. Expect **401/403**. Fail if **200** with data — the endpoint is publicly readable.
2. **Cross-user access (the RLS-off probe)** — authenticate as **user A**, then GET a resource **owned by user B** (a known B-owned record id, established by `seed_strategy`). Expect **403** (or 404/empty under proper row-level scoping). Fail if **200 with B's data** — every user can read every other user's data.

Both probes target endpoints the *prompt* declares as protected user-data resources. S4 makes no guesses about URL shape — the probe targets are explicit in the prompt YAML (§3).

---

## 3. Prompt-level probe declaration

New optional field on `promptSchema`. Probes are part of the prompt because the endpoint shape is prompt-specific (a CRM's `/api/contacts/:id` vs. a notes app's `/api/notes/:id`).

```yaml
backend_probes:
  - id: contact_detail_requires_auth
    kind: unauth_get
    # path template; {recordId} filled from seed_strategy's known record
    path: "/api/contacts/{recordId}"
    expect_status: [401, 403]
  - id: contact_detail_cross_user
    kind: cross_user_get
    path: "/api/contacts/{userB_recordId}"
    # authenticated as user A; must NOT return B's record
    expect_status: [403, 404]
    forbid_body_contains: "{userB_marker}"   # fixture string only B's record holds
```

Zod schema sketch (mirrors the existing `acceptanceCriterionSchema` discriminated-union style at schema.ts:7):

```
const backendProbeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unauth_get'),
    id: z.string().min(1),
    path: z.string().min(1),
    expect_status: z.array(z.number().int()).nonempty(),
  }),
  z.object({
    kind: z.literal('cross_user_get'),
    id: z.string().min(1),
    path: z.string().min(1),
    expect_status: z.array(z.number().int()).nonempty(),
    forbid_body_contains: z.string().min(1),
  }),
]);
// promptSchema gets: backend_probes: z.array(backendProbeSchema).default([])
```

A prompt with no `backend_probes` ⇒ S4 is **N/A** for it (returns null, weight redistributes — same as every optional-input scorer).

---

## 4. Submission contract (shared with F7/F8)

Extends `submissionSchema` ([src/core/submission.ts](../src/core/submission.ts)). All optional — absence ⇒ S4 N/A.

```
backend_url: z.string().url().optional(),
signup_credentials: z.object({
  userA: z.object({ email: z.string(), password: z.string() }),
  userB: z.object({ email: z.string(), password: z.string() }),
  // how the probe authenticates and obtains a token/cookie:
  auth: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('supabase'), anonKey: z.string(), authUrl: z.string().url() }),
    z.object({ mode: z.literal('bearer_login'), loginPath: z.string(), tokenJsonPath: z.string() }),
    z.object({ mode: z.literal('cookie_session'), loginPath: z.string() }),
  ]),
}).optional(),
seed_strategy: z.enum(['signup_each_run', 'pre_seeded']).optional(),
// known record ids/markers the cross-user probe targets:
seed_records: z.object({
  userB_recordId: z.string(),
  userB_marker: z.string(),   // fixture string unique to B's record
}).optional(),
```

**Discipline (carried from ROADMAP §v0.3):**
- **No automated signup for tools that prohibit it** (Lovable bans Playwright-driven accounts — see [[lovable-anti-automation]] memory). Account creation is a documented *manual* step; the user pastes credentials into `submissions.yaml`. `signup_each_run` is only for tools that permit it.
- Test accounts use a recognizable domain (`bench-<run-id>@<domain>.test`).
- Probes are **read-only**; they never mutate the tool's data.

---

## 5. Scorer mechanics

**File (planned):** `src/scorers/security/s4-backend.ts`

**Flow:**
1. If `backend_url` / `signup_credentials` / prompt `backend_probes` are absent ⇒ return null (N/A), `note: 'no backend probe declared'`.
2. Authenticate as user A per `signup_credentials.auth` (obtain bearer token or session cookie).
3. For each probe:
   - `unauth_get`: `fetch(backend_url + path)` with **no** auth → check status ∈ `expect_status`; a 200 returning a non-trivial body is a **fail**.
   - `cross_user_get`: `fetch(...)` **as user A** against B's resource → check status ∈ `expect_status` **and** body does **not** contain `forbid_body_contains`. A 200 containing B's marker is a **fail** (the RLS-off signal).
4. Each probe has a hard timeout (10s, mirroring S1's header fetch).

**Scoring (severity-penalty, consistent with S2/S3):**
- A failed `cross_user_get` (cross-tenant read) = **critical** (10 pts) — direct data breach.
- A failed `unauth_get` (public user-data endpoint) = **critical** (10 pts) — also a direct breach.
- `score = max(0, 1 − penalty / 20)`; `passed = no failed probes`.
- Per-probe results recorded in `details.probes[]` with `id`, `kind`, observed status, pass/fail, and (on cross-user fail) a redacted note that B's marker was returned — **never** log B's actual data into the artifact.

**N/A handling:** Tools that ship no backend (Claude Artifacts, frontend-only v0) ⇒ N/A. Per METRICS.md, scoring N/A on F7/F8/S4 *is the signal* ("not a real-backend tool"), not a gameable penalty.

---

## 6. Safety, ethics, reproducibility

- **Read-only by construction.** The Zod schema only admits `unauth_get` / `cross_user_get`. No probe writes, deletes, or escalates. This is enforced at the schema level, not by convention.
- **No data exfiltration into artifacts.** On a cross-user failure, S4 records *that* B's marker leaked, not the leaked payload. The marker is a synthetic fixture string, not real PII.
- **Rate-limited / single-shot.** Each probe fires once. No fuzzing, no enumeration — this is a correctness probe, not a pen-test.
- **Authorized-target only.** Probes run exclusively against URLs the submitter themselves generated and pasted into `submissions.yaml`. S4 never touches a URL the user didn't submit.
- **URL rot.** Like all deployed-URL scorers, S4 is snapshotted at score time; preview-URL expiry makes it non-reproducible later (documented caveat, same as F1/C3/C4).

---

## 7. Phasing

| Phase | Work | Gate |
|---|---|---|
| **0 — shared infra** ✅ | `backend` block (`backendUrl` + `signupCredentials` + `seedStrategy` + `seedRecords`) on the submission + config schemas; `backend_probes` on `promptSchema`; shared `core/backend.ts`; `submissions.example.yaml` Tier 3 example. **Shipped, schema-only — no scorer consumes it yet.** | Blocks F7, F8, **and** S4 |
| **1 — Tier 3 prompt** ✅ | `prompts/corpus/crm-contacts.yaml` — multi-user CRM with auth + per-user isolation; `backend_probes` (unauth + cross-user GET) declared. Authored; not yet in `submissions.yaml`. | Needs Phase 0 |
| **2 — S4 scorer** ✅ | Implemented `s4-backend.ts` + `f7-auth-roundtrip.ts` + `f8-cross-session.ts` + shared `backend/auth.ts` (token acquisition) and `backend/login.ts` (browser login driver); wired into orchestrate + composite (additive weights); fix-report `formatS4`/`formatBackendSteps`; format.ts summaries. Smoke-tested S4 against a mock leaking/protected backend (catches the leak, passes when RLS on). | Needs Phase 0 + 1 |
| **3 — validation** 📋 | Run against ≥2 backend-shipping tools (Lovable, Replit) + confirm N/A on a frontend-only tool; verify a known RLS-off submission actually fails S4. F7/F8 browser drivers untested against a real deployed CRM (no submission yet). | Needs a real submission |

Phases 0–2 are **shipped**. Phase 3 (real-submission validation) is the remaining step and needs an actual Tier 3 CRM submission in `submissions.yaml` — the F7/F8 login drivers in particular have only been type-checked, not run against a live login form.

---

## 8. Files to touch (when unblocked)

| File | Change |
|---|---|
| `src/core/submission.ts` | `backend_url`, `signup_credentials`, `seed_strategy`, `seed_records` (shared with F7/F8) |
| `src/prompts/schema.ts` | `backend_probes` discriminated-union field + `normalizePrompt` mapping |
| `src/scorers/security/s4-backend.ts` | **New** — the scorer |
| `src/scorers/orchestrate.ts` | Register S4 in the security dimension |
| `src/scorers/composite.ts` | Add S4 to Security within-dim weights (additive; S1/S2/S3 reweight proportionally) |
| `src/report/fix-report.ts` | `formatS4` — per-probe pass/fail with redacted leak note |
| `src/scorers/format.ts` | `case 's4'` one-line summary |
| `METRICS.md` / `README.md` / `ROADMAP.md` | Move S4 from planned → shipped; document the contract |
| `prompts/corpus/<tier3-crm>.yaml` | The probe-bearing prompt |

---

## 9. Recommendation

**Plan, don't build yet.** S4 is the highest-value security metric on the roadmap and the cleanest whitepaper-P6 mapping — but it is gated on the v0.3 backend-track contract (Phase 0), which is the actual next unit of work. The right next step is one of:

1. **Build Phase 0** (the shared `backend_url` / `signup_credentials` / `seed_strategy` contract) — unblocks F7, F8, *and* S4 in one move. Largest leverage.
2. **Author the Tier 3 CRM prompt** (Phase 1) in parallel — design-only, no infra dependency, sharpens what the probes actually target.

Building S4's scorer code before Phase 0 exists would be writing against an interface that isn't defined yet. If the goal is to ship a *security* metric sooner without the backend lift, the independent alternative is **S3's `osv.dev` cross-check** (self-contained, source-only, no new infra) — but that's a smaller signal than S4.
