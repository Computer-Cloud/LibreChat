const mockSessionMiddleware = jest.fn((req, res, next) => next());
const mockPassportSessionMiddleware = jest.fn((req, res, next) => next());
const mockSession = jest.fn(() => mockSessionMiddleware);
const mockPassportUse = jest.fn();
const mockPassportSession = jest.fn(() => mockPassportSessionMiddleware);
const mockGetLogStores = jest.fn(() => 'openid-session-store');
const mockOpenIdJwtLogin = jest.fn(() => 'openid-jwt-strategy');
const mockSetupOpenId = jest.fn();
const mockSetupSaml = jest.fn();
const mockIsEnabled = jest.fn();
const mockShouldUseSecureCookie = jest.fn(() => true);
const mockMath = jest.fn((value, fallback) => {
  if (value == null || value === '') {
    return fallback;
  }
  if (typeof value === 'number') {
    return value;
  }
  return value
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((result, part) => result * part, 1);
});

jest.mock(
  'express-session',
  () =>
    (...args) =>
      mockSession(...args),
);
jest.mock('passport', () => ({
  use: (...args) => mockPassportUse(...args),
  session: (...args) => mockPassportSession(...args),
}));
jest.mock('librechat-data-provider', () => ({
  CacheKeys: {
    OPENID_SESSION: 'openid-session',
    SAML_SESSION: 'saml-session',
  },
}));
jest.mock('@librechat/api', () => ({
  math: (...args) => mockMath(...args),
  isEnabled: (...args) => mockIsEnabled(...args),
  shouldUseSecureCookie: (...args) => mockShouldUseSecureCookie(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  DEFAULT_SESSION_EXPIRY: 900000,
  logger: { error: jest.fn(), info: jest.fn() },
}));
jest.mock('~/cache', () => ({ getLogStores: (...args) => mockGetLogStores(...args) }));
jest.mock('~/strategies', () => ({
  openIdJwtLogin: (...args) => mockOpenIdJwtLogin(...args),
  facebookLogin: jest.fn(),
  facebookAdminLogin: jest.fn(),
  discordLogin: jest.fn(),
  discordAdminLogin: jest.fn(),
  setupOpenId: (...args) => mockSetupOpenId(...args),
  googleLogin: jest.fn(),
  googleAdminLogin: jest.fn(),
  githubLogin: jest.fn(),
  githubAdminLogin: jest.fn(),
  appleLogin: jest.fn(),
  appleAdminLogin: jest.fn(),
  setupSaml: (...args) => mockSetupSaml(...args),
}));

const configureSocialLogins = require('./socialLogins');

describe('configureSocialLogins OpenID session expiry', () => {
  const ORIGINAL_ENV = process.env;

  const setupOpenIdEnv = () => {
    process.env.OPENID_CLIENT_ID = 'client-id';
    process.env.OPENID_CLIENT_SECRET = 'client-secret';
    process.env.OPENID_ISSUER = 'https://issuer.example.com';
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_SESSION_SECRET = 'openid-session-secret';
    process.env.OPENID_USE_PKCE = 'false';
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {};
    setupOpenIdEnv();
    mockSetupOpenId.mockResolvedValue({ issuer: 'https://issuer.example.com' });
    mockIsEnabled.mockImplementation((value) => value === 'true');
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('extends the OpenID session cookie to the reuse window when token reuse is enabled', async () => {
    process.env.SESSION_EXPIRY = '1000 * 60 * 15';
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS = '1000 * 60 * 60';
    const app = { use: jest.fn() };

    await configureSocialLogins(app);

    expect(mockSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: {
          maxAge: 3600000,
          secure: true,
        },
      }),
    );
    expect(mockOpenIdJwtLogin).toHaveBeenCalledWith({ issuer: 'https://issuer.example.com' });
    expect(mockPassportUse).toHaveBeenCalledWith('openidJwt', 'openid-jwt-strategy');
  });

  it('keeps a longer SESSION_EXPIRY when the reuse window is shorter', async () => {
    process.env.SESSION_EXPIRY = '1000 * 60 * 60 * 2';
    process.env.OPENID_REUSE_TOKENS = 'true';
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS = '1000 * 60 * 60';
    const app = { use: jest.fn() };

    await configureSocialLogins(app);

    expect(mockSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: expect.objectContaining({ maxAge: 7200000 }),
      }),
    );
  });

  it('uses SESSION_EXPIRY when OpenID token reuse is disabled', async () => {
    process.env.SESSION_EXPIRY = '1000 * 60 * 15';
    process.env.OPENID_REUSE_TOKENS = '';
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS = '1000 * 60 * 60';
    const app = { use: jest.fn() };

    await configureSocialLogins(app);

    expect(mockSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: expect.objectContaining({ maxAge: 900000 }),
      }),
    );
    expect(mockPassportUse).not.toHaveBeenCalled();
  });
});

