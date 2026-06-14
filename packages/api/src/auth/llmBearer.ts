import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { Request } from 'express';
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

/**
 * Returns the user's OIDC access_token for forwarding to the upstream LLM gateway,
 * refreshing first if the token expires within REFRESH_LEEWAY_SECONDS.
 *
 * @throws {Error} with JSON-encoded { type: AUTH_FAILED } if user is not OIDC or
 *   token is invalid after refresh. Refresh errors from the IdP (`invalid_grant`,
 *   network failures, etc.) are NOT caught here — they propagate to the caller,
 *   which is expected to translate them at the route layer.
 *
 * @sideEffect The injected `refreshOIDCAccessToken` mutates `req.user.federatedTokens`
 *   and `req.session.openidTokens` in place when invoked.
 *
 * @concurrency Multiple concurrent calls for the same user share a single in-flight
 *   refresh via the `inflightRefresh` map, scoped to this process.
 */
export async function ensureLLMBearer(req: Request, deps: EnsureLLMBearerDeps): Promise<LLMBearer> {
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
    // Refresh errors propagate as-is; the route layer is responsible for
    // translating IdP errors into AUTH_FAILED responses to the client.
    await dedupedRefresh(req, deps);
    tokenInfo = extractOpenIDTokenInfo(req.user as IUser);
    refreshed = true;
  }

  if (!isOpenIDTokenValid(tokenInfo) || !tokenInfo?.accessToken) {
    throw new Error(JSON.stringify({ type: ErrorTypes.AUTH_FAILED }));
  }

  return { accessToken: tokenInfo.accessToken, refreshed };
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
