# PR-2: OIDC Access Token Forwarding to LLM Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy `uid-${openidId}` synthetic API key with forwarding of the user's real OIDC `access_token` (signed JWT) as the credential for all LLM-bound requests, so the upstream LLM gateway can verify identity via standard JWKS validation.

**Architecture:** A pure helper (`ensureLLMBearer` in `packages/api/src/auth/llmBearer.ts`) reads `req.user.federatedTokens`, refreshes the access_token via a server-layer bridge (`refreshOIDCAccessToken` in `api/server/services/Auth/`) when within 60s of expiry, deduplicates concurrent refreshes per user, and returns the access_token. Each endpoint initializer receives the bridge function via dependency injection through `BaseInitializeParams` and overwrites `apiKey = accessToken` when `OIDC_FORWARD_TO_LLM=true` and the user has `provider === 'openid'`. A startup guard rejects non-OIDC providers when the flag is on. The legacy `uid-${openidId}` `updateUserKey` blocks are deleted.

**Tech Stack:** TypeScript (packages/api), JavaScript (api/server), Jest, `openid-client` v5, existing upstream helpers `setOpenIDAuthTokens` / `buildOpenIDRefreshParams` / `extractOpenIDTokenInfo` / `isOpenIDTokenValid`.

**Spec:** `docs/superpowers/specs/2026-06-13-oidc-llm-forwarding-design.md` §5-§11

**Prerequisite:** PR-1 (`chore/merge-upstream-v0.8.6`) merged to `main`.

---

## File Structure

### Files Created

| Path | Purpose | Layer |
|---|---|---|
| `packages/api/src/auth/llmBearer.ts` | Pure helper: `ensureLLMBearer`, `isLLMOIDCForwardingEnabled`, per-user refresh dedup. No DB, no server-layer imports. | `packages/api` |
| `packages/api/src/auth/llmBearer.spec.ts` | Unit tests for `ensureLLMBearer` & dedup & flag helper. | `packages/api` |
| `api/server/services/Auth/refreshOIDCToken.js` | Bridge: calls `openid-client.refreshTokenGrant` + upstream `setOpenIDAuthTokens`, updates `req.session.openidTokens` and `req.user.federatedTokens`. | `api/server` |
| `api/server/services/Auth/refreshOIDCToken.spec.js` | Unit tests with mocked `openid-client`. | `api/server` |
| `src/tests/oidc-llm-forwarding.test.ts` | Integration-ish test: initializer + mocked openid-client + assertion on `apiKey` flowing into `getOpenAIConfig`. | repo root tests |

### Files Modified

| Path | Change | Notes |
|---|---|---|
| `packages/api/src/types/endpoints.ts` | Add `refreshOIDCAccessToken?` to `BaseInitializeParams` | DI hook |
| `packages/api/src/auth/index.ts` | Re-export `llmBearer` | Public surface |
| `packages/api/src/endpoints/openai/initialize.ts` | OIDC apiKey override (incl. Azure branch) | |
| `packages/api/src/endpoints/anthropic/initialize.ts` | OIDC apiKey override | |
| `packages/api/src/endpoints/custom/initialize.ts` | OIDC apiKey override + userProvidesURL guard | |
| `api/server/services/Endpoints/azureAssistants/initialize.js` | OIDC apiKey override | |
| `api/server/services/AuthService.js` | Guard `res.cookie` calls in `setOpenIDAuthTokens` against `res === null` | One-line patches × 4 |
| `api/server/services/AuthService.spec.js` | Regression: call `setOpenIDAuthTokens` with `res=null`, assert no throw | |
| `api/server/controllers/agents/client.js` | Pass `refreshOIDCAccessToken` into initializer params | DI wiring |
| `api/server/controllers/agents/openai.js` | Pass `refreshOIDCAccessToken` into initializer params | DI wiring |
| `api/server/controllers/agents/responses.js` | Pass `refreshOIDCAccessToken` into initializer params | DI wiring |
| `api/server/services/Endpoints/agents/initialize.js` | Pass `refreshOIDCAccessToken` into initializer params | DI wiring |
| `api/server/services/Endpoints/agents/addedConvo.js` | Pass `refreshOIDCAccessToken` into initializer params | DI wiring (if exists post-merge) |
| `api/strategies/openidStrategy.js` | Delete 5× `updateUserKey('uid-${openidId}')` blocks + unused imports | Legacy removal |
| `api/strategies/openidStrategy.spec.js` | Assert `updateUserKey` called 0 times on success | Regression |
| `api/server/socialLogins.js` | Startup guard rejecting non-OIDC providers when flag on | |
| `api/server/socialLogins.spec.js` | Tests for the guard | |
| `packages/api/src/endpoints/openai/initialize.spec.ts` | Add OIDC apiKey override tests | |
| `packages/api/src/endpoints/anthropic/initialize.spec.ts` | Add OIDC apiKey override tests (create if file does not exist) | |
| `packages/api/src/endpoints/custom/initialize.spec.ts` | Add OIDC apiKey override + baseURL guard tests | |
| `.env.example` | New `OIDC_FORWARD_TO_LLM=` entry | |
| `librechat.example.yaml` | Note OIDC-mode behavior on custom endpoint apiKey | |

### Commit Structure (target 6 commits)

1. **C1:** `feat(api): add ensureLLMBearer + isLLMOIDCForwardingEnabled + tests`
2. **C2:** `feat(auth): tolerate null res in setOpenIDAuthTokens + regression test`
3. **C3:** `feat(api): add refreshOIDCAccessToken bridge + tests`
4. **C4:** `feat(endpoints): forward OIDC access_token as apiKey across all LLM endpoints`
5. **C5:** `chore(openid): remove legacy uid-${openidId} updateUserKey auto-import`
6. **C6:** `feat(startup): reject non-OIDC providers when OIDC_FORWARD_TO_LLM=true + docs`

---

## Prerequisites

- [ ] **Step P.1: Verify on `main` with PR-1 merged**

Run:
```bash
git checkout main
git pull --ff-only
git log --oneline -3
```

Expected: top commit is the PR-1 merge.

- [ ] **Step P.2: Confirm clean tree**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

- [ ] **Step P.3: Create feature branch**

Run:
```bash
git checkout -b feat/oidc-llm-forwarding
```

Expected: `Switched to a new branch 'feat/oidc-llm-forwarding'`

- [ ] **Step P.4: Verify upstream prerequisite files exist**

Run:
```bash
test -f packages/api/src/utils/oidc.ts && \
  test -f packages/api/src/types/endpoints.ts && \
  grep -q "extractOpenIDTokenInfo" packages/api/src/utils/oidc.ts && \
  grep -q "BaseInitializeParams" packages/api/src/types/endpoints.ts && \
  echo "prerequisites present"
```

Expected: `prerequisites present`. If not, PR-1 did not merge cleanly — go fix that first.

- [ ] **Step P.5: Verify `buildOpenIDRefreshParams` is exported from `@librechat/api`**

Run:
```bash
grep -rn "export.*buildOpenIDRefreshParams" packages/api/src/
```

Expected: at least one match (likely `packages/api/src/auth/refresh.ts` per design doc).

If absent, run `grep -rn "buildOpenIDRefreshParams" packages/api/src/` and inspect — the function might live elsewhere with a different name. Adjust the import in Task 3 accordingly.

---

## Task 1 (Commit C1): `ensureLLMBearer` Pure Helper

**Files:**
- Create: `packages/api/src/auth/llmBearer.ts`
- Create: `packages/api/src/auth/llmBearer.spec.ts`
- Modify: `packages/api/src/auth/index.ts`

### 1.1 Write failing test for non-OIDC user rejection

- [ ] **Step 1.1.1: Create the spec file with the first test**

