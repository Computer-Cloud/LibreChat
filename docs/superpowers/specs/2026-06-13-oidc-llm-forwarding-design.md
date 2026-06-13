# OIDC Access Token Forwarding to LLM Gateway

**Date:** 2026-06-13
**Status:** Design, awaiting implementation
**Scope:** Fork repository `github.com/computer-cloud/librechat` (downstream of `danny-avila/LibreChat`)
**Replaces:** `uid-${openidId}` placeholder identity passing implemented in fork commits `8689baf8c`, `ca4653f41`, and `19f9de95b`.

---

## 1. Problem

The fork's authentication flow currently issues every OIDC user a synthetic API key of the form `uid-${openidId}` (stored in the `keys` collection via `updateUserKey` during OIDC callback in `api/strategies/openidStrategy.js`). LibreChat then forwards this unverifiable string to an internal LLM gateway as the user's bearer credential. The gateway parses the `uid-` prefix to identify the user for billing/routing.

This has three deficiencies:

1. **Unverifiable identity** — the gateway trusts a plain string with no signature; any party reaching the gateway can claim any user identity.
2. **Stale identity** — the string is written once at login and never expires; revocation requires DB writes and is decoupled from IdP session lifecycle.
3. **DB side effects** — every login mutates a DB row per endpoint (5 writes), polluting the keys collection.

