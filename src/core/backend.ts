import { z } from 'zod';

// ── Backend-track contract (v0.3) ────────────────────────────────────────────
//
// Shared schema for the backend-bearing app track (Tier 3). The design goal is
// that the ONLY per-app input is credentials: two test accounts and (optionally)
// the API origin. Everything else — how to authenticate, which endpoint holds a
// user's data, what record to probe — is discovered automatically by the harness
// by signing in through the real UI and observing each session's traffic.
//
// Consumed by F7 (auth round-trip), F8 (cross-session persistence), and S4
// (backend security probes). A submission with no `backend` block makes all
// three N/A. See docs/backend-track-runbook.md.

export const accountSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

// The full backend block. Two accounts are required (the cross-user isolation
// probe signs in as each). backendUrl is optional — defaults to the frontend
// URL; only needed when the API is hosted on a different origin.
export const backendConfigSchema = z.object({
  // Account A and account B, both pre-created manually in the deployed app.
  // S4 signs in as B to discover B's data, then as A to attempt to read it.
  userA: accountSchema,
  userB: accountSchema,
  // Optional API origin override. When omitted, the harness uses the submission
  // URL's origin (and discovers exact endpoints from observed traffic anyway).
  backendUrl: z.string().url().optional(),
});

export type Account = z.infer<typeof accountSchema>;
export type BackendConfig = z.infer<typeof backendConfigSchema>;

// ── Prompt-side: optional explicit probe declarations ────────────────────────
//
// S4 auto-discovers its probe target from observed traffic, so these are no
// longer required. They remain as an OPTIONAL override for prompts that want to
// pin an exact endpoint. Read-only by construction — the union admits no
// write/delete/escalation kind.

export const backendProbeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unauth_get'),
    id: z.string().min(1),
    path: z.string().min(1),
    expectStatus: z.array(z.number().int()).nonempty(),
  }),
  z.object({
    kind: z.literal('cross_user_get'),
    id: z.string().min(1),
    path: z.string().min(1),
    expectStatus: z.array(z.number().int()).nonempty(),
    forbidBodyContains: z.string().min(1),
  }),
]);

export type BackendProbe = z.infer<typeof backendProbeSchema>;