Create `packages/api/src/auth/llmBearer.spec.ts`:

```typescript
import { ensureLLMBearer, isLLMOIDCForwardingEnabled } from './llmBearer';
import { ErrorTypes } from 'librechat-data-provider';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockRefresh = jest.fn();
const deps = { refreshOIDCAccessToken: mockRefresh };

function makeReq(overrides: Partial<{ provider: string; federatedTokens: unknown }> = {}) {
  const user = {
    _id: 'user-1',
    id: 'user-1',
    provider: 'openid',
    federatedTokens: {
      access_token: 'jwt-good',
      id_token: 'id-good',
      refresh_token: 'refresh-good',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
    ...overrides,
  };
  return { user } as unknown as Parameters<typeof ensureLLMBearer>[0];
}

beforeEach(() => {
  mockRefresh.mockReset();
});

describe('ensureLLMBearer', () => {
  it('throws AUTH_FAILED for non-OIDC user', async () => {
    const req = makeReq({ provider: 'local' });
    await expect(ensureLLMBearer(req, deps)).rejects.toThrow(
      JSON.stringify({ type: ErrorTypes.AUTH_FAILED }),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 1.1.2: Run the test, confirm it fails for the right reason**

Run:
```bash
cd packages/api && npx jest src/auth/llmBearer.spec.ts
```

Expected: `Cannot find module './llmBearer'` (the file doesn't exist yet).

### 1.2 Implement minimum to pass the first test

- [ ] **Step 1.2.1: Create the module with just enough code**

Create `packages/api/src/auth/llmBearer.ts`:

```typescript
import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type { Request } from 'express';
import type { IUser } from '@librechat/data-schemas';
import { extractOpenIDTokenInfo, isOpenIDTokenValid } from '~/utils/oidc';
import { isEnabled } from '~/utils';

const REFRESH_LEEWAY_SECONDS = 60;
const inflightRefresh = new Map<string, Promise<void>>();

export interface LLMBearer {
  accessToken: string;
  refreshed: boolean;
}

export interface EnsureLLMBearerDeps {
  refreshOIDCAccessToken: (req: Request) => Promise<void>;
}

export function isLLMOIDCForwardingEnabled(): boolean {
  return isEnabled(process.env.OIDC_FORWARD_TO_LLM);
}

export async function ensureLLMBearer(
  req: Request,
  deps: EnsureLLMBearerDeps,
): Promise<LLMBearer> {
  const user = req.user as IUser | undefined;

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
    tokenInfo = extractOpenIDTokenInfo(req.user as IUser);
    refreshed = true;
  }

  if (!isOpenIDTokenValid(tokenInfo)) {
    throw new Error(JSON.stringify({ type: ErrorTypes.AUTH_FAILED }));
  }

  return { accessToken: tokenInfo!.accessToken!, refreshed };
}

