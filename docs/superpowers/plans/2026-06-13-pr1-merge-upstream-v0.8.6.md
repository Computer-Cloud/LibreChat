# PR-1: Merge Upstream LibreChat v0.8.6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `upstream/main` (danny-avila/LibreChat @ v0.8.6, 756 commits ahead) into the fork's `main`, preserving fork-only customizations and the legacy `uid-${openidId}` OIDC flow so production continues to function until PR-2 lands.

**Architecture:** Single merge commit (`git merge upstream/main`, no rebase). Handle conflicts file-by-file per the disposition table in the design doc. Drop UI key-locking tweaks (upstream UI rewritten extensively); keep gitlab-ci, custom endpoints, branding, real-ip middleware.

**Tech Stack:** git, npm, docker-compose, Jest, ESLint. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-13-oidc-llm-forwarding-design.md` §4

---

## File Structure

PR-1 makes **no original code edits**. Every changed file is either:
- Accepted from upstream as-is
- A merge of upstream + fork's prior content
- A re-application of the 5 legacy `updateUserKey` blocks into upstream's new openidStrategy

No new files. No new architecture decisions. This is pure integration work.

---

## Prerequisites

- [ ] **Step 0.1: Verify clean working tree**

Run: `git status`
Expected: `On branch main` and `nothing to commit, working tree clean`

If dirty, stash or commit first. Do not start a merge over uncommitted changes.

- [ ] **Step 0.2: Verify upstream remote configured**

Run: `git remote -v | grep upstream`
Expected output (or equivalent):
```
upstream	https://github.com/danny-avila/LibreChat (fetch)
upstream	https://github.com/danny-avila/LibreChat (push)
```

If missing, run:
```bash
git remote add upstream https://github.com/danny-avila/LibreChat
```

- [ ] **Step 0.3: Fetch upstream**

Run: `git fetch upstream`
Expected: completes without error, prints new refs.

- [ ] **Step 0.4: Verify merge base and commit count**

Run:
```bash
git merge-base main upstream/main
git log --oneline main..upstream/main | wc -l
```
Expected: merge-base resolves to a commit hash (e.g., `9eeec6bc4`); count is approximately 756.

- [ ] **Step 0.5: Create merge branch**

```bash
git checkout -b chore/merge-upstream-v0.8.6 main
```

Expected: `Switched to a new branch 'chore/merge-upstream-v0.8.6'`

---

## Task 1: Initiate Merge

**Files:** all (this is a repo-wide merge)

- [ ] **Step 1.1: Start the merge**

Run:
```bash
git merge upstream/main --no-commit --no-ff
```

Expected: conflicts reported. Do NOT let git auto-finalize — `--no-commit` keeps the merge open so we can resolve and verify before committing.

- [ ] **Step 1.2: Capture conflict list to a temp file**

Run:
```bash
git status | grep "both modified\|both added\|deleted by" > /tmp/merge-conflicts.txt
cat /tmp/merge-conflicts.txt
```

Expected: list of conflicted paths. Keep this file open for the next tasks.

---

## Task 2: Accept Upstream for OIDC / Auth Refactor Files

These files were heavily refactored upstream; the fork has no original edits to preserve.

**Files (accept upstream):**
- `api/strategies/openIdJwtStrategy.js`
- `api/server/services/AuthService.js`
- `packages/api/src/auth/openid.ts`
- `packages/api/src/utils/oidc.ts`
- `packages/api/src/endpoints/openai/initialize.ts`
- `packages/api/src/endpoints/custom/initialize.ts`

- [ ] **Step 2.1: Take upstream version for each file**

Run:
```bash
for f in \
  api/strategies/openIdJwtStrategy.js \
  api/server/services/AuthService.js \
  packages/api/src/auth/openid.ts \
  packages/api/src/utils/oidc.ts \
  packages/api/src/endpoints/openai/initialize.ts \
  packages/api/src/endpoints/custom/initialize.ts
do
  if grep -q "$f" /tmp/merge-conflicts.txt 2>/dev/null; then
    git checkout --theirs "$f" && git add "$f" && echo "accepted upstream: $f"
  else
    echo "no conflict: $f"
  fi