The fork is also `~756` upstream commits behind `danny-avila/main` (last sync at upstream `v0.8.3-rc1`, current upstream tip is `v0.8.6`). Upstream has since shipped a substantial OIDC token-handling refactor (PRs #9931, #11236, #11711, #11782, #11810, #13546, others) plus a per-user header resolution path for custom endpoints (#13616).

This design covers two coordinated PRs:

- **PR-1:** Merge upstream `main` (`v0.8.6`) into the fork, preserving the legacy `uid-` flow so the system continues to function.
- **PR-2:** Replace the `uid-${openidId}` flow with forwarding of the user's real OIDC `access_token` as the LLM gateway credential.

## 2. Goals & Non-Goals

### Goals

- Forward the user's signed OIDC `access_token` to the LLM gateway on every LLM-bound request (all endpoints: `openAI`, `azureOpenAI`, `anthropic`, `custom`, `assistants`, `azureAssistants`).
- Refresh the `access_token` proactively before it expires (within a 60-second leeway) using the user's `refresh_token`.
- Deduplicate concurrent refresh attempts per user within a single process.
- Reject startup when non-OIDC providers are simultaneously enabled with the new flag (defense-in-depth invariant).
- Preserve fork-only customizations (gitlab-ci, branding, custom endpoint configs for gemini/xai/deepseek/groq, real-ip middleware) through the upstream merge.
- Keep gateway-side compatibility with the legacy `uid-` credentials for a 30-day rollout window.

### Non-Goals

- Token exchange (RFC 8693) at LibreChat — the gateway is trusted to verify the bearer JWT against the IdP's JWKS directly.
- Streaming mid-flight 401 recovery — token TTL ≫ streaming duration with the 60s leeway; if a stream's bearer expires mid-transmission, the LangChain client surfaces the error normally.
- Multi-tenant changes — tenant context (added upstream in PR #5683706af) is preserved transparently but not extended.
- DB cleanup of legacy `uid-` rows — provided as an opt-in maintenance script, not run automatically.
- Replacing UI-side "disable revoke / hide set-key button" with anything new in this PR — the upstream UI has been rewritten extensively; those fork-only UI tweaks are intentionally dropped in PR-1 and may be reintroduced later.

## 3. Architecture Overview

```
[Browser] ──login OIDC──▶ [LibreChat API]
                           ├─ express-session: openidTokens { accessToken, idToken, refreshToken, expiresAt }
                           └─ req.user.federatedTokens (set by openIdJwtStrategy / openidStrategy)
                                                          │
                                                          ▼
                                          POST /api/agents/chat (or equivalent)
                                                          │
                                                  initializeXxx({ req, endpoint, … })
                                                          │
                                          ensureLLMBearer(req, { refreshOIDCAccessToken })
                                            ├─ provider !== 'openid' ──▶ throw AUTH_FAILED
                                            ├─ exp < now + 60s ──▶ dedupedRefresh → refreshTokenGrant
                                            └─ return { accessToken, refreshed }
                                                          │
                                                apiKey = accessToken
                                                          │
                                                          ▼
                                          getOpenAIConfig / getLLMConfig (unchanged)
                                                          │
                                                          ▼
                                          OpenAI SDK    →  Authorization: Bearer <jwt>
                                          Anthropic SDK →  x-api-key:    <jwt>
                                          Azure SDK     →  api-key:      <jwt>
                                                          │
                                                          ▼
                                              [LLM Gateway: verifies JWT against IdP JWKS]
                                                          │
                                                          ▼
                                              [Upstream LLM provider (OpenAI / Anthropic / …)]
```

**Why `apiKey = accessToken` instead of injecting headers:** each LLM SDK already knows where its provider expects the credential. Mutating `apiKey` and letting the SDK fill the correct header lets one helper serve all endpoints without per-SDK header logic.

## 4. PR-1 — Merge upstream `v0.8.6`

### 4.1 Strategy

`git merge upstream/main` (no rebase, preserves fork's historical merge style). Single merge commit. PR-1 must leave the legacy `uid-${openidId}` flow functional so production is not disrupted before PR-2 lands.

### 4.2 Conflict Resolution Table

| File | Upstream change | Fork change | Resolution |
|---|---|---|---|
| `api/strategies/openidStrategy.js` | ~-540 lines (refactors: `OPENID_EMAIL_CLAIM`, tenant binding, issuer normalize, federated tokens) | 5× `updateUserKey('uid-${openidId}')` blocks before `done(null, user)` | Accept upstream; manually re-apply the 5 blocks immediately before `done(null, user)`. PR-2 deletes them. |
| `api/server/services/AuthService.js` | ~-400 lines (admin exchange refactor) | None | Accept upstream |
| `api/strategies/openIdJwtStrategy.js` | ~-59 lines (bearer reuse hardening) | None | Accept upstream |
| `packages/api/src/auth/openid.ts` | ~-297 lines (issuer/tenant binding) | None | Accept upstream |
| `packages/api/src/utils/oidc.ts` | ~-40 lines | None | Accept upstream |
| `packages/api/src/endpoints/openai/initialize.ts` | +17 lines (user-scoped cache) | None | Accept upstream (expected zero conflict) |
| `packages/api/src/endpoints/custom/initialize.ts` | +52 lines (security guard, user-scoped cache) | None | Accept upstream |
| `package.json`, `package-lock.json`, `bun.lock` | Many dep updates | None | Accept upstream; rebuild lock with `npm install` |
| `.env.example` | Many new `OPENID_*`, tenant entries | A few `GROQ_API_KEY` / xai / deepseek lines | Accept upstream; append fork's lines to the custom-endpoint section |
| `librechat.example.yaml` | Many entries | Custom endpoints (deepseek/xai/groq) | Manual merge; preserve both |
| `.gitlab-ci.yml` | Absent | Fork-only file | Keep fork's file |
| `client/src/...` (UI key-locking) | Heavy upstream rewrites | Several disable/hide tweaks | **Drop fork tweaks in PR-1**; the upstream UI is too divergent. May be reintroduced separately later if needed. |
| `client/public/assets/favicon*`, icons | Untouched | Fork-customized | Keep fork |

### 4.3 Fork-Only Commit Disposition

| Fork commit / theme | Action |
|---|---|
| gitlab CI (`.gitlab-ci.yml`) | Keep |
| Custom endpoints: gemini, xai, deepseek, groq | Keep (verify upstream did not natively add) |
| `feat: auto import api_key after login` (5× `updateUserKey`) | Temporarily keep in PR-1; deleted in PR-2 |
| `feat: disable revoking of api key`, `disable custom api key`, `remove set api key button` | Drop in PR-1 (UI divergence too high) |
| `fix: fix dalle3 plugin*`, `fix: fix node-fetch*` | Drop if upstream covers; verify post-merge |
| `fix: update favicon`, `chore: update icons` | Keep |
| `feat: add real ip support` | Keep (verify upstream did not natively add `trust proxy`) |
| `fix: fix insufficient balance error message` | Keep if upstream didn't fix |

### 4.4 PR-1 Acceptance

- `npm install && npm run lint && npm run test` all green
- Local boot: `docker compose up -d` (mongo/redis/meilisearch) + `npm run backend:dev`
- Manual smoke:
  - OIDC login succeeds; `req.user.federatedTokens` populated
  - Chat request against gateway returns 200 (gateway still recognizes `uid-${openidId}`)
  - `/api/auth/refresh` triggers IdP refresh; session updates

### 4.5 PR-1 Commit Message

```
Merge upstream danny-avila/LibreChat @ v0.8.6

Preserved fork-only changes:
- gitlab-ci
- custom endpoints: gemini, xai, deepseek, groq
- branding: favicon, icons
- real-ip middleware

Temporarily preserved (to be removed in PR-2):
- openidStrategy: 5x updateUserKey('uid-...') auto-import

Dropped (UI divergence; may be reintroduced later):
- UI "disable revoke / disable custom api key / remove set key button" tweaks
```

## 5. PR-2 — OIDC Access Token Forwarding

### 5.1 New Module: `packages/api/src/auth/llmBearer.ts`

Pure helper. No DB, no `api/server/*` imports.

```typescript
import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { extractOpenIDTokenInfo, isOpenIDTokenValid } from '~/utils/oidc';
import { isEnabled } from '~/utils';

const REFRESH_LEEWAY_SECONDS = 60;
const inflightRefresh = new Map<string, Promise<void>>();

export function isLLMOIDCForwardingEnabled(): boolean {
  return isEnabled(process.env.OIDC_FORWARD_TO_LLM);
}

export interface LLMBearer {
  accessToken: string;
  refreshed: boolean;
}

export interface EnsureLLMBearerDeps {
  refreshOIDCAccessToken: (req: ServerRequest) => Promise<void>;
}

export async function ensureLLMBearer(
  req: ServerRequest,
  deps: EnsureLLMBearerDeps,
): Promise<LLMBearer> {
  const user = req.user;
  if (!user || user.provider !== 'openid') {
    throw new Error(JSON.stringify({ type: ErrorTypes.AUTH_FAILED }));
  }

  let tokenInfo = extractOpenIDTokenInfo(user);
  let refreshed = false;

  const needsRefresh =
    !tokenInfo?.accessToken ||
    (tokenInfo.expiresAt != null &&
      tokenInfo.expiresAt - Math.floor(Date.now() / 1000) < REFRESH_LEEWAY_SECONDS);

  if (needsRefresh) {
    logger.debug('[ensureLLMBearer] refreshing access_token before LLM call');
    await dedupedRefresh(req, deps);
    tokenInfo = extractOpenIDTokenInfo(req.user);
    refreshed = true;
  }

  if (!isOpenIDTokenValid(tokenInfo)) {
    throw new Error(JSON.stringify({ type: ErrorTypes.AUTH_FAILED }));
  }

  return { accessToken: tokenInfo!.accessToken!, refreshed };
}

async function dedupedRefresh(req: ServerRequest, deps: EnsureLLMBearerDeps): Promise<void> {
  const userId = String(req.user!._id);
  let pending = inflightRefresh.get(userId);
  if (!pending) {
    pending = deps.refreshOIDCAccessToken(req).finally(() => {
      inflightRefresh.delete(userId);
    });
    inflightRefresh.set(userId, pending);
  }
  return pending;
}
```

### 5.2 New Module: `api/server/services/Auth/refreshOIDCToken.js`

Bridges `ensureLLMBearer` to upstream's `openid-client` and `setOpenIDAuthTokens`. Lives in `api/server/` (not in `packages/api/`) because it imports both `AuthService` and `~/strategies/openidStrategy` — these are server-layer modules. `ensureLLMBearer` (in `packages/api/`) receives this function via dependency injection through `BaseInitializeParams`, preserving the existing package layering.

```javascript
const { logger } = require('@librechat/data-schemas');
const openIdClient = require('openid-client');
const { buildOpenIDRefreshParams } = require('@librechat/api');
const { setOpenIDAuthTokens } = require('~/server/services/AuthService');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');

async function refreshOIDCAccessToken(req) {
  const refreshToken = req.session?.openidTokens?.refreshToken;
  if (!refreshToken) {
    throw new Error('No refresh_token available for OIDC refresh');
  }

  const openIdConfig = getOpenIdConfig();
  const refreshParams = buildOpenIDRefreshParams();
  const tokenset = await openIdClient.refreshTokenGrant(
    openIdConfig,
    refreshToken,
    refreshParams,
  );

  /** setOpenIDAuthTokens tolerates res === null (see related patch below). */
  setOpenIDAuthTokens(tokenset, req, null, {
    userId: req.user?.id,
    existingRefreshToken: refreshToken,
  });

  /**
   * Mirror federatedTokens with the access_token's real expiry (seconds since epoch),
   * not req.session.openidTokens.expiresAt — that field is the refresh_token cookie
   * lifetime (REFRESH_TOKEN_EXPIRY, typically 7 days), not the access_token's TTL.
   * openid-client returns tokenset.expires_at already normalized to seconds.
   */
  req.user.federatedTokens = {
    access_token: tokenset.access_token,
    id_token: tokenset.id_token,
    refresh_token: tokenset.refresh_token || refreshToken,
    expires_at: tokenset.expires_at,
  };
}

module.exports = { refreshOIDCAccessToken };
```

#### Required upstream patch

`api/server/services/AuthService.js::setOpenIDAuthTokens` currently calls `res.cookie('refreshToken', ...)` unconditionally and falls through to additional `res.cookie('token_provider', ...)` / `res.cookie('openid_user_id', ...)` writes. When invoked from the LLM request path there is no response object. Patch every `res.cookie(...)` in that function with:

```javascript
if (res && typeof res.cookie === 'function') {
  res.cookie(...);
}
```

The session-side writes (the source of truth) are unaffected. Cover with regression tests that call `setOpenIDAuthTokens(tokenset, req, null, opts)` and assert no throw + session populated.

### 5.3 Initializer Edits

#### 5.3.1 Extend `BaseInitializeParams` (dependency injection)

`packages/api/src/types/endpoints.ts`: add the refresh function to the params interface so `packages/api/` never imports from `api/server/`.

```typescript
export interface BaseInitializeParams {
  req: ServerRequest;
  endpoint: string;
  model_parameters?: Record<string, unknown>;
  db: EndpointDbMethods;
  /** Injected by api/server/ callers; bridges to openid-client + AuthService. */
  refreshOIDCAccessToken?: (req: ServerRequest) => Promise<void>;
}
```

Every call site in `api/server/controllers/agents/*.js` and `api/server/services/Endpoints/*` that constructs `BaseInitializeParams` adds `refreshOIDCAccessToken: require('~/server/services/Auth/refreshOIDCToken').refreshOIDCAccessToken`. This is the same DI pattern already used for `db`.

#### 5.3.2 Shared pattern inside each initializer

```typescript
import { ensureLLMBearer, isLLMOIDCForwardingEnabled } from '~/auth/llmBearer';

// ... existing apiKey / baseURL resolution unchanged ...

if (isLLMOIDCForwardingEnabled() && req.user?.provider === 'openid' && refreshOIDCAccessToken) {
  if (userProvidesURL) {
    throw new Error(
      JSON.stringify({ type: ErrorTypes.AUTH_FAILED }) +
        ' — user-provided baseURL disallowed when forwarding OIDC bearer',
    );
  }
  const { accessToken } = await ensureLLMBearer(req, { refreshOIDCAccessToken });
  apiKey = accessToken;
}
```

`isLLMOIDCForwardingEnabled()` reads `process.env.OIDC_FORWARD_TO_LLM` via the existing `isEnabled` helper and is exported from `llmBearer.ts` so all initializers share one source of truth. When the flag is off, the branch is skipped and behavior is identical to upstream. When `refreshOIDCAccessToken` is undefined (older internal call paths not yet updated), the branch is also skipped; the startup guard (§5.5) ensures production deployments fail loudly if this branch is ever required but the wiring is incomplete.

#### 5.3.3 Per-file insertion points

| File | Insertion point | Special handling |
|---|---|---|
| `packages/api/src/endpoints/openai/initialize.ts` | After `apiKey` resolution, before `getOpenAIConfig` | Azure branch: replace `clientOptions.azure.azureOpenAIApiKey` with `accessToken` (after `getAzureCredentials()` runs) |
| `packages/api/src/endpoints/anthropic/initialize.ts` | After `anthropicApiKey` resolution, before `getLLMConfig` | Set `credentials[AuthKeys.ANTHROPIC_API_KEY] = accessToken` |
| `packages/api/src/endpoints/custom/initialize.ts` | After `apiKey` resolution, before `getOpenAIConfig` | `userProvidesURL` guard above |
| `api/server/services/Endpoints/azureAssistants/initialize.js` | After `resolveHeaders`, before client build | Same `clientOptions.azure` substitution as OpenAI Azure |

### 5.4 Legacy Removal

Delete from `api/strategies/openidStrategy.js`:

- The 5 sequential `await updateUserKey({ name: EModelEndpoint.X, value: ... 'uid-${user.openidId}' ... })` blocks.
- Top-of-file imports that become unused: `const { updateUserKey } = require('~/models')`, `const { EModelEndpoint } = require('librechat-data-provider')`.

Regression test: `openidStrategy.spec.js` must assert `updateUserKey` is called **0 times** during successful OIDC callback.

### 5.5 Startup Guard

In `api/server/socialLogins.js::configureSocialLogins`, after all `passport.use(...)` calls:

```javascript
if (isEnabled(process.env.OIDC_FORWARD_TO_LLM)) {
  const enabledNonOIDC = ['google', 'github', 'facebook', 'discord', 'apple', 'ldap', 'saml']
    .filter((s) => isEnabled(process.env[`ALLOW_${s.toUpperCase()}_LOGIN`]));
  if (enabledNonOIDC.length > 0 || isEnabled(process.env.ALLOW_EMAIL_LOGIN)) {
    throw new Error(
      `OIDC_FORWARD_TO_LLM is enabled but non-OIDC providers are also enabled: ${enabledNonOIDC.join(', ') || 'local'}. ` +
      `Disable them or unset OIDC_FORWARD_TO_LLM.`,
    );
  }
}
```

### 5.6 Configuration

New env var, fork default off (so PR-2 merge does not change runtime behavior until explicitly enabled):

```bash
# .env.example addition
# When true, all LLM requests use the user's OIDC access_token as the API key
# (Bearer for OpenAI/custom, x-api-key for Anthropic, api-key for Azure).
# Mutually exclusive with non-OIDC login providers — startup will fail if both are enabled.
OIDC_FORWARD_TO_LLM=false
```

### 5.7 PR-2 Commit Slicing

1. `feat(api): add ensureLLMBearer + refreshOIDCAccessToken helpers + tests`
2. `feat(api): tolerate null res in setOpenIDAuthTokens`
3. `feat(endpoints): forward OIDC access_token as apiKey on all LLM endpoints`
4. `chore(openid): remove legacy uid-${openidId} updateUserKey auto-import`
5. `feat(startup): reject non-OIDC providers when OIDC_FORWARD_TO_LLM=true`
6. `docs: OIDC_FORWARD_TO_LLM env var and design link`

Each commit is independently revertable.

## 6. Error Handling, Concurrency, Security

### 6.1 Error Taxonomy

| Condition | Thrown | User-facing |
|---|---|---|
| `user.provider !== 'openid'` at LLM call | `Error(JSON.stringify({ type: ErrorTypes.AUTH_FAILED }))` | Re-login |
| `req.session.openidTokens.refreshToken` missing | `Error('No refresh_token available for OIDC refresh')` → caught → `AUTH_FAILED` | Re-login |
| `openIdClient.refreshTokenGrant` rejects | `AUTH_FAILED` | Re-login |
| Gateway returns 401 mid-stream | Not intercepted; LangChain surfaces the error | Model error displayed |
| Gateway 5xx | Same | Same |

No automatic retry on refresh failure (avoids IdP rate-limit storms).

### 6.2 Concurrency

`inflightRefresh: Map<userId, Promise>` deduplicates concurrent refresh calls within one Node process. The entry is removed in `.finally(...)`, eliminating leak risk. Multi-process deployments may issue N concurrent refreshes (bounded by replica count) — accepted; revisit only if IdP rate-limit measurements warrant a Redis lock.

### 6.3 Streaming TTL

OIDC access tokens are typically ≥3600s; the 60s leeway pre-refreshes anything shorter than that. A streaming response that begins with a fresh token and runs longer than the remaining TTL is not handled — surfaced as a normal model error.

### 6.4 Logging Discipline

- `logger.debug` / `logger.error` calls in `llmBearer.ts` and `refreshOIDCToken.js` log only booleans and counts (`refreshed: true`, `has_access_token: false`).
- `refreshTokenGrant` errors logged as `logger.error('[refreshOIDC] grant failed', { message: error.message })` — never the full error object (avoids leaking `error.response.data` containing tokensets).
- One unit test asserts no logger call argument contains the literal access_token string.

### 6.5 Security Invariants

| Risk | Mitigation |
|---|---|
| OIDC token exfiltrated via user-controlled baseURL | OIDC mode rejects `userProvidesURL` endpoints at request time |
| Custom endpoint headers manipulated for SSRF | Reuse upstream PR #13616 guard (`headers: userProvidesURL ? undefined : endpointConfig.headers`) |
| Forged `provider: 'openid'` user record | Passport already verifies IdP signature; unchanged |
| Legacy `uid-` rows leak post-cutover | Optional opt-in cleanup script; gateway-side deprecation after T+30d |
| Refresh token leakage | Stays in server-side session + httpOnly cookie; never crosses into `federatedTokens` consumers other than this module |
| Bypass when `OIDC_FORWARD_TO_LLM=false` | `ensureLLMBearer` short-circuits on `provider !== 'openid'` regardless of the flag, preserving fallback path integrity |

### 6.6 Tenant Compatibility

The OIDC tenant binding upstream introduced in PR #5683706af is preserved transparently: `setOpenIDAuthTokens` is called with `req` (which carries the pre-auth tenant ALS scope), and no new lookup logic is introduced. Single-tenant deployments behave identically to today.

### 6.7 Performance

- Cache hit (`needsRefresh === false`): one `extractOpenIDTokenInfo` call + one `Date.now()` — submillisecond.
- Refresh: one HTTPS round trip to the IdP, typically 100-300ms. Per user, at most once per `OPENID_REUSE_MAX_SESSION_AGE_MS` (default 15 min).
- `inflightRefresh` map self-prunes via `.finally()`.

## 7. Testing Matrix

| Layer | File | Cases |
|---|---|---|
| Unit (pure) | `packages/api/src/auth/llmBearer.spec.ts` (new) | non-OIDC → `AUTH_FAILED`; healthy token returned; near-exp triggers refresh; refresh throws → `AUTH_FAILED`; refresh produces invalid → `AUTH_FAILED`; 5 concurrent calls = 1 refresh; logger never receives token literal |
| Unit (IO) | `api/server/services/Auth/refreshOIDCToken.spec.js` (new) | missing refresh_token throws; mock `refreshTokenGrant` → session and `federatedTokens` updated; `res === null` path does not throw; grant error propagates |
| Unit (endpoint) | `packages/api/src/endpoints/openai/initialize.spec.ts` (extend) | OIDC user → `apiKey === accessToken`; non-OIDC → original path; Azure branch → `clientOptions.azure.azureOpenAIApiKey === accessToken`; user-provided baseURL in OIDC mode → throws |
| Unit (endpoint) | `custom/initialize.spec.ts`, `anthropic/initialize.spec.ts`, `azureAssistants/initialize.spec.js` (extend) | Same OIDC/non-OIDC/baseURL guard cases |
| Unit (startup) | `api/server/socialLogins.spec.js` (extend) | OIDC + google login + flag on → throw; OIDC-only + flag on → boot; flag off → no validation |
| Integration | `src/tests/oidc-llm-forwarding.test.ts` (new) | End-to-end with mocked `openid-client` + nock-intercepted outbound LLM HTTP: verify the JWT minted by the mock IdP reaches the gateway in the per-SDK header (`Authorization` for OpenAI/custom, `x-api-key` for Anthropic, `api-key` for Azure). If a full mock OIDC provider is not feasible, downgrade to a per-endpoint initializer test asserting on the `apiKey` value passed to `getOpenAIConfig` / `getLLMConfig`. |
| Regression | `api/strategies/openidStrategy.spec.js` (extend) | `updateUserKey` call count = 0 on successful OIDC callback |

Acceptance: 100% pass.

## 8. Deployment / Rollout

| Stage | Window | Action | Rollback signal |
|---|---|---|---|
| 0. Pre-flight | T-14d | Gateway accepts both `uid-${openidId}` and OIDC JWT; JWKS reachable; JWKS cache configured | Gateway not ready → defer PR-2 |
| 1. Merge PR-1 | T-0 | Standard review; merge; deploy to staging | Staging smoke fails → revert merge commit |
| 2. Staging soak | T+3d | OIDC login, chat, tools, files, long streaming, refresh trigger | Any regression → patch, re-soak |
| 3. Merge PR-2 | T+7d | PR-2 merged with `OIDC_FORWARD_TO_LLM=false`; deploy staging | Boot fails → revert PR-2 commits |
| 4. Flag on (staging) | T+8d | `OIDC_FORWARD_TO_LLM=true`; gateway prefers OIDC verification but still accepts `uid-` | Gateway 401 rate > 1% → flag off |
| 5. Prod 10% | T+10d | One prod replica flag on; monitor 5xx, 401, refresh frequency, IdP call volume | Same |
| 6. Prod 100% | T+14d | All replicas flag on | Same |
| 7. Cleanup | T+30d | Gateway drops `uid-` compatibility; run `cleanup-uid-keys` script (manual) | Irreversible — explicit sign-off required |

### Metrics to add (LibreChat or gateway side)

- `oidc_bearer_refresh_total{result=success|failure}`
- `oidc_bearer_inject_total{endpoint}`
- `llm_upstream_status{code}`

## 9. Documentation Updates

| File | Update |
|---|---|
| `docs/superpowers/specs/2026-06-13-oidc-llm-forwarding-design.md` | This document |
| `.env.example` | `OIDC_FORWARD_TO_LLM=` with semantic, fallback, and mutex notes |
| `librechat.example.yaml` | Custom endpoints note that `apiKey:` is ignored when `OIDC_FORWARD_TO_LLM=true`; `baseURL` must be admin-configured |
| Fork `README.md` | "OIDC LLM gateway integration" section pointing to this design |
| Gateway-side docs (separate repo) | JWKS validation, audience policy, scope policy, `uid-` compatibility window |

## 10. Acceptance Checklist

Before merging PR-2:

- [ ] `npm run test` green
- [ ] `npm run lint` green
- [ ] `OIDC_FORWARD_TO_LLM=true` with a non-OIDC provider enabled → boot throws
- [ ] `OIDC_FORWARD_TO_LLM=false` → fork's pre-PR-2 path active (backward compatibility)
- [ ] OIDC login → OpenAI chat → packet capture shows `Authorization: Bearer eyJ…` (real JWT)
- [ ] OIDC login → Anthropic chat → packet capture shows `x-api-key: eyJ…`
- [ ] OIDC login → Azure chat → packet capture shows `api-key: eyJ…`
- [ ] Mock token TTL to 30s → second LLM call triggers refresh → session updates
- [ ] 10 concurrent LLM requests → IdP refresh call count = 1
- [ ] grep production logs → no `access_token` / `refresh_token` literals
- [ ] User-provided baseURL endpoint + OIDC mode → throws `disallowed` on first request
- [ ] `openidStrategy.spec.js`: `updateUserKey` invocation count = 0 on success
- [ ] Design doc committed

## 11. Risks

| Risk | P | Impact | Mitigation |
|---|---|---|---|
| IdP refresh rate-limit hit under concurrent load | L | M (partial 401s) | Per-user in-process dedup; monitor refresh rate |
| Gateway changes JWKS endpoint → cached keys stale | L | H (all users 401) | `OPENID_JWKS_URL_CACHE_TIME=60` in prod |
| Anthropic SDK upgrade changes `x-api-key` header | L | M | Lock SDK version in CI; manual smoke before upgrade |
| Multi-worker dedup miss → IdP call amplification | M | L (within IdP rate limits) | Accept; revisit only if measured |
| Stale browser sessions using `uid-` at cutover | M | L (resolved by refresh) | Gateway dual-mode for 30 days |

## 12. Out-of-Scope Follow-Ups

- Re-introduce the "hide set/revoke API key" UI controls for OIDC users (deferred from PR-1).
- Implement streaming mid-flight 401 recovery if observed in production.
- Switch concurrent-refresh dedup to a distributed lock if multi-worker IdP traffic warrants.
- Run `cleanup-uid-keys` maintenance script post-cutover.