async function dedupedRefresh(req: Request, deps: EnsureLLMBearerDeps): Promise<void> {
  const userId = String((req.user as IUser)._id);
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

- [ ] **Step 1.2.2: Run the test, confirm it passes**

Run:
```bash
cd packages/api && npx jest src/auth/llmBearer.spec.ts
```

Expected: 1 passing.

### 1.3 Add test for healthy token (no refresh)

- [ ] **Step 1.3.1: Append test**

Add to `llmBearer.spec.ts` inside `describe('ensureLLMBearer', ...)`:

```typescript
  it('returns access_token without refresh when expiry > leeway', async () => {
    const req = makeReq();
    const result = await ensureLLMBearer(req, deps);
    expect(result).toEqual({ accessToken: 'jwt-good', refreshed: false });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
```

- [ ] **Step 1.3.2: Run, expect pass**

Run: `cd packages/api && npx jest src/auth/llmBearer.spec.ts`
Expected: 2 passing.

### 1.4 Add test for near-expiry triggering refresh

- [ ] **Step 1.4.1: Append test**

```typescript
  it('triggers refresh when token expires within leeway window', async () => {
    const req = makeReq({
      federatedTokens: {
        access_token: 'jwt-stale',
        id_token: 'id-stale',
        refresh_token: 'refresh-stale',
        expires_at: Math.floor(Date.now() / 1000) + 30, // < 60s leeway
      },
    });
    mockRefresh.mockImplementation(async (r) => {
      (r.user as { federatedTokens: { access_token: string; expires_at: number } }).federatedTokens = {
        access_token: 'jwt-fresh',
        id_token: 'id-fresh',
        refresh_token: 'refresh-fresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      } as never;
    });
    const result = await ensureLLMBearer(req, deps);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accessToken: 'jwt-fresh', refreshed: true });
  });
```

- [ ] **Step 1.4.2: Run, expect pass**

Run: `cd packages/api && npx jest src/auth/llmBearer.spec.ts`
Expected: 3 passing.

### 1.5 Add test for refresh failure → AUTH_FAILED

- [ ] **Step 1.5.1: Append test**

```typescript
  it('throws AUTH_FAILED when refresh throws', async () => {
    const req = makeReq({
      federatedTokens: {
        access_token: 'jwt-stale',
        expires_at: Math.floor(Date.now() / 1000) + 10,
      },
    });
    mockRefresh.mockRejectedValue(new Error('invalid_grant'));
    await expect(ensureLLMBearer(req, deps)).rejects.toThrow(/invalid_grant/);
  });
```

Note: the error message is allowed to bubble — `ensureLLMBearer` does not catch refresh errors; the calling code will see the original error. The route-layer error handler will translate to AUTH_FAILED for the user. We document this in the design but don't wrap the error.

- [ ] **Step 1.5.2: Run, expect pass**

Run: `cd packages/api && npx jest src/auth/llmBearer.spec.ts`
Expected: 4 passing.

### 1.6 Add test for refresh producing invalid token

- [ ] **Step 1.6.1: Append test**

```typescript
  it('throws AUTH_FAILED when post-refresh token is still invalid', async () => {
    const req = makeReq({ federatedTokens: { access_token: '', expires_at: 0 } });
    mockRefresh.mockImplementation(async (r) => {
      (r.user as { federatedTokens: unknown }).federatedTokens = { access_token: '' };
    });
    await expect(ensureLLMBearer(req, deps)).rejects.toThrow(
      JSON.stringify({ type: ErrorTypes.AUTH_FAILED }),
    );
  });
```

- [ ] **Step 1.6.2: Run, expect pass**

Run: `cd packages/api && npx jest src/auth/llmBearer.spec.ts`
Expected: 5 passing.

### 1.7 Add test for concurrent refresh dedup

- [ ] **Step 1.7.1: Append test**

```typescript
  it('deduplicates concurrent refresh calls for the same user', async () => {
    const req = makeReq({
      federatedTokens: {
        access_token: 'jwt-stale',
        expires_at: Math.floor(Date.now() / 1000) + 10,
      },
    });
    let resolveRefresh: () => void = () => {};
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    mockRefresh.mockImplementation(async (r) => {
      await refreshPromise;
      (r.user as { federatedTokens: unknown }).federatedTokens = {
        access_token: 'jwt-fresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    });
    const calls = [
      ensureLLMBearer(req, deps),
      ensureLLMBearer(req, deps),
      ensureLLMBearer(req, deps),
      ensureLLMBearer(req, deps),
      ensureLLMBearer(req, deps),
    ];
    // Let microtasks settle so all 5 calls enter the dedupedRefresh path.
    await Promise.resolve();
    resolveRefresh();
    const results = await Promise.all(calls);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    results.forEach((r) => expect(r.accessToken).toBe('jwt-fresh'));
  });
```

- [ ] **Step 1.7.2: Run, expect pass**

Run: `cd packages/api && npx jest src/auth/llmBearer.spec.ts`
Expected: 6 passing.

### 1.8 Add test for token literal not leaking to logger

- [ ] **Step 1.8.1: Append test**

```typescript
  it('does not pass access_token literal to logger', async () => {
    const { logger } = jest.requireMock('@librechat/data-schemas');
    const secret = 'super-secret-jwt-xyz';
    const req = makeReq({
      federatedTokens: { access_token: secret, expires_at: Math.floor(Date.now() / 1000) + 10 },
    });
    mockRefresh.mockImplementation(async () => {});
    try {
      await ensureLLMBearer(req, deps);
    } catch {
      /* expected to throw because refresh did not update token */
    }
    for (const call of (logger.debug as jest.Mock).mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(secret);
      }
    }
  });
```

- [ ] **Step 1.8.2: Run, expect pass**

Run: `cd packages/api && npx jest src/auth/llmBearer.spec.ts`
Expected: 7 passing.

### 1.9 Add `isLLMOIDCForwardingEnabled` tests

- [ ] **Step 1.9.1: Append describe block**

```typescript
describe('isLLMOIDCForwardingEnabled', () => {
  const original = process.env.OIDC_FORWARD_TO_LLM;
  afterEach(() => {
    if (original === undefined) delete process.env.OIDC_FORWARD_TO_LLM;
    else process.env.OIDC_FORWARD_TO_LLM = original;
  });

  it('returns true when env var enabled', () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    expect(isLLMOIDCForwardingEnabled()).toBe(true);
  });

  it('returns false when env var absent', () => {
    delete process.env.OIDC_FORWARD_TO_LLM;
    expect(isLLMOIDCForwardingEnabled()).toBe(false);
  });

  it('returns false when env var literally "false"', () => {
    process.env.OIDC_FORWARD_TO_LLM = 'false';
    expect(isLLMOIDCForwardingEnabled()).toBe(false);
  });
});
```

- [ ] **Step 1.9.2: Run, expect pass**

Run: `cd packages/api && npx jest src/auth/llmBearer.spec.ts`
Expected: 10 passing.

### 1.10 Re-export from auth/index.ts

- [ ] **Step 1.10.1: Append re-export**

Read `packages/api/src/auth/index.ts` first, then add at bottom:

```typescript
export * from './llmBearer';
```

- [ ] **Step 1.10.2: Verify nothing else breaks**

Run: `cd packages/api && npx jest`
Expected: full package test suite still green.

### 1.11 Commit C1

- [ ] **Step 1.11.1: Stage and commit**

```bash
git add packages/api/src/auth/llmBearer.ts \
        packages/api/src/auth/llmBearer.spec.ts \
        packages/api/src/auth/index.ts
git commit -m "feat(api): add ensureLLMBearer + isLLMOIDCForwardingEnabled + tests

Pure helper for forwarding the user's OIDC access_token to the upstream
LLM gateway. Handles 60s pre-refresh leeway and deduplicates concurrent
refreshes per user in-process. No DB or server-layer imports — server
side injects refreshOIDCAccessToken via the deps argument.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: commit created.

---

## Task 2 (Commit C2): Tolerate `res === null` in `setOpenIDAuthTokens`

**Files:**
- Modify: `api/server/services/AuthService.js`
- Modify: `api/server/services/AuthService.spec.js`

### 2.1 Read current implementation

- [ ] **Step 2.1.1: Locate `setOpenIDAuthTokens`**

Run:
```bash
grep -n "setOpenIDAuthTokens\|res.cookie" api/server/services/AuthService.js | head -40
```

Note the line numbers of each `res.cookie(...)` call inside the function (typically: `refreshToken`, `openid_access_token` fallback, `openid_id_token` fallback, `token_provider`, `openid_user_id`, plus the `setCloudFrontAuthCookies` helper call which itself uses `res`).

### 2.2 Write failing regression test

- [ ] **Step 2.2.1: Add test to AuthService.spec.js**

Open `api/server/services/AuthService.spec.js`. Add a new `describe`:

```javascript
describe('setOpenIDAuthTokens with null res', () => {
  const { setOpenIDAuthTokens } = require('./AuthService');

  it('does not throw when res is null and writes session only', () => {
    const req = {
      session: {},
      user: { _id: 'u1', id: 'u1' },
    };
    const tokenset = {
      access_token: 'at',
      id_token: 'it',
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    expect(() => setOpenIDAuthTokens(tokenset, req, null, { userId: 'u1' })).not.toThrow();
    expect(req.session.openidTokens).toMatchObject({
      accessToken: 'at',
      idToken: 'it',
      refreshToken: 'rt',
    });
  });
});
```

- [ ] **Step 2.2.2: Run the test, confirm it fails**

Run: `npx jest api/server/services/AuthService.spec.js -t "null res"`
Expected: FAIL — likely `TypeError: Cannot read properties of null (reading 'cookie')`.

### 2.3 Patch `setOpenIDAuthTokens` to guard every `res.cookie`

- [ ] **Step 2.3.1: Wrap each cookie write**

Open `api/server/services/AuthService.js`. For every line of the form:

```javascript
res.cookie('xxx', ..., { ... });
```

inside `setOpenIDAuthTokens` (and the fallback branch and `setCloudFrontAuthCookies` call), wrap with:

```javascript
if (res && typeof res.cookie === 'function') {
  res.cookie('xxx', ..., { ... });
}
```

For the `setCloudFrontAuthCookies(req, res, req.user, { userId, tenantId });` call, also guard:

```javascript
if (res && typeof res.cookie === 'function') {
  setCloudFrontAuthCookies(req, res, req.user, { userId, tenantId });
}
```

(Reading `setCloudFrontAuthCookies` source confirms it calls `res.cookie` internally; if it tolerates null `res` itself, this outer guard is unnecessary — verify by grep before deciding.)

- [ ] **Step 2.3.2: Run the regression test, expect pass**

Run: `npx jest api/server/services/AuthService.spec.js -t "null res"`
Expected: PASS.

- [ ] **Step 2.3.3: Run the full AuthService spec suite to confirm no regression**

Run: `npx jest api/server/services/AuthService.spec.js`
Expected: all green.

### 2.4 Commit C2

- [ ] **Step 2.4.1: Commit**

```bash
git add api/server/services/AuthService.js api/server/services/AuthService.spec.js
git commit -m "feat(auth): tolerate null res in setOpenIDAuthTokens

Allows the function to be invoked from non-HTTP-response code paths
(specifically the upcoming refreshOIDCAccessToken bridge used during
LLM request preprocessing). Session writes — the source of truth — are
unaffected; only res.cookie writes are guarded.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 (Commit C3): `refreshOIDCAccessToken` Bridge

**Files:**
- Create: `api/server/services/Auth/refreshOIDCToken.js`
- Create: `api/server/services/Auth/refreshOIDCToken.spec.js`

### 3.1 Verify import paths exist

- [ ] **Step 3.1.1: Confirm `getOpenIdConfig` and `buildOpenIDRefreshParams` are exported**

Run:
```bash
grep -n "getOpenIdConfig" api/strategies/openidStrategy.js | tail -3
grep -rn "buildOpenIDRefreshParams" packages/api/src/ | head -5
node -e "console.log(Object.keys(require('@librechat/api')).filter(k => k.includes('Refresh') || k.includes('OpenID')))"
```

Expected: `getOpenIdConfig` exported from `api/strategies/openidStrategy.js`; `buildOpenIDRefreshParams` listed by the node command.

If `buildOpenIDRefreshParams` is not exported from `@librechat/api`, add an export in `packages/api/src/auth/index.ts`:

```typescript
export { buildOpenIDRefreshParams } from './refresh';
```

Rebuild the package: `cd packages/api && npm run build` (or whatever the workspace's build command is).

### 3.2 Write failing test for missing refresh_token

- [ ] **Step 3.2.1: Create spec file**

Create `api/server/services/Auth/refreshOIDCToken.spec.js`:

```javascript
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
jest.mock('@librechat/api', () => ({ buildOpenIDRefreshParams: jest.fn(() => ({})) }));
jest.mock('~/server/services/AuthService', () => ({ setOpenIDAuthTokens: jest.fn() }));
jest.mock('~/strategies/openidStrategy', () => ({ getOpenIdConfig: jest.fn(() => 'mock-config') }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const openIdClient = require('openid-client');
const { setOpenIDAuthTokens } = require('~/server/services/AuthService');
const { refreshOIDCAccessToken } = require('./refreshOIDCToken');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('refreshOIDCAccessToken', () => {
  it('throws when refresh_token is absent', async () => {
    const req = { session: { openidTokens: {} }, user: { id: 'u1' } };
    await expect(refreshOIDCAccessToken(req)).rejects.toThrow(
      'No refresh_token available for OIDC refresh',
    );
    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3.2.2: Run test, confirm it fails**

Run: `npx jest api/server/services/Auth/refreshOIDCToken.spec.js`
Expected: `Cannot find module './refreshOIDCToken'`.

### 3.3 Implement minimal bridge to pass first test

- [ ] **Step 3.3.1: Create the bridge module**

Create `api/server/services/Auth/refreshOIDCToken.js`:

```javascript
const { logger } = require('@librechat/data-schemas');
const openIdClient = require('openid-client');
const { buildOpenIDRefreshParams } = require('@librechat/api');
const { setOpenIDAuthTokens } = require('~/server/services/AuthService');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');

/**
 * Refreshes the user's OpenID access_token using the refresh_token stored
 * in express-session. Updates req.session.openidTokens (via setOpenIDAuthTokens)
 * and req.user.federatedTokens in place. Throws on any failure.
 */
async function refreshOIDCAccessToken(req) {
  const refreshToken = req.session?.openidTokens?.refreshToken;
  if (!refreshToken) {
    throw new Error('No refresh_token available for OIDC refresh');
  }

  const openIdConfig = getOpenIdConfig();
  const refreshParams = buildOpenIDRefreshParams();
  let tokenset;
  try {
    tokenset = await openIdClient.refreshTokenGrant(openIdConfig, refreshToken, refreshParams);
  } catch (error) {
    logger.error('[refreshOIDCAccessToken] grant failed', { message: error.message });
    throw error;
  }

  setOpenIDAuthTokens(tokenset, req, null, {
    userId: req.user?.id,
    existingRefreshToken: refreshToken,
  });

  if (!req.user) {
    req.user = {};
  }
  req.user.federatedTokens = {
    access_token: tokenset.access_token,
    id_token: tokenset.id_token,
    refresh_token: tokenset.refresh_token || refreshToken,
    expires_at: tokenset.expires_at,
  };
}

module.exports = { refreshOIDCAccessToken };
```

- [ ] **Step 3.3.2: Run first test, expect pass**

Run: `npx jest api/server/services/Auth/refreshOIDCToken.spec.js`
Expected: 1 passing.

### 3.4 Test successful refresh updates session + federatedTokens

- [ ] **Step 3.4.1: Append test**

```javascript
  it('on success updates session via setOpenIDAuthTokens and rewrites req.user.federatedTokens', async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-at',
      id_token: 'new-it',
      refresh_token: 'new-rt',
      expires_at: 1234567890,
    });
    const req = {
      session: { openidTokens: { refreshToken: 'old-rt' } },
      user: { id: 'u1' },
    };
    await refreshOIDCAccessToken(req);
    expect(openIdClient.refreshTokenGrant).toHaveBeenCalledWith('mock-config', 'old-rt', {});
    expect(setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'new-at' }),
      req,
      null,
      { userId: 'u1', existingRefreshToken: 'old-rt' },
    );
    expect(req.user.federatedTokens).toEqual({
      access_token: 'new-at',
      id_token: 'new-it',
      refresh_token: 'new-rt',
      expires_at: 1234567890,
    });
  });
