const { logger } = require('@librechat/data-schemas');
const openIdClient = require('openid-client');
const { buildOpenIDRefreshParams } = require('@librechat/api');

/**
 * Refreshes the user's OpenID access_token using the refresh_token stored
 * in express-session. Updates req.session.openidTokens (via setOpenIDAuthTokens)
 * and req.user.federatedTokens in place. Throws on any failure.
 *
 * The AuthService + openidStrategy dependencies are required lazily so server
 * controllers that import this module do not pull in the entire app graph at
 * module-load time (which broke jest controller tests that mock those deps).
 *
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
async function refreshOIDCAccessToken(req) {
  const refreshToken = req.session?.openidTokens?.refreshToken;
  if (!refreshToken) {
    throw new Error('No refresh_token available for OIDC refresh');
  }

  const { setOpenIDAuthTokens } = require('~/server/services/AuthService');
  const { getOpenIdConfig } = require('~/strategies/openidStrategy');

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