done
```

Expected: each file either reports "accepted upstream" or "no conflict". No errors.

---

## Task 3: Re-apply Legacy `uid-${openidId}` Blocks in openidStrategy.js

`api/strategies/openidStrategy.js` was rewritten upstream. The fork's 5 `updateUserKey` blocks must be ported to the new structure. **This is temporary** — PR-2 deletes these blocks entirely.

**Files:**
- Modify: `api/strategies/openidStrategy.js`

- [ ] **Step 3.1: Inspect both versions side-by-side**

Run:
```bash
git show HEAD:api/strategies/openidStrategy.js > /tmp/openid-fork.js
git show upstream/main:api/strategies/openidStrategy.js > /tmp/openid-upstream.js
grep -n "updateUserKey\|uid-" /tmp/openid-fork.js
```

Expected: 5 `updateUserKey({ ... 'uid-${user.openidId}' ... })` blocks visible in fork version, none in upstream.

- [ ] **Step 3.2: Take upstream version as base**

Run:
```bash
git checkout --theirs api/strategies/openidStrategy.js
```

- [ ] **Step 3.3: Locate the insertion point in the new file**

Open `api/strategies/openidStrategy.js` and search for the verify callback's success path. In the upstream version this is the `return { ...user, tokenset, federatedTokens: {...} }` block (around line 834 in upstream HEAD as observed in the spec).

The legacy `updateUserKey` blocks ran on `done(null, user)` in the old API; in the new API the verify function returns the user object instead. The insertion point is **immediately before the `return { ...user, tokenset, federatedTokens: {...} }`**.

- [ ] **Step 3.4: Re-add the 5 legacy blocks**

Add these imports at the top of the file (after the existing requires):

```javascript
const { updateUserKey } = require('~/models');
const { EModelEndpoint } = require('librechat-data-provider');
```

Immediately before the final `return { ...user, tokenset, federatedTokens: { ... } };`, insert:

```javascript
// Fork-only: auto-import synthetic api keys so the LLM gateway can identify
// the user via the `uid-${openidId}` prefix. PR-2 (OIDC access token
// forwarding) replaces this with real OIDC bearer forwarding and deletes
// these blocks entirely.
const FAR_FUTURE = '2038-01-19T03:14:07.000Z';
const syntheticKey = `uid-${user.openidId}`;
await updateUserKey({
  userId: user.id,
  name: EModelEndpoint.openAI,
  value: JSON.stringify({ apiKey: syntheticKey, baseURL: '' }),
  expiresAt: FAR_FUTURE,
});
await updateUserKey({
  userId: user.id,
  name: EModelEndpoint.anthropic,
  value: syntheticKey,
  expiresAt: FAR_FUTURE,
});
await updateUserKey({
  userId: user.id,
  name: EModelEndpoint.google,
  value: JSON.stringify({ GOOGLE_API_KEY: syntheticKey }),
  expiresAt: FAR_FUTURE,
});
await updateUserKey({
  userId: user.id,
  name: EModelEndpoint.assistants,
  value: JSON.stringify({ apiKey: syntheticKey, baseURL: '' }),
  expiresAt: FAR_FUTURE,
});
await updateUserKey({
  userId: user.id,
  name: EModelEndpoint.azureOpenAI,
  value: JSON.stringify({ apiKey: syntheticKey, baseURL: '' }),
  expiresAt: FAR_FUTURE,
});
```

If upstream's verify callback exposes the user object under a different variable name (e.g. `claims.sub` vs `user.openidId`), adjust `user.openidId` to match — read the surrounding upstream code to confirm the correct property.

- [ ] **Step 3.5: Stage the merged file**

```bash
git add api/strategies/openidStrategy.js
```

---

## Task 4: Handle .env.example and librechat.example.yaml Manual Merge

**Files:**
- Modify: `.env.example`
- Modify: `librechat.example.yaml`

- [ ] **Step 4.1: For .env.example, start from upstream**

```bash
git checkout --theirs .env.example
```

- [ ] **Step 4.2: Re-add fork's custom endpoint env vars**

Find the section near `OPENAI_API_KEY=user_provided` (or the custom endpoint section). Append the fork's additions for GROQ / xai / deepseek (look at HEAD's `.env.example` via `git show HEAD:.env.example | grep -E 'GROQ|XAI|DEEPSEEK|MOONSHOT'`).

For each fork-only line found, append to the matching section in the new `.env.example`. Use placeholder `<FILL_AT_DEPLOY>` for any secrets that were checked in by mistake.

- [ ] **Step 4.3: Stage .env.example**

```bash
git add .env.example
```

- [ ] **Step 4.4: For librechat.example.yaml, start from upstream**

```bash
git checkout --theirs librechat.example.yaml
```

- [ ] **Step 4.5: Re-add fork's custom endpoints**

Run:
```bash
git show HEAD:librechat.example.yaml | grep -A20 "name: 'deepseek'\|name: 'xai'\|name: 'groq'\|name: 'gemini'" > /tmp/fork-endpoints.yaml
```

Open `/tmp/fork-endpoints.yaml` and the new `librechat.example.yaml`. For each fork-only custom endpoint block not already present upstream, append to the `endpoints.custom:` list (preserving YAML indentation).

- [ ] **Step 4.6: Stage librechat.example.yaml**

```bash
git add librechat.example.yaml
```

---

## Task 5: Resolve Package Lock Conflicts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `bun.lock` (if present and conflicted)

- [ ] **Step 5.1: Accept upstream package.json**

```bash
git checkout --theirs package.json
git add package.json
```

- [ ] **Step 5.2: Regenerate lockfile from scratch**

```bash
rm -f package-lock.json
npm install
```

Expected: clean install, no peer-dep errors. May take several minutes.

- [ ] **Step 5.3: Stage regenerated lockfile**

```bash
git add package-lock.json
```

- [ ] **Step 5.4: Handle bun.lock if present**

```bash
if [ -f bun.lock ]; then
  git checkout --theirs bun.lock
  git add bun.lock