```

- [ ] **Step 3.4.2: Run, expect pass**

Run: `npx jest api/server/services/Auth/refreshOIDCToken.spec.js`
Expected: 2 passing.

### 3.5 Test refresh_token rotation fallback

- [ ] **Step 3.5.1: Append test**

```javascript
  it('preserves existing refresh_token when IdP does not return a new one (Cognito case)', async () => {
    openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-at',
      id_token: 'new-it',
      refresh_token: undefined,
      expires_at: 1234567890,
    });
    const req = {
      session: { openidTokens: { refreshToken: 'old-rt' } },
      user: { id: 'u1' },
    };
    await refreshOIDCAccessToken(req);
    expect(req.user.federatedTokens.refresh_token).toBe('old-rt');
  });
```

- [ ] **Step 3.5.2: Run, expect pass**

Run: `npx jest api/server/services/Auth/refreshOIDCToken.spec.js`
Expected: 3 passing.

### 3.6 Test grant failure propagates and logs sanitized error

- [ ] **Step 3.6.1: Append test**

```javascript
  it('propagates grant errors and logs without leaking secrets', async () => {
    const { logger } = jest.requireMock('@librechat/data-schemas');
    openIdClient.refreshTokenGrant.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), { response: { data: { access_token: 'secret' } } }),
    );
    const req = {
      session: { openidTokens: { refreshToken: 'old-rt' } },
      user: { id: 'u1' },
    };
    await expect(refreshOIDCAccessToken(req)).rejects.toThrow('invalid_grant');
    expect(setOpenIDAuthTokens).not.toHaveBeenCalled();
    for (const call of logger.error.mock.calls) {
      for (const arg of call) {
        expect(JSON.stringify(arg)).not.toContain('secret');
      }
    }
  });
```

- [ ] **Step 3.6.2: Run, expect pass**

Run: `npx jest api/server/services/Auth/refreshOIDCToken.spec.js`
Expected: 4 passing.

### 3.7 Commit C3

- [ ] **Step 3.7.1: Commit**

```bash
git add api/server/services/Auth/refreshOIDCToken.js \
        api/server/services/Auth/refreshOIDCToken.spec.js
# also stage packages/api/src/auth/index.ts if Step 3.1.1 required an export
git diff --staged --name-only
git commit -m "feat(api): add refreshOIDCAccessToken bridge + tests

Server-layer bridge between ensureLLMBearer (packages/api) and the
openid-client refreshTokenGrant call. Updates session via the existing
setOpenIDAuthTokens helper, then mirrors the new tokens onto
req.user.federatedTokens for downstream consumers.

