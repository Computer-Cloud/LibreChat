import { AuthType, EModelEndpoint } from 'librechat-data-provider';
import type { BaseInitializeParams } from '~/types';

const mockValidateEndpointURL = jest.fn();
jest.mock('~/auth', () => ({
  validateEndpointURL: (...args: unknown[]) => mockValidateEndpointURL(...args),
}));

const mockGetOpenAIConfig = jest.fn().mockReturnValue({
  llmConfig: { model: 'gpt-4' },
  configOptions: {},
});
jest.mock('./config', () => ({
  getOpenAIConfig: (...args: unknown[]) => mockGetOpenAIConfig(...args),
}));

jest.mock('~/utils', () => ({
  getAzureCredentials: jest.fn(),
  resolveHeaders: jest.fn(() => ({})),
  isUserProvided: (val: string) => val === 'user_provided',
  checkUserKeyExpiry: jest.fn(),
  isEnabled: (val: unknown) =>
    typeof val === 'string' && ['true', '1', 'yes', 'on'].includes(val.toLowerCase()),
}));

import { initializeOpenAI } from './initialize';

function createParams(env: Record<string, string | undefined>): BaseInitializeParams {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, env);

  const db = {
    getUserKeyValues: jest.fn().mockResolvedValue({
      apiKey: 'sk-user-key',
      baseURL: 'https://user-proxy.example.com/v1',
    }),
  } as unknown as BaseInitializeParams['db'];

  const params: BaseInitializeParams = {
    req: {
      user: { id: 'user-1' },
      body: { key: '2099-01-01' },
      config: { endpoints: {} },
    } as unknown as BaseInitializeParams['req'],
    endpoint: EModelEndpoint.openAI,
    model_parameters: { model: 'gpt-4' },
    db,
  };

  const restore = () => {
    for (const key of Object.keys(env)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  };

  return Object.assign(params, { _restore: restore });
}

describe('initializeOpenAI — OIDC apiKey override', () => {
  const ORIGINAL = process.env.OIDC_FORWARD_TO_LLM;
  const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OIDC_FORWARD_TO_LLM;
    else process.env.OIDC_FORWARD_TO_LLM = ORIGINAL;
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
    jest.clearAllMocks();
  });

  const futureExpiry = () => Math.floor(Date.now() / 1000) + 3600;

  it('replaces apiKey with OIDC access_token when flag on and user is OIDC', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.OPENAI_API_KEY = 'env-key';
    mockGetOpenAIConfig.mockReturnValue({ llmConfig: {} });
    await initializeOpenAI({
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
      endpoint: EModelEndpoint.openAI,
      model_parameters: { model: 'gpt-4' },
      db: { getUserKeyValues: jest.fn() } as unknown as BaseInitializeParams['db'],
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'oidc-jwt',
      expect.any(Object),
      EModelEndpoint.openAI,
    );
  });

  it('falls back to env apiKey when flag off', async () => {
    delete process.env.OIDC_FORWARD_TO_LLM;
    process.env.OPENAI_API_KEY = 'env-key';
    mockGetOpenAIConfig.mockReturnValue({ llmConfig: {} });
    await initializeOpenAI({
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
      endpoint: EModelEndpoint.openAI,
      model_parameters: { model: 'gpt-4' },
      db: { getUserKeyValues: jest.fn() } as unknown as BaseInitializeParams['db'],
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'env-key',
      expect.any(Object),
      EModelEndpoint.openAI,
    );
  });

  it('falls back to env apiKey when flag on but user is not OIDC', async () => {
    process.env.OIDC_FORWARD_TO_LLM = 'true';
    process.env.OPENAI_API_KEY = 'env-key';
    mockGetOpenAIConfig.mockReturnValue({ llmConfig: {} });
    await initializeOpenAI({
      req: {
        user: { _id: 'u1', id: 'u1', provider: 'local' },
        body: {},
        config: { endpoints: {} },
      } as unknown as BaseInitializeParams['req'],
      endpoint: EModelEndpoint.openAI,
      model_parameters: { model: 'gpt-4' },
      db: { getUserKeyValues: jest.fn() } as unknown as BaseInitializeParams['db'],
      refreshOIDCAccessToken: jest.fn(),
    });
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'env-key',
      expect.any(Object),
      EModelEndpoint.openAI,
    );
  });
});

describe('initializeOpenAI – SSRF guard wiring', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should call validateEndpointURL when OPENAI_REVERSE_PROXY is user_provided', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED,
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).toHaveBeenCalledTimes(1);
    expect(mockValidateEndpointURL).toHaveBeenCalledWith(
      'https://user-proxy.example.com/v1',
      EModelEndpoint.openAI,
      undefined,
    );
  });

  it('should NOT call validateEndpointURL when OPENAI_REVERSE_PROXY is a system URL', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: 'https://api.openai.com/v1',
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('should NOT call validateEndpointURL when baseURL is falsy', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('should propagate SSRF rejection from validateEndpointURL', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(
      new Error('Base URL for openAI targets a restricted address.'),
    );

    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED,
    });

    try {
      await expect(initializeOpenAI(params)).rejects.toThrow('targets a restricted address');
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
  });
});