fi
```

---

## Task 6: Handle UI Conflicts — Drop Fork's Key-Locking Tweaks

The fork modified several client files to hide/disable API key UI controls. The upstream UI has been rewritten extensively across 756 commits; manual port is high effort and out of scope for PR-1.

- [ ] **Step 6.1: List all client/ conflicts**

Run:
```bash
git status | grep "both modified.*client/"
```

Expected: list of conflicting client files (none if upstream removed them; many if upstream rewrote them).

- [ ] **Step 6.2: For every client conflict, accept upstream**

Run:
```bash
for f in $(git status --porcelain | awk '/^UU.*client\//{print $2}'); do
  git checkout --theirs "$f" && git add "$f" && echo "accepted upstream: $f"
done
```

Expected: each file accepted.

Document in the merge commit message which fork-only UI behaviors were dropped (handled in Task 12).

---

## Task 7: Preserve Fork-Only Assets

**Files:**
- Modify (preserve): `client/public/assets/favicon*`, icons
- Modify (preserve): `.gitlab-ci.yml`

- [ ] **Step 7.1: For favicon / icon conflicts, accept fork (ours)**

Run:
```bash
for f in $(git status --porcelain | awk '/^UU.*\(favicon\|icon\|logo\)/{print $2}'); do
  git checkout --ours "$f" && git add "$f" && echo "preserved fork: $f"
done
```

If no conflicts reported, that's expected (favicons rarely change upstream).

- [ ] **Step 7.2: Verify .gitlab-ci.yml present**

Run:
```bash
ls .gitlab-ci.yml && git diff --staged --name-only | grep gitlab || echo ".gitlab-ci.yml unchanged"
```

Expected: file present. It's a fork-only file so should not have conflicted.

---

## Task 8: Handle Remaining Conflicts

- [ ] **Step 8.1: List any remaining conflicts**

Run: `git status | grep "both modified\|both added"`

- [ ] **Step 8.2: For each remaining conflict, decide and resolve**

For each file:
1. Run `git diff --diff-filter=U "$file"` to see both sides
2. Cross-reference the design doc §4.3 "Fork-Only Commit Disposition" table
3. Resolution rules:
   - If file is about `node-fetch`, `dalle3 plugin`, `insufficient balance error`: `git checkout --theirs "$file"` (let upstream win)
   - If file is about `real-ip` middleware (typically `api/server/index.js` or `app.js`): inspect; if upstream added `trust proxy`, accept upstream; else preserve fork
   - Anything else: read both diffs, decide manually
4. `git add "$file"`

- [ ] **Step 8.3: Verify no unresolved conflicts**

Run: `git status | grep "both modified\|both added"`
Expected: empty output.

---

## Task 9: Pre-Commit Verification

- [ ] **Step 9.1: Lint**

Run: `npm run lint`
Expected: passes. If failures are in upstream-only files, treat as upstream bugs and report — do NOT block on them. If failures are in re-applied legacy code (openidStrategy.js), fix.

- [ ] **Step 9.2: Run API tests**

Run: `npm run test:api`
Expected: all green. If specific tests fail due to upstream changes, investigate. The most likely failure is `api/strategies/openidStrategy.spec.js` (testing the new code paths) — those should pass since we accepted upstream.

- [ ] **Step 9.3: Run package tests**

Run: `npm run test --workspace=packages/api`
Expected: all green.

- [ ] **Step 9.4: Run client tests**

Run: `npm run test:client`
Expected: all green.

If any test fails, **do not commit**. Either fix the issue or rewind: `git merge --abort` and start over from Step 1.1.

---

## Task 10: Boot Smoke Test

- [ ] **Step 10.1: Start backing services**

Run:
```bash
docker compose up -d mongodb meilisearch
```

Expected: containers come up healthy. Wait ~10s for readiness.

- [ ] **Step 10.2: Start backend**

Run:
```bash
npm run backend:dev
```

Expected: server listens on configured port (default 3080), no fatal errors in console.

- [ ] **Step 10.3: Verify health endpoint**

In a second terminal:
```bash
curl -sf http://localhost:3080/api/health || echo "health endpoint failed"
```

Expected: 200 response (or whatever the new health endpoint shape is — adjust if upstream renamed it).

- [ ] **Step 10.4: Manual OIDC login smoke**

This step requires a working OIDC provider. If you have one configured (`.env` has `OPENID_*` vars set):

1. Open `http://localhost:3080` in browser
2. Click "Login with OpenID"
3. Complete provider login
4. Confirm redirect back to LibreChat with active session
5. Send one chat message
6. Confirm 200 response from LLM gateway (gateway must still accept `uid-${openidId}`)