Uses tokenset.expires_at (access_token's actual TTL in seconds) for the
federatedTokens mirror — NOT req.session.openidTokens.expiresAt, which
is the refresh_token cookie lifetime.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 (Commit C4): Endpoint Initializers

**Files:**
- Modify: `packages/api/src/types/endpoints.ts`
- Modify: `packages/api/src/endpoints/openai/initialize.ts`
- Modify: `packages/api/src/endpoints/openai/initialize.spec.ts`
- Modify: `packages/api/src/endpoints/anthropic/initialize.ts`
- Create/Modify: `packages/api/src/endpoints/anthropic/initialize.spec.ts`
- Modify: `packages/api/src/endpoints/custom/initialize.ts`
- Modify: `packages/api/src/endpoints/custom/initialize.spec.ts`
- Modify: `api/server/services/Endpoints/azureAssistants/initialize.js`
- Modify: `api/server/services/Endpoints/azureAssistants/initialize.spec.js` (if exists)
- Modify: `api/server/controllers/agents/client.js`
- Modify: `api/server/controllers/agents/openai.js`
- Modify: `api/server/controllers/agents/responses.js`
- Modify: `api/server/services/Endpoints/agents/initialize.js`
- Modify: `api/server/services/Endpoints/agents/addedConvo.js`

### 4.1 Extend `BaseInitializeParams`

- [ ] **Step 4.1.1: Read current shape**

Run:
```bash
grep -nA15 "BaseInitializeParams" packages/api/src/types/endpoints.ts | head -25
```

Expected: 4-field interface as seen in the design doc.

- [ ] **Step 4.1.2: Add the optional `refreshOIDCAccessToken` field**

Edit `packages/api/src/types/endpoints.ts`. Update `BaseInitializeParams`:

```typescript
import type { Request as ExpressRequest } from 'express';
// ... existing imports ...

export interface BaseInitializeParams {
  req: ServerRequest;
  endpoint: string;
  model_parameters?: Record<string, unknown>;
  db: EndpointDbMethods;
  /**
   * Injected by api/server/ callers. Bridges to openid-client +
   * AuthService.setOpenIDAuthTokens. Undefined in unit tests or older
   * call paths — when undefined, the OIDC bearer override is skipped.
   */
  refreshOIDCAccessToken?: (req: ExpressRequest) => Promise<void>;
}
```

If `ExpressRequest` is not the canonical type used in this file (e.g., `ServerRequest` is a typed wrapper), use the matching type — read 2-3 nearby type signatures to confirm.

- [ ] **Step 4.1.3: Verify package still builds**

Run: `cd packages/api && npm run build`
Expected: TypeScript compiles cleanly.

### 4.2 Write failing test for OpenAI initializer OIDC override

- [ ] **Step 4.2.1: Read existing spec to understand the test setup pattern**

Run:
```bash
grep -nB2 -A10 "initializeOpenAI\|getOpenAIConfig" packages/api/src/endpoints/openai/initialize.spec.ts | head -50
```

Note how `getOpenAIConfig` is mocked and how `apiKey` is asserted.

- [ ] **Step 4.2.2: Append a new describe block for OIDC**

Add to `packages/api/src/endpoints/openai/initialize.spec.ts`:

```typescript
describe('initializeOpenAI — OIDC apiKey override', () => {
  const ORIGINAL = process.env.OIDC_FORWARD_TO_LLM;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OIDC_FORWARD_TO_LLM;
    else process.env.OIDC_FORWARD_TO_LLM = ORIGINAL;
    jest.clearAllMocks();
  });

  it('replaces apiKey with OIDC access_token when flag on and user is OIDC', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.OPENAI_API_KEY = 'env-key';
    const { getOpenAIConfig } = jest.requireMock('./config');
    getOpenAIConfig.mockReturnValue({ llmConfig: {} });
    const refreshOIDC = jest.fn();
    const req = {
      user: {
        _id: 'u1',
        id: 'u1',
        provider: 'openid',
        federatedTokens: {
          access_token: 'oidc-jwt',
          id_token: 'oidc-id',
          refresh_token: 'oidc-r',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      body: {},
      config: {},
    };
    await initializeOpenAI({
      req: req as never,
      endpoint: 'openAI',
      model_parameters: { model: 'gpt-4' },
      db: { getUserKeyValues: jest.fn() } as never,
      refreshOIDCAccessToken: refreshOIDC,
    });
    expect(getOpenAIConfig).toHaveBeenCalledWith('oidc-jwt', expect.any(Object), 'openAI');
  });

  it('falls back to env apiKey when flag off', async () => {
    delete process.env.OIDC_FORWARD_TO_LLM;
    process.env.OPENAI_API_KEY = 'env-key';
    const { getOpenAIConfig } = jest.requireMock('./config');
    getOpenAIConfig.mockReturnValue({ llmConfig: {} });
    const req = {
      user: { _id: 'u1', id: 'u1', provider: 'openid', federatedTokens: { access_token: 'oidc-jwt' } },
      body: {},
      config: {},
    };
    await initializeOpenAI({
      req: req as never,
      endpoint: 'openAI',
      model_parameters: { model: 'gpt-4' },
      db: { getUserKeyValues: jest.fn() } as never,
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(getOpenAIConfig).toHaveBeenCalledWith('env-key', expect.any(Object), 'openAI');
  });

  it('falls back to env apiKey when flag on but user is not OIDC', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.OPENAI_API_KEY = 'env-key';
    const { getOpenAIConfig } = jest.requireMock('./config');
    getOpenAIConfig.mockReturnValue({ llmConfig: {} });
    const req = {
      user: { _id: 'u1', id: 'u1', provider: 'local' },
      body: {},
      config: {},
    };
    await initializeOpenAI({
      req: req as never,
      endpoint: 'openAI',
      model_parameters: { model: 'gpt-4' },
      db: { getUserKeyValues: jest.fn() } as never,
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(getOpenAIConfig).toHaveBeenCalledWith('env-key', expect.any(Object), 'openAI');
  });
});
```

- [ ] **Step 4.2.3: Run tests, expect failure**

Run: `cd packages/api && npx jest src/endpoints/openai/initialize.spec.ts -t "OIDC apiKey override"`
Expected: failures — `getOpenAIConfig` called with `'env-key'` instead of `'oidc-jwt'` in the first case.

### 4.3 Implement OIDC override in OpenAI initializer

- [ ] **Step 4.3.1: Edit `initialize.ts`**

Open `packages/api/src/endpoints/openai/initialize.ts`. Add imports:

```typescript
import { ensureLLMBearer, isLLMOIDCForwardingEnabled } from '~/auth/llmBearer';
import { ErrorTypes } from 'librechat-data-provider';
```

Locate the line `const options = getOpenAIConfig(apiKey, finalClientOptions, endpoint);` (around line 148 in upstream). Immediately before `const options = ...` but after all `apiKey` mutations (so after the Azure branch sets `apiKey = azureOptions.azureOpenAIApiKey`), insert:

```typescript
  // Fork-only: forward the user's OIDC access_token as the API key.
  // SDK header semantics handle the wire format (OpenAI uses
  // Authorization: Bearer, Azure uses api-key). When the flag is off
  // or the user is not OIDC, the original apiKey is preserved.
  if (
    isLLMOIDCForwardingEnabled() &&
    req.user?.provider === 'openid' &&
    refreshOIDCAccessToken
  ) {
    const { accessToken } = await ensureLLMBearer(req, { refreshOIDCAccessToken });
    apiKey = accessToken;
    if (isAzureOpenAI && clientOptions.azure) {
      clientOptions.azure = { ...clientOptions.azure, azureOpenAIApiKey: accessToken };
    }
  }
```

Add `refreshOIDCAccessToken` to the destructured params at the function signature:

```typescript
export async function initializeOpenAI({
  req,
  endpoint,
  model_parameters,
  db,
  refreshOIDCAccessToken,
}: BaseInitializeParams): Promise<InitializeResultBase> {
```

- [ ] **Step 4.3.2: Run tests, expect pass**

Run: `cd packages/api && npx jest src/endpoints/openai/initialize.spec.ts -t "OIDC apiKey override"`
Expected: 3 passing.

- [ ] **Step 4.3.3: Run the full OpenAI initialize spec to confirm no regression**

Run: `cd packages/api && npx jest src/endpoints/openai/initialize.spec.ts`
Expected: all green.

### 4.4 Repeat for Anthropic initializer

- [ ] **Step 4.4.1: Check if a spec file exists**

Run: `ls packages/api/src/endpoints/anthropic/initialize.spec.ts 2>&1`

If absent, create with this skeleton (mirroring the OpenAI spec's mock pattern). If present, append to existing.

- [ ] **Step 4.4.2: Add OIDC tests**

```typescript
describe('initializeAnthropic — OIDC apiKey override', () => {
  const ORIGINAL = process.env.OIDC_FORWARD_TO_LLM;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OIDC_FORWARD_TO_LLM;
    else process.env.OIDC_FORWARD_TO_LLM = ORIGINAL;
    jest.clearAllMocks();
  });

  it('replaces ANTHROPIC_API_KEY with OIDC access_token when flag on', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const { getLLMConfig } = jest.requireMock('./llm');
    getLLMConfig.mockReturnValue({ llmConfig: {} });
    const req = {
      user: {
        _id: 'u1',
        id: 'u1',
        provider: 'openid',
        federatedTokens: {
          access_token: 'oidc-jwt',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      body: {},
      config: {},
    };
    await initializeAnthropic({
      req: req as never,
      endpoint: 'anthropic',
      model_parameters: {},
      db: { getUserKey: jest.fn() } as never,
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(getLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({ anthropicApiKey: 'oidc-jwt' }),
      expect.any(Object),
    );
  });
});
```

(Note: the `anthropicApiKey` key on `credentials` is `AuthKeys.ANTHROPIC_API_KEY`. Confirm the actual key string by `grep AuthKeys.ANTHROPIC_API_KEY packages/api/src/endpoints/anthropic/initialize.ts`. Adjust the assertion to match.)

- [ ] **Step 4.4.3: Run, expect fail**

Run: `cd packages/api && npx jest src/endpoints/anthropic/initialize.spec.ts -t "OIDC apiKey override"`
Expected: fail (env key flows through).

- [ ] **Step 4.4.4: Implement override**

In `packages/api/src/endpoints/anthropic/initialize.ts`:

Add imports:
```typescript
import { ensureLLMBearer, isLLMOIDCForwardingEnabled } from '~/auth/llmBearer';
```

Add `refreshOIDCAccessToken` to the destructured params (same as OpenAI). Before `const result = getLLMConfig(credentials, clientOptions);`, insert:

```typescript
  if (
    isLLMOIDCForwardingEnabled() &&
    req.user?.provider === 'openid' &&
    refreshOIDCAccessToken
  ) {
    const { accessToken } = await ensureLLMBearer(req, { refreshOIDCAccessToken });
    credentials[AuthKeys.ANTHROPIC_API_KEY] = accessToken;
  }
```

- [ ] **Step 4.4.5: Run, expect pass**

Run: `cd packages/api && npx jest src/endpoints/anthropic/initialize.spec.ts`
Expected: all green.

### 4.5 Repeat for Custom initializer with baseURL guard

- [ ] **Step 4.5.1: Add OIDC tests + baseURL guard test**

Append to `packages/api/src/endpoints/custom/initialize.spec.ts`:

```typescript
describe('initializeCustom — OIDC apiKey override', () => {
  const ORIGINAL = process.env.OIDC_FORWARD_TO_LLM;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OIDC_FORWARD_TO_LLM;
    else process.env.OIDC_FORWARD_TO_LLM = ORIGINAL;
    jest.clearAllMocks();
  });

  it('replaces apiKey with OIDC access_token when flag on', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    const { getCustomEndpointConfig } = jest.requireMock('~/app/config');
    getCustomEndpointConfig.mockReturnValue({ apiKey: 'env-key', baseURL: 'https://gateway' });
    const { getOpenAIConfig } = jest.requireMock('~/endpoints/openai/config');
    getOpenAIConfig.mockReturnValue({ llmConfig: {} });
    const req = {
      user: {
        _id: 'u1',
        id: 'u1',
        provider: 'openid',
        federatedTokens: {
          access_token: 'oidc-jwt',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      body: {},
      config: {},
    };
    await initializeCustom({
      req: req as never,
      endpoint: 'myproxy',
      model_parameters: {},
      db: { getUserKeyValues: jest.fn() } as never,
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(getOpenAIConfig).toHaveBeenCalledWith('oidc-jwt', expect.any(Object), 'myproxy');
  });

  it('throws when user-provided baseURL combined with OIDC mode', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    const { getCustomEndpointConfig } = jest.requireMock('~/app/config');
    getCustomEndpointConfig.mockReturnValue({ apiKey: 'env-key', baseURL: 'user_provided' });
    const req = {
      user: { _id: 'u1', id: 'u1', provider: 'openid', federatedTokens: { access_token: 'oidc-jwt' } },
      body: {},
      config: {},
    };
    await expect(
      initializeCustom({
        req: req as never,
        endpoint: 'myproxy',
        model_parameters: {},
        db: { getUserKeyValues: jest.fn(() => Promise.resolve({ baseURL: 'https://attacker.com' })) } as never,
        refreshOIDCAccessToken: jest.fn(),
      }),
    ).rejects.toThrow(/user-provided baseURL disallowed/);
  });
});
```

- [ ] **Step 4.5.2: Run, expect fail**

Run: `cd packages/api && npx jest src/endpoints/custom/initialize.spec.ts -t "OIDC apiKey override"`
Expected: failures.

- [ ] **Step 4.5.3: Implement override + guard**

In `packages/api/src/endpoints/custom/initialize.ts`:

Add imports:
```typescript
import { ensureLLMBearer, isLLMOIDCForwardingEnabled } from '~/auth/llmBearer';
```

Add `refreshOIDCAccessToken` to destructured params. Before `const options = getOpenAIConfig(apiKey, finalClientOptions, endpoint);`, insert:

```typescript
  if (
    isLLMOIDCForwardingEnabled() &&
    req.user?.provider === 'openid' &&
    refreshOIDCAccessToken
  ) {
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

- [ ] **Step 4.5.4: Run, expect pass**

Run: `cd packages/api && npx jest src/endpoints/custom/initialize.spec.ts`
Expected: all green.

### 4.6 Repeat for AzureAssistants initializer

- [ ] **Step 4.6.1: Locate the file**

Run: `cat api/server/services/Endpoints/azureAssistants/initialize.js | head -50`

This is JavaScript, not TypeScript. The patch shape is identical but imports use `require`.

- [ ] **Step 4.6.2: Check for existing spec file**

Run: `ls api/server/services/Endpoints/azureAssistants/initialize.spec.js 2>&1`

If absent, create with the same OIDC-override / fallback / non-OIDC test triad.

- [ ] **Step 4.6.3: Write failing test, then implement**

Follow the same TDD pattern as Steps 4.4.2-4.4.5. The implementation pattern:

```javascript
const { ensureLLMBearer, isLLMOIDCForwardingEnabled } = require('@librechat/api');

// ... existing code ...

if (
  isLLMOIDCForwardingEnabled() &&
  req.user?.provider === 'openid' &&
  refreshOIDCAccessToken
) {
  const { accessToken } = await ensureLLMBearer(req, { refreshOIDCAccessToken });
  if (opts.azure) {
    opts.azure = { ...opts.azure, azureOpenAIApiKey: accessToken };
  }
  apiKey = accessToken;
}
```

(Read the file's existing variable names — `opts` may be called `clientOptions` or other.)

### 4.7 Wire DI from server-layer controllers

For each server-side caller of an initializer, pass `refreshOIDCAccessToken`.

- [ ] **Step 4.7.1: Find all caller files**

Run:
```bash
grep -rn "initializeOpenAI\|initializeAnthropic\|initializeCustom\|initializeClient" api/server/ --include="*.js" | grep -v spec
```

Expected list (post-merge): controllers/agents/client.js, controllers/agents/openai.js, controllers/agents/responses.js, services/Endpoints/agents/initialize.js, services/Endpoints/agents/addedConvo.js, possibly others.

- [ ] **Step 4.7.2: For each caller, add the import and pass it**

At the top of each file, add:
```javascript
const { refreshOIDCAccessToken } = require('~/server/services/Auth/refreshOIDCToken');
```

Find the call site where the initializer params are built (an object literal with `req`, `endpoint`, `model_parameters`, `db`). Add:
```javascript
refreshOIDCAccessToken,
```

to that object literal. The destructuring on the initializer side already accepts it as optional, so behavior with the env flag off is unchanged.

- [ ] **Step 4.7.3: Run full server test suite**

Run: `npm run test:api`
Expected: all green. If any test breaks due to the new DI field, add a `refreshOIDCAccessToken: jest.fn()` to that test's params.

### 4.8 Commit C4

- [ ] **Step 4.8.1: Stage and commit**

```bash
git add packages/api/src/types/endpoints.ts \
        packages/api/src/endpoints/openai/initialize.ts \
        packages/api/src/endpoints/openai/initialize.spec.ts \
        packages/api/src/endpoints/anthropic/initialize.ts \
        packages/api/src/endpoints/anthropic/initialize.spec.ts \
        packages/api/src/endpoints/custom/initialize.ts \
        packages/api/src/endpoints/custom/initialize.spec.ts \
        api/server/services/Endpoints/azureAssistants/initialize.js \
        api/server/services/Endpoints/azureAssistants/initialize.spec.js \
        api/server/controllers/agents/client.js \
        api/server/controllers/agents/openai.js \
        api/server/controllers/agents/responses.js \
        api/server/services/Endpoints/agents/initialize.js \
        api/server/services/Endpoints/agents/addedConvo.js

git diff --staged --name-only

git commit -m "feat(endpoints): forward OIDC access_token as apiKey across all LLM endpoints

Each endpoint initializer now checks isLLMOIDCForwardingEnabled() and
the user's OIDC provider, and overrides apiKey with the user's freshly
refreshed access_token. The SDK handles the wire-level header
(Authorization for OpenAI/custom, x-api-key for Anthropic, api-key
for Azure).

Server-layer callers inject refreshOIDCAccessToken via the
BaseInitializeParams DI hook so packages/api stays free of server-layer
imports.

Custom endpoint additionally rejects user-provided baseURL when the
flag is on, preventing token exfiltration to attacker-controlled hosts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 (Commit C5): Remove Legacy `uid-${openidId}` Blocks

**Files:**
- Modify: `api/strategies/openidStrategy.js`
- Modify: `api/strategies/openidStrategy.spec.js`

### 5.1 Write failing regression test

- [ ] **Step 5.1.1: Append assertion to openidStrategy.spec.js**

Find the existing successful-login test (look for `describe('verify callback'` or similar). Add:

```javascript
  it('does not call updateUserKey during OIDC login (legacy uid- removed)', async () => {
    const updateUserKey = require('~/models').updateUserKey;
    // updateUserKey may already be mocked in the spec setup; if not, mock here.
    updateUserKey.mockClear?.();
    // Trigger the normal successful login path (reuse the existing happy-path test's setup).
    await runVerify(/* whatever the existing helper is */);
    expect(updateUserKey).not.toHaveBeenCalled();
  });
```

If the spec does not currently mock `~/models`, add at the top:

```javascript
jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  updateUserKey: jest.fn(),
}));
```

- [ ] **Step 5.1.2: Run test, expect fail**

Run: `npx jest api/strategies/openidStrategy.spec.js -t "uid- removed"`
Expected: fail — the 5 blocks are still being called.

### 5.2 Delete the legacy blocks

- [ ] **Step 5.2.1: Locate the blocks**

Run:
```bash
grep -nB1 -A8 "updateUserKey" api/strategies/openidStrategy.js
```

Expected: 5 sequential `await updateUserKey({ ... value: ...'uid-${user.openidId}' ... })` blocks.

- [ ] **Step 5.2.2: Delete the 5 blocks and unused imports**

Edit `api/strategies/openidStrategy.js`:

1. Delete each of the 5 `await updateUserKey({...})` blocks entirely.
2. Delete (or shrink) the import line if it's the only use:
   ```javascript
   const { findUser, createUser, updateUser, updateUserKey } = require('~/models');
   ```
   becomes:
   ```javascript
   const { findUser, createUser, updateUser } = require('~/models');
   ```
3. If `EModelEndpoint` is only used by the deleted blocks, remove its import line:
   ```javascript
   const { EModelEndpoint } = require('librechat-data-provider');
   ```
   Verify with `grep -n EModelEndpoint api/strategies/openidStrategy.js` after deletion — if zero hits, remove the import.

- [ ] **Step 5.2.3: Run the spec, expect pass**

Run: `npx jest api/strategies/openidStrategy.spec.js`
Expected: all green, including the new regression test.

### 5.3 Commit C5

- [ ] **Step 5.3.1: Commit**

```bash
git add api/strategies/openidStrategy.js api/strategies/openidStrategy.spec.js
git commit -m "chore(openid): remove legacy uid-\${openidId} updateUserKey auto-import

The synthetic-apiKey-per-endpoint flow is replaced by OIDC access_token
forwarding in Task 4. Deleting these blocks stops new DB writes; existing
DB rows are not cleaned up automatically (cleanup-uid-keys script
provided separately, to be run manually post-cutover per design doc
§8 stage 7).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 (Commit C6): Startup Guard + Docs

**Files:**
- Modify: `api/server/socialLogins.js`
- Modify: `api/server/socialLogins.spec.js`
- Modify: `.env.example`
- Modify: `librechat.example.yaml`

### 6.1 Write failing test for the guard

- [ ] **Step 6.1.1: Append tests to socialLogins.spec.js**

```javascript
describe('configureSocialLogins — OIDC_FORWARD_TO_LLM guard', () => {
  const SAVE = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVE };
    jest.resetModules();
  });

  it('throws when OIDC_FORWARD_TO_LLM=true and ALLOW_GOOGLE_LOGIN=true', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.ALLOW_GOOGLE_LOGIN = 'true';
    const { configureSocialLogins } = require('./socialLogins');
    await expect(configureSocialLogins({ use: jest.fn() })).rejects.toThrow(
      /OIDC_FORWARD_TO_LLM.*google/i,
    );
  });

  it('succeeds when only OIDC is enabled', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    delete process.env.ALLOW_GOOGLE_LOGIN;
    delete process.env.ALLOW_GITHUB_LOGIN;
    delete process.env.ALLOW_FACEBOOK_LOGIN;
    delete process.env.ALLOW_DISCORD_LOGIN;
    delete process.env.ALLOW_APPLE_LOGIN;
    delete process.env.ALLOW_EMAIL_LOGIN;
    process.env.OPENID_CLIENT_ID = 'x';
    process.env.OPENID_CLIENT_SECRET = 'x';
    process.env.OPENID_ISSUER = 'https://issuer.example.com';
    const { configureSocialLogins } = require('./socialLogins');
    await expect(configureSocialLogins({ use: jest.fn() })).resolves.not.toThrow();
  });

  it('does not validate when flag off', async () => {
    delete process.env.OIDC_FORWARD_TO_LLM;
    process.env.ALLOW_GOOGLE_LOGIN = 'true';
    const { configureSocialLogins } = require('./socialLogins');
    await expect(configureSocialLogins({ use: jest.fn() })).resolves.not.toThrow();
  });
});
```

- [ ] **Step 6.1.2: Run, expect fail**

Run: `npx jest api/server/socialLogins.spec.js -t "OIDC_FORWARD_TO_LLM guard"`
Expected: failures (guard does not exist).

### 6.2 Implement the guard

- [ ] **Step 6.2.1: Add the guard at the end of `configureSocialLogins`**

Open `api/server/socialLogins.js`. At the very end of `configureSocialLogins` (or wherever the function exits), insert:

```javascript
  if (isEnabled(process.env.OIDC_FORWARD_TO_LLM)) {
    const enabledNonOIDC = ['google', 'github', 'facebook', 'discord', 'apple', 'ldap', 'saml']
      .filter((s) => isEnabled(process.env[`ALLOW_${s.toUpperCase()}_LOGIN`]));
    if (isEnabled(process.env.ALLOW_EMAIL_LOGIN)) enabledNonOIDC.push('local');
    if (enabledNonOIDC.length > 0) {
      throw new Error(
        `OIDC_FORWARD_TO_LLM is enabled but non-OIDC providers are also enabled: ${enabledNonOIDC.join(', ')}. ` +
          `Disable them or unset OIDC_FORWARD_TO_LLM.`,
      );
    }
  }
