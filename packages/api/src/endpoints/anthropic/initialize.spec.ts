import { AuthKeys } from 'librechat-data-provider';
import type { BaseInitializeParams } from '~/types';

const mockGetLLMConfig = jest.fn().mockReturnValue({ llmConfig: { model: 'claude-3' } });
jest.mock('./llm', () => ({
  getLLMConfig: (...args: unknown[]) => mockGetLLMConfig(...args),
}));

jest.mock('./vertex', () => ({
  loadAnthropicVertexCredentials: jest.fn(async () => ({})),
  getVertexCredentialOptions: jest.fn(() => ({})),
}));

jest.mock('~/utils', () => ({
  checkUserKeyExpiry: jest.fn(),
  isEnabled: (val: unknown) =>
    typeof val === 'string' && ['true', '1', 'yes', 'on'].includes(val.toLowerCase()),
}));

import { initializeAnthropic } from './initialize';

const futureExpiry = () => Math.floor(Date.now() / 1000) + 3600;

describe('initializeAnthropic — OIDC apiKey override', () => {
  const ORIGINAL = process.env.OIDC_FORWARD_TO_LLM;
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
  const ORIGINAL_VERTEX = process.env.ANTHROPIC_USE_VERTEX;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OIDC_FORWARD_TO_LLM;
    else process.env.OIDC_FORWARD_TO_LLM = ORIGINAL;
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_VERTEX === undefined) delete process.env.ANTHROPIC_USE_VERTEX;
    else process.env.ANTHROPIC_USE_VERTEX = ORIGINAL_VERTEX;
    jest.clearAllMocks();
    mockGetLLMConfig.mockReturnValue({ llmConfig: { model: 'claude-3' } });
  });

  it('replaces ANTHROPIC_API_KEY credential with OIDC access_token when flag on', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.ANTHROPIC_API_KEY = 'env-key';
    await initializeAnthropic({
      req: {
        user: {
          _id: 'u1',
          id: 'u1',
          provider: 'openid',
          federatedTokens: {
            access_token: 'oidc-jwt',
            id_token: 'oidc-id',
            refresh_token: 'oidc-r',
            expires_at: futureExpiry(),
          },
        },
        body: {},
        config: { endpoints: {} },
      } as unknown as BaseInitializeParams['req'],
      endpoint: 'anthropic',
      model_parameters: {},
      db: { getUserKey: jest.fn() } as unknown as BaseInitializeParams['db'],
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({ [AuthKeys.ANTHROPIC_API_KEY]: 'oidc-jwt' }),
      expect.any(Object),
    );
  });

  it('falls back to env credential when flag off', async () => {
    delete process.env.OIDC_FORWARD_TO_LLM;
    process.env.ANTHROPIC_API_KEY = 'env-key';
    await initializeAnthropic({
      req: {
        user: {
          _id: 'u1',
          id: 'u1',
          provider: 'openid',
          federatedTokens: { access_token: 'oidc-jwt', expires_at: futureExpiry() },
        },
        body: {},
        config: { endpoints: {} },
      } as unknown as BaseInitializeParams['req'],
      endpoint: 'anthropic',
      model_parameters: {},
      db: { getUserKey: jest.fn() } as unknown as BaseInitializeParams['db'],
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({ [AuthKeys.ANTHROPIC_API_KEY]: 'env-key' }),
      expect.any(Object),
    );
  });

  it('throws AUTH_FAILED when OIDC forwarding combined with Anthropic Vertex AI', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.ANTHROPIC_USE_VERTEX = 'true';
    await expect(
      initializeAnthropic({
        req: {
          user: {
            _id: 'u1',
            id: 'u1',
            provider: 'openid',
            federatedTokens: {
              access_token: 'oidc-jwt',
              expires_at: futureExpiry(),
            },
          },
          body: {},
          config: { endpoints: {} },
        } as unknown as BaseInitializeParams['req'],
        endpoint: 'anthropic',
        model_parameters: {},
        db: { getUserKey: jest.fn() } as unknown as BaseInitializeParams['db'],
        refreshOIDCAccessToken: jest.fn(),
      }),
    ).rejects.toThrow(/Vertex AI is incompatible/);
  });

  it('throws when flag on + OIDC user but refreshOIDCAccessToken DI is missing', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.ANTHROPIC_API_KEY = 'env-key';
    await expect(
      initializeAnthropic({
        req: {
          user: {
            _id: 'u1',
            id: 'u1',
            provider: 'openid',
            federatedTokens: { access_token: 'oidc-jwt', expires_at: futureExpiry() },
          },
          body: {},
          config: { endpoints: {} },
        } as unknown as BaseInitializeParams['req'],
        endpoint: 'anthropic',
        model_parameters: {},
        db: { getUserKey: jest.fn() } as unknown as BaseInitializeParams['db'],
      }),
    ).rejects.toThrow(/OIDC forwarding misconfigured: refreshOIDCAccessToken not injected/);
    expect(mockGetLLMConfig).not.toHaveBeenCalled();
  });

  it('falls back to env credential when flag on but user is not OIDC', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.ANTHROPIC_API_KEY = 'env-key';
    await initializeAnthropic({
      req: {
        user: { _id: 'u1', id: 'u1', provider: 'local' },
        body: {},
        config: { endpoints: {} },
      } as unknown as BaseInitializeParams['req'],
      endpoint: 'anthropic',
      model_parameters: {},
      db: { getUserKey: jest.fn() } as unknown as BaseInitializeParams['db'],
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(mockGetLLMConfig).toHaveBeenCalledWith(
      expect.objectContaining({ [AuthKeys.ANTHROPIC_API_KEY]: 'env-key' }),
      expect.any(Object),
    );
  });
});
