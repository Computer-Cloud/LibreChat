# OIDC → LLM Forwarding — Provider Scope

When `OIDC_FORWARD_TO_LLM=true`, the user's OIDC `access_token` is forwarded
as the API key for the **chat-completion** endpoint families listed below.
Other endpoint families fall through to env-configured credentials by design;
see "Intentionally out of scope" below.

For the full design rationale, see the PR-2 design spec on the
`docs/oidc-llm-forwarding-design` branch:
`docs/superpowers/specs/2026-06-13-oidc-llm-forwarding-design.md`.

## In scope — forwards OIDC bearer

| Endpoint family | Initializer | Notes |
| --- | --- | --- |
| OpenAI | `packages/api/src/endpoints/openai/initialize.ts` | Azure branch overrides `clientOptions.azure.azureOpenAIApiKey` |
| Anthropic | `packages/api/src/endpoints/anthropic/initialize.ts` | Sets `credentials[AuthKeys.ANTHROPIC_API_KEY]` |
| Custom (OpenAI-compat) | `packages/api/src/endpoints/custom/initialize.ts` | Rejects `userProvidesURL` to prevent token exfiltration |
| Azure Assistants | `api/server/services/Endpoints/azureAssistants/initialize.js` | Overrides both SDK `apiKey` and the `api-key` header |
| OpenAI Assistants | `api/server/services/Endpoints/assistants/initalize.js` | Rejects `userProvidesURL` (mirrors custom) |

## Intentionally out of scope

### AWS Bedrock — `api/server/services/Endpoints/bedrock/*`

Bedrock authenticates with AWS Signature Version 4. The signing process binds
the credential to the request method, path, body hash, and timestamp; an
IdP-issued bearer token cannot be substituted for an AWS access key / secret
key pair. Operators who need OIDC-mediated access to Bedrock must front it
with a gateway that performs the SigV4 exchange server-side.

### Google Vertex / Gemini — `api/server/services/Endpoints/google/*`

Google authenticates with GCP service-account JSON keys or OAuth 2.0
service-account flows. Like SigV4, these are credential-format-specific and
do not accept arbitrary IdP bearer tokens. Same gateway-fronting workaround
applies.

## Why this is safe

The boot guard in `api/server/socialLogins.js::assertOIDCForwardingCompatible`
(called unconditionally from `api/server/index.js` and
`api/server/experimental.js`) rejects any deployment that combines
`OIDC_FORWARD_TO_LLM=true` with a non-OIDC login provider. OIDC-only
deployments would not realistically co-configure bedrock/google endpoints,
because their users have no AWS or GCP credentials to make the call useful.

If an operator does configure bedrock/google alongside OIDC, requests to
those endpoints continue to use the env-configured AWS / GCP credentials —
which is the current behavior pre-PR-2 (no silent breakage, no token
exfiltration risk).

The C9 review of PR-2 (#17) flagged this as a "missing throw" concern; the
documented decision is to **not** throw, because doing so would force a
breaking change on operators who legitimately use OIDC for chat completion
and bedrock for, e.g., embeddings or fallback inference.