```

Verify `isEnabled` is already imported in this file (it usually is). If not, add:

```javascript
const { isEnabled } = require('@librechat/api');
```

- [ ] **Step 6.2.2: Run, expect pass**

Run: `npx jest api/server/socialLogins.spec.js`
Expected: all green.

### 6.3 Update `.env.example`

- [ ] **Step 6.3.1: Add the env var entry**

Open `.env.example`. Find the OPENID block (search for `OPENID_REUSE_TOKENS`). Append:

```
# When true, all LLM requests use the user's OIDC access_token as the API key
# (Bearer for OpenAI/custom, x-api-key for Anthropic, api-key for Azure).
# The upstream LLM gateway is expected to validate this JWT against the IdP's
# JWKS. Mutually exclusive with non-OIDC login providers — startup will fail
# if both are enabled. See docs/superpowers/specs/2026-06-13-oidc-llm-forwarding-design.md
OIDC_FORWARD_TO_LLM=false
```

### 6.4 Update `librechat.example.yaml`

- [ ] **Step 6.4.1: Add a note**

Open `librechat.example.yaml`. In the `endpoints.custom:` section, add a comment at the top of the section:

```yaml
  # When OIDC_FORWARD_TO_LLM=true, the `apiKey:` field on each custom endpoint
  # is IGNORED and replaced at request time with the user's OIDC access_token.
  # `baseURL:` must NOT be `user_provided` in this mode (the API throws at
  # request time to prevent token exfiltration to attacker-controlled hosts).
