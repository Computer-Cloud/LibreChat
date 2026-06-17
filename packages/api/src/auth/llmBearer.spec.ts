import { ErrorTypes } from 'librechat-data-provider';
import { ensureLLMBearer, isLLMOIDCForwardingEnabled } from './llmBearer';

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

  it('returns access_token without refresh when expiry > leeway', async () => {
    const req = makeReq();
    const result = await ensureLLMBearer(req, deps);
    expect(result).toEqual({ accessToken: 'jwt-good', refreshed: false });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

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
      (
        r.user as { federatedTokens: { access_token: string; expires_at: number } }
      ).federatedTokens = {
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

  it('propagates refresh error to caller (translation to AUTH_FAILED happens at route layer)', async () => {
    const req = makeReq({
      federatedTokens: {
        access_token: 'jwt-stale',
        expires_at: Math.floor(Date.now() / 1000) + 10,
      },
    });
    mockRefresh.mockRejectedValue(new Error('invalid_grant'));
    await expect(ensureLLMBearer(req, deps)).rejects.toThrow(/invalid_grant/);
    await expect(ensureLLMBearer(req, deps)).rejects.not.toThrow(
      JSON.stringify({ type: ErrorTypes.AUTH_FAILED }),
    );
  });

  it('throws AUTH_FAILED when post-refresh token is still invalid', async () => {
    const req = makeReq({ federatedTokens: { access_token: '', expires_at: 0 } });
    mockRefresh.mockImplementation(async (r) => {
      (r.user as { federatedTokens: unknown }).federatedTokens = { access_token: '' };
    });
    await expect(ensureLLMBearer(req, deps)).rejects.toThrow(
      JSON.stringify({ type: ErrorTypes.AUTH_FAILED }),
    );
  });

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

  it('does NOT dedupe refresh calls across different users', async () => {
    const now = Math.floor(Date.now() / 1000);
    const reqA = makeReq({ provider: 'openid' });
    (reqA.user as { _id: string; id: string; federatedTokens: unknown })._id = 'user-a';
    (reqA.user as { _id: string; id: string; federatedTokens: unknown }).id = 'user-a';
    (reqA.user as { federatedTokens: unknown }).federatedTokens = {
      access_token: 'a-stale',
      expires_at: now + 10,
    };

    const reqB = makeReq({ provider: 'openid' });
    (reqB.user as { _id: string; id: string; federatedTokens: unknown })._id = 'user-b';
    (reqB.user as { _id: string; id: string; federatedTokens: unknown }).id = 'user-b';
    (reqB.user as { federatedTokens: unknown }).federatedTokens = {
      access_token: 'b-stale',
      expires_at: now + 10,
    };

    mockRefresh.mockImplementation(
      async (r: { user: { _id: string; federatedTokens: unknown } }) => {
        r.user.federatedTokens = {
          access_token: `${r.user._id}-fresh`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        };
      },
    );

    const [resultA, resultB] = await Promise.all([
      ensureLLMBearer(reqA, deps),
      ensureLLMBearer(reqB, deps),
    ]);

    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(resultA.accessToken).toBe('user-a-fresh');
    expect(resultB.accessToken).toBe('user-b-fresh');
    expect(resultA.accessToken).not.toBe(resultB.accessToken);
  });

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
    for (const method of ['debug', 'warn', 'error'] as const) {
      for (const call of (logger[method] as jest.Mock).mock.calls) {
        for (const arg of call) {
          expect(JSON.stringify(arg)).not.toContain(secret);
        }
      }
    }
  });
});

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