If you do not have a configured OIDC provider, document this gap and proceed — staging deployment (rollout stage 2 in the design doc) will catch it.

- [ ] **Step 10.5: Stop services**

```bash
# Ctrl-C the backend
docker compose down
```

---

## Task 11: Final Verification Before Commit

- [ ] **Step 11.1: Verify no unintended file changes**

Run:
```bash
git status
git diff --staged --stat | tail -30
```

Expected: only files relevant to the merge appear. No stray editor files, no `.DS_Store`, no `node_modules/`.

- [ ] **Step 11.2: Verify fork-only files still present**

Run:
```bash
ls .gitlab-ci.yml && \
  grep -q "GROQ\|XAI\|DEEPSEEK" .env.example && \
  echo "fork-only artifacts preserved"
```

Expected: `fork-only artifacts preserved`.

- [ ] **Step 11.3: Verify legacy updateUserKey reapplied**

Run:
```bash
grep -c "updateUserKey" api/strategies/openidStrategy.js
```

Expected: at least 5 (the re-added blocks).

---

## Task 12: Commit the Merge

- [ ] **Step 12.1: Compose commit message**

The merge commit message must document what was dropped and what was preserved.

- [ ] **Step 12.2: Commit**

Run:
```bash
git commit -m "Merge upstream danny-avila/LibreChat @ v0.8.6

Preserved fork-only changes:
- gitlab-ci
- custom endpoints: gemini, xai, deepseek, groq
- branding: favicon, icons
- real-ip middleware

Temporarily preserved (to be removed in PR-2):
- openidStrategy: 5x updateUserKey('uid-...') auto-import

Dropped (UI divergence too high; may be reintroduced later):
- UI 'disable revoke / disable custom api key / remove set key button' tweaks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: merge commit created. `git log --oneline -1` shows the merge commit.

---

## Task 13: Push and Open PR

- [ ] **Step 13.1: Push branch**

Run:
```bash
git push -u origin chore/merge-upstream-v0.8.6
```

- [ ] **Step 13.2: Open PR via gh CLI**

Run:
```bash
gh pr create \
  --title "Merge upstream danny-avila/LibreChat @ v0.8.6 (756 commits)" \
  --body "$(cat <<'EOF'
Merges upstream LibreChat from current fork base (v0.8.3-rc1) up through v0.8.6.

## What this PR does

- Brings in 756 upstream commits including:
  - OpenID Connect federated token improvements (#9931, #11236, #11711, #11782, #11810, #13546)
  - User auth header forwarding on model fetch (#13616)
  - Remote Agent API auth (#5683706af)
  - Various OIDC refresh, audience, and session lifecycle fixes
- Preserves all fork-only customizations except UI key-locking tweaks (see commit message)
- Legacy \`uid-\${openidId}\` flow is intentionally retained so production continues to function until PR-2 (OIDC access token forwarding) lands.

## What this PR does NOT do

- Does not change runtime behavior for end users
- Does not migrate to OIDC access token forwarding (that is PR-2)
- Does not restore the dropped UI key-locking tweaks (deferred)

## Verification

- [x] \`npm run lint\` green
- [x] \`npm run test\` green
- [x] Boot smoke test: OIDC login + chat returns 200

## Rollout

See \`docs/superpowers/specs/2026-06-13-oidc-llm-forwarding-design.md\` §8 for the staged rollout plan.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Copy it for tracking.

---

## Acceptance

PR-1 is ready to merge when:

- [ ] All lint and tests pass
- [ ] Boot smoke test passes (OIDC login + chat returns 200 against gateway that still recognizes `uid-${openidId}`)
- [ ] PR description references the design doc
- [ ] Reviewer can trace every conflict resolution to the design doc disposition table
- [ ] No fork-only customization beyond the documented "Dropped" list has been lost (verify by running `git log --oneline upstream/main..HEAD --no-merges` against the disposition table)

## Post-Merge

After PR-1 is merged to fork's `main`:

1. Stage to staging environment
2. 3-day soak per design doc §8 stage 2
3. If clean, proceed to PR-2 plan (`docs/superpowers/plans/2026-06-13-pr2-oidc-llm-forwarding.md`)
4. If regressions found, fix on a new branch off `main` and merge before starting PR-2
