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

  it('propagates grant errors and logs without leaking secrets', async () => {
    const { logger } = jest.requireMock('@librechat/data-schemas');
    openIdClient.refreshTokenGrant.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), {
        response: { data: { access_token: 'secret' } },
      }),
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

  it('writes IdP expires_at (seconds) to req.user but cookie-expiry (ms) to session — asymmetry is intentional', async () => {
    const idpExpiresAt = Math.floor(Date.now() / 1000) + 3600;
    openIdClient.refreshTokenGrant.mockResolvedValue({
      access_token: 'new-at',
      id_token: 'new-it',
      refresh_token: 'new-rt',
      expires_at: idpExpiresAt,
    });

    setOpenIDAuthTokens.mockImplementation((tokenset, req) => {
      const expiryMs = Date.now() + 15 * 60 * 1000;
      req.session.openidTokens = {
        accessToken: tokenset.access_token,
        idToken: tokenset.id_token,
        refreshToken: tokenset.refresh_token,
        expiresAt: expiryMs,
      };
    });

    const req = {
      session: { openidTokens: { refreshToken: 'old-rt' } },
      user: { id: 'u1' },
    };
    await refreshOIDCAccessToken(req);

    expect(req.user.federatedTokens.expires_at).toBe(idpExpiresAt);

    expect(req.session.openidTokens.expiresAt).not.toBe(idpExpiresAt);
    expect(req.session.openidTokens.expiresAt).toBeGreaterThan(Date.now());

    expect(typeof req.user.federatedTokens.expires_at).toBe('number');
    expect(typeof req.session.openidTokens.expiresAt).toBe('number');
    expect(req.user.federatedTokens.expires_at).toBeLessThan(req.session.openidTokens.expiresAt);
  });

  it('logs structured error context (code, status, error_description, etc.) without leaking secrets', async () => {
    const { logger } = jest.requireMock('@librechat/data-schemas');
    const richError = Object.assign(new Error('invalid_grant'), {
      name: 'OAuth2Error',
      code: 'OAUTH_INVALID_GRANT',
      error: 'invalid_grant',
      error_description: 'Refresh token expired',
      cause: new Error('upstream timeout'),
      response: {
        status: 400,
        data: { access_token: 'secret-leaked-token' },
      },
    });
    openIdClient.refreshTokenGrant.mockRejectedValue(richError);
    const req = {
      session: { openidTokens: { refreshToken: 'old-rt' } },
      user: { id: 'u1' },
    };
    await expect(refreshOIDCAccessToken(req)).rejects.toThrow('invalid_grant');

    expect(logger.error).toHaveBeenCalledWith(
      '[refreshOIDCAccessToken] grant failed',
      expect.objectContaining({
        name: 'OAuth2Error',
        code: 'OAUTH_INVALID_GRANT',
        status: 400,
        errorCode: 'invalid_grant',
        errorDescription: 'Refresh token expired',
        message: 'invalid_grant',
      }),
    );

    for (const call of logger.error.mock.calls) {
      for (const arg of call) {
        expect(JSON.stringify(arg)).not.toContain('secret-leaked-token');
      }
    }
  });
});
