const passport = require('passport');
const session = require('express-session');
const { CacheKeys } = require('librechat-data-provider');
const { math, isEnabled, shouldUseSecureCookie } = require('@librechat/api');
const { logger, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  openIdJwtLogin,
  facebookLogin,
  facebookAdminLogin,
  discordLogin,
  discordAdminLogin,
  setupOpenId,
  googleLogin,
  googleAdminLogin,
  githubLogin,
  githubAdminLogin,
  appleLogin,
  appleAdminLogin,
  setupSaml,
} = require('~/strategies');
const { getLogStores } = require('~/cache');

const DEFAULT_OPENID_REUSE_MAX_SESSION_AGE_MS = 15 * 60 * 1000;

const getSessionExpiry = () => math(process.env.SESSION_EXPIRY, DEFAULT_SESSION_EXPIRY);

const getOpenIdSessionExpiry = () => {
  const sessionExpiry = getSessionExpiry();
  if (!isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    return sessionExpiry;
  }

  const reuseMaxSessionAge = math(
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS,
    DEFAULT_OPENID_REUSE_MAX_SESSION_AGE_MS,
  );
  return Math.max(sessionExpiry, reuseMaxSessionAge);
};

/**
 * Configures OpenID Connect for the application.
 * @param {Express.Application} app - The Express application instance.
 * @returns {Promise<void>}
 */
async function configureOpenId(app) {
  logger.info('Configuring OpenID Connect...');
  const sessionExpiry = getOpenIdSessionExpiry();
  const sessionOptions = {
    secret: process.env.OPENID_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: getLogStores(CacheKeys.OPENID_SESSION),
    cookie: {
      maxAge: sessionExpiry,
      secure: shouldUseSecureCookie(),
    },
  };
  app.use(session(sessionOptions));
  app.use(passport.session());

  const config = await setupOpenId();
  if (!config) {
    logger.error('OpenID Connect configuration failed - strategy not registered.');
    return;
  }

  if (isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    logger.info('OpenID token reuse is enabled.');
    passport.use('openidJwt', openIdJwtLogin(config));
  }
  logger.info('OpenID Connect configured successfully.');
}

/**
 *
 * @param {Express.Application} app
 */
const configureSocialLogins = async (app) => {
  logger.info('Configuring social logins...');

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(googleLogin());
    passport.use('googleAdmin', googleAdminLogin());
  }
  if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
    passport.use(facebookLogin());
    passport.use('facebookAdmin', facebookAdminLogin());
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(githubLogin());
    passport.use('githubAdmin', githubAdminLogin());
  }
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    passport.use(discordLogin());
    passport.use('discordAdmin', discordAdminLogin());
  }
  if (process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY_PATH) {
    passport.use(appleLogin());
    passport.use('appleAdmin', appleAdminLogin());
  }
  if (
    process.env.OPENID_CLIENT_ID &&
    (isEnabled(process.env.OPENID_USE_PKCE) || process.env.OPENID_CLIENT_SECRET?.trim()) &&
    process.env.OPENID_ISSUER &&
    process.env.OPENID_SCOPE &&
    process.env.OPENID_SESSION_SECRET
  ) {
    await configureOpenId(app);
  }
  if (
    process.env.SAML_ENTRY_POINT &&
    process.env.SAML_ISSUER &&
    process.env.SAML_CERT &&
    process.env.SAML_SESSION_SECRET
  ) {
    logger.info('Configuring SAML Connect...');
    const sessionExpiry = getSessionExpiry();
    const sessionOptions = {
      secret: process.env.SAML_SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      store: getLogStores(CacheKeys.SAML_SESSION),
      cookie: {
        maxAge: sessionExpiry,
        secure: shouldUseSecureCookie(),
      },
    };
    app.use(session(sessionOptions));
    app.use(passport.session());
    setupSaml();

    logger.info('SAML Connect configured.');
  }

  if (isEnabled(process.env.OIDC_FORWARD_TO_LLM)) {
    /**
     * Defense-in-depth invariant: forwarding the user's OIDC access_token to
     * the LLM gateway requires every authenticated user to actually possess
     * one. Any login strategy that produces a session without populating
     * federatedTokens would let those users reach the LLM call path and fail
     * at ensureLLMBearer with AUTH_FAILED — a confusing 500-equivalent rather
     * than a clean configuration error at boot.
     *
     * We mirror the EXACT env conditions each provider in this file (and
     * elsewhere) uses to register its strategy — NOT the ALLOW_*_LOGIN flags
     * which only control button visibility in routes/config.js. And we mirror
     * routes/config.js's default-on semantics for ALLOW_EMAIL_LOGIN.
     */
    const enabledNonOIDC = [];
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      enabledNonOIDC.push('google');
    }
    if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
      enabledNonOIDC.push('facebook');
    }
    if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
      enabledNonOIDC.push('github');
    }
    if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
      enabledNonOIDC.push('discord');
    }
    if (process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY_PATH) {
      enabledNonOIDC.push('apple');
    }
    if (
      process.env.SAML_ENTRY_POINT &&
      process.env.SAML_ISSUER &&
      process.env.SAML_CERT &&
      process.env.SAML_SESSION_SECRET
    ) {
      enabledNonOIDC.push('saml');
    }
    if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
      enabledNonOIDC.push('ldap');
    }
    const emailLoginEnabled =
      process.env.ALLOW_EMAIL_LOGIN === undefined || isEnabled(process.env.ALLOW_EMAIL_LOGIN);
    if (emailLoginEnabled) {
      enabledNonOIDC.push('local');
    }
    if (enabledNonOIDC.length > 0) {
      throw new Error(
        `OIDC_FORWARD_TO_LLM is enabled but non-OIDC providers are also enabled: ${enabledNonOIDC.join(', ')}. ` +
          'Disable them or unset OIDC_FORWARD_TO_LLM.',
      );
    }
  }
};

module.exports = configureSocialLogins;