```

### 6.5 Commit C6

- [ ] **Step 6.5.1: Commit**

```bash
git add api/server/socialLogins.js api/server/socialLogins.spec.js .env.example librechat.example.yaml
git commit -m "feat(startup): reject non-OIDC providers when OIDC_FORWARD_TO_LLM=true + docs

Startup-time invariant: forwarding OIDC tokens to the LLM gateway is
incompatible with non-OIDC login methods (local, google, github, etc.)
because those users have no federated access_token to forward. Boot
fails loudly rather than silently degrading.

Adds OIDC_FORWARD_TO_LLM=false to .env.example (off by default in PR-2;
operators opt in per design doc §8 staged rollout).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full Verification

- [ ] **Step 7.1: Lint everything**

Run: `npm run lint`
Expected: all green.

- [ ] **Step 7.2: Run all tests**

Run: `npm run test`
Expected: all green.

- [ ] **Step 7.3: Verify acceptance checklist from design doc §10**

For each item in `docs/superpowers/specs/2026-06-13-oidc-llm-forwarding-design.md` §10, confirm:

- [ ] `npm run test` green
- [ ] `npm run lint` green
- [ ] `OIDC_FORWARD_TO_LLM=true` with a non-OIDC provider enabled → boot throws (covered by Task 6.1)
- [ ] `OIDC_FORWARD_TO_LLM=false` → fork's pre-PR-2 path active (covered by Task 4 fallback tests)
- [ ] Mock token TTL to 30s → second LLM call triggers refresh (covered by Task 1.4)
- [ ] 10 concurrent LLM requests → IdP refresh call count = 1 (covered by Task 1.7)
- [ ] grep production logs → no `access_token` / `refresh_token` literals (covered by Tasks 1.8, 3.6)
- [ ] User-provided baseURL endpoint + OIDC mode → throws (covered by Task 4.5)
- [ ] `openidStrategy.spec.js`: `updateUserKey` invocation count = 0 (covered by Task 5.1)
- [ ] Design doc committed (done in spec self-review)