describe('configureSocialLogins — OIDC_FORWARD_TO_LLM guard', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {};
    mockSetupOpenId.mockResolvedValue({ issuer: 'https://issuer.example.com' });
    mockIsEnabled.mockImplementation((value) => value === 'true');
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('throws when OIDC_FORWARD_TO_LLM=true and GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'x';
    process.env.ALLOW_EMAIL_LOGIN = 'false';
    const app = { use: jest.fn() };
    await expect(configureSocialLogins(app)).rejects.toThrow(/OIDC_FORWARD_TO_LLM.*google/i);
  });

  it('succeeds when only OIDC is enabled', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.FACEBOOK_CLIENT_ID;
    delete process.env.FACEBOOK_CLIENT_SECRET;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_PRIVATE_KEY_PATH;
    delete process.env.SAML_ENTRY_POINT;
    delete process.env.SAML_ISSUER;
    delete process.env.SAML_CERT;
    delete process.env.SAML_SESSION_SECRET;
    delete process.env.LDAP_URL;
    delete process.env.LDAP_USER_SEARCH_BASE;
    process.env.ALLOW_EMAIL_LOGIN = 'false';
    process.env.OPENID_CLIENT_ID = 'x';
    process.env.OPENID_CLIENT_SECRET = 'x';
    process.env.OPENID_ISSUER = 'https://issuer.example.com';
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_SESSION_SECRET = 'openid-session-secret';
    const app = { use: jest.fn() };
    await expect(configureSocialLogins(app)).resolves.not.toThrow();
  });

  it('does not validate when flag off', async () => {
    delete process.env.OIDC_FORWARD_TO_LLM;
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'x';
    const app = { use: jest.fn() };
    await expect(configureSocialLogins(app)).resolves.not.toThrow();
  });

  it('throws when OIDC_FORWARD_TO_LLM=true and ALLOW_EMAIL_LOGIN is unset (default-on)', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    delete process.env.ALLOW_EMAIL_LOGIN;
    // ensure all other providers are off
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.FACEBOOK_CLIENT_ID;
    delete process.env.FACEBOOK_CLIENT_SECRET;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_PRIVATE_KEY_PATH;
    delete process.env.SAML_ENTRY_POINT;
    delete process.env.LDAP_URL;
    process.env.OPENID_CLIENT_ID = 'x';
    process.env.OPENID_CLIENT_SECRET = 'x';
    process.env.OPENID_ISSUER = 'https://issuer.example.com';
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_SESSION_SECRET = 'openid-session-secret';
    const app = { use: jest.fn() };
    await expect(configureSocialLogins(app)).rejects.toThrow(/OIDC_FORWARD_TO_LLM.*local/i);
  });

  it('throws when OIDC_FORWARD_TO_LLM=true and ALLOW_GOOGLE_LOGIN is unset but GOOGLE_CLIENT_ID is set', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    delete process.env.ALLOW_GOOGLE_LOGIN;
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'x';
    process.env.ALLOW_EMAIL_LOGIN = 'false'; // suppress default-on
    const app = { use: jest.fn() };
    await expect(configureSocialLogins(app)).rejects.toThrow(/OIDC_FORWARD_TO_LLM.*google/i);
  });
});