Three items require real-deployment verification (deferred to staging soak):
- [ ] OIDC login → OpenAI chat → packet capture shows `Authorization: Bearer eyJ…`
- [ ] OIDC login → Anthropic chat → packet capture shows `x-api-key: eyJ…`
- [ ] OIDC login → Azure chat → packet capture shows `api-key: eyJ…`

Document the staging verification plan in the PR description.

---

## Task 8: Push and Open PR

- [ ] **Step 8.1: Push branch**

Run:
```bash
git push -u origin feat/oidc-llm-forwarding
```

- [ ] **Step 8.2: Open PR via gh CLI**

Run:
```bash
gh pr create \
  --title "feat: forward OIDC access_token to LLM gateway (replaces uid-\${openidId})" \
  --body "$(cat <<'EOF'
Implements the design in `docs/superpowers/specs/2026-06-13-oidc-llm-forwarding-design.md`.

Replaces the legacy synthetic `uid-${openidId}` API key with forwarding of the user's real OIDC `access_token` (signed JWT) as the credential for all LLM-bound requests. The upstream LLM gateway is expected to verify the JWT against the IdP's JWKS endpoint.

## What this PR does

- Adds `ensureLLMBearer` helper (pure, in `packages/api/src/auth/llmBearer.ts`) with 60s pre-refresh leeway and per-user concurrent-refresh dedup
- Adds `refreshOIDCAccessToken` bridge (in `api/server/services/Auth/`) that calls `openid-client.refreshTokenGrant` and reuses upstream `setOpenIDAuthTokens`
- Patches `setOpenIDAuthTokens` to tolerate `res === null` so it works from non-HTTP-response contexts
- Wires every LLM endpoint initializer (OpenAI, Anthropic, custom, Azure assistants) to override `apiKey` with the OIDC access_token when `OIDC_FORWARD_TO_LLM=true` and the user is OIDC
- Deletes the 5 legacy `updateUserKey('uid-...')` blocks from `openidStrategy.js`
- Adds a startup guard rejecting non-OIDC providers when `OIDC_FORWARD_TO_LLM=true`
- Documents the new env var and YAML semantics

## What this PR does NOT do

- Does NOT enable the flag by default — `OIDC_FORWARD_TO_LLM=false` ships, operators opt in
- Does NOT clean up legacy `uid-*` DB rows (out of scope; manual script later)
- Does NOT recover from streaming-mid-flight 401s (out of scope; rare per design analysis)

## Verification

- [x] All unit tests pass (`npm run test`)
- [x] Lint clean
- [x] Boot smoke test pending (requires staging with real OIDC IdP)

See acceptance checklist in spec §10.

## Rollout

See spec §8 for staged rollout. Default off; enable per-environment after gateway-side dual-mode is confirmed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Acceptance

PR-2 is ready to merge when:

- [ ] All commits squash-clean and revertable
- [ ] All tests green
- [ ] Lint clean
- [ ] PR description references the design doc
- [ ] At least one reviewer has verified the security-critical claims (baseURL guard, logger sanitization, refresh dedup)
- [ ] Staging deployment with `OIDC_FORWARD_TO_LLM=true` produces a successful OIDC login → chat round-trip with packet-captured proof of the JWT in the per-SDK header

## Post-Merge

After PR-2 is merged:

1. Deploy to staging with flag OFF — verify pre-PR-2 behavior preserved
2. Flip flag to ON in staging — soak 24h
3. Begin staged prod rollout per design doc §8 stages 4-7
4. After T+30d cutover, run optional `cleanup-uid-keys` maintenance script (not in this PR)
