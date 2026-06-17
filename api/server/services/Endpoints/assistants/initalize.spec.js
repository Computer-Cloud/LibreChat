const mockEnsureLLMBearer = jest.fn();
const mockIsLLMOIDCForwardingEnabled = jest.fn();
const mockIsUserProvided = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  ensureLLMBearer: (...args) => mockEnsureLLMBearer(...args),
  isLLMOIDCForwardingEnabled: (...args) => mockIsLLMOIDCForwardingEnabled(...args),
  isUserProvided: (...args) => mockIsUserProvided(...args),
  checkUserKeyExpiry: jest.fn(),
}));

jest.mock('~/models', () => ({
  getUserKeyValues: jest.fn().mockResolvedValue({
    apiKey: 'user-key',
    baseURL: 'https://user-controlled.example.com/v1',
  }),
  getUserKeyExpiry: jest.fn().mockResolvedValue(null),
}));

jest.mock('~/server/services/Auth/refreshOIDCToken', () => ({
  refreshOIDCAccessToken: jest.fn(),
}));

const mockOpenAICtor = jest.fn();
jest.mock('openai', () => {
  return function MockOpenAI(opts) {
    mockOpenAICtor(opts);
  };
});

const initializeClient = require('./initalize');
const { ErrorTypes } = require('librechat-data-provider');

const ORIGINAL_KEY = process.env.ASSISTANTS_API_KEY;
const ORIGINAL_URL = process.env.ASSISTANTS_BASE_URL;
const ORIGINAL_FLAG = process.env.OIDC_FORWARD_TO_LLM;

function makeReq({ provider = 'openid' } = {}) {
  return {
    user: { id: 'u-1', provider },
    body: {},
  };
}

describe('assistants initializeClient — OIDC apiKey override', () => {
  beforeEach(() => {
    process.env.ASSISTANTS_API_KEY = 'env-assistants-key';
    process.env.ASSISTANTS_BASE_URL = 'https://api.openai.com/v1';
    jest.clearAllMocks();
    mockIsUserProvided.mockReturnValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ASSISTANTS_API_KEY;
    else process.env.ASSISTANTS_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_URL === undefined) delete process.env.ASSISTANTS_BASE_URL;
    else process.env.ASSISTANTS_BASE_URL = ORIGINAL_URL;
    if (ORIGINAL_FLAG === undefined) delete process.env.OIDC_FORWARD_TO_LLM;
    else process.env.OIDC_FORWARD_TO_LLM = ORIGINAL_FLAG;
  });

  it('overrides apiKey with OIDC access_token when flag on + OIDC user + admin baseURL', async () => {
    mockIsLLMOIDCForwardingEnabled.mockReturnValue(true);
    mockEnsureLLMBearer.mockResolvedValue({ accessToken: 'oidc-jwt' });

    const result = await initializeClient({ req: makeReq(), res: {}, version: 2 });

    expect(mockEnsureLLMBearer).toHaveBeenCalledTimes(1);
    expect(result.openAIApiKey).toBe('oidc-jwt');
    expect(mockOpenAICtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'oidc-jwt' }));
  });

  it('throws AUTH_FAILED when userProvidesURL + flag on + OIDC user (security guard)', async () => {
    mockIsLLMOIDCForwardingEnabled.mockReturnValue(true);
    mockEnsureLLMBearer.mockResolvedValue({ accessToken: 'oidc-jwt' });
    // ASSISTANTS_BASE_URL is "user_provided"
    mockIsUserProvided.mockImplementation((val) => val === 'user_provided');
    process.env.ASSISTANTS_BASE_URL = 'user_provided';

    await expect(initializeClient({ req: makeReq(), res: {}, version: 2 })).rejects.toThrow(
      /user-provided baseURL disallowed/,
    );
    // The thrown payload also contains the AUTH_FAILED type
    try {
      await initializeClient({ req: makeReq(), res: {}, version: 2 });
    } catch (err) {
      expect(err.message).toContain(ErrorTypes.AUTH_FAILED);
    }
    expect(mockOpenAICtor).not.toHaveBeenCalled();
    expect(mockEnsureLLMBearer).not.toHaveBeenCalled();
  });

  it('falls back to env apiKey when flag is off (even for OIDC user)', async () => {
    mockIsLLMOIDCForwardingEnabled.mockReturnValue(false);

    const result = await initializeClient({ req: makeReq(), res: {}, version: 2 });

    expect(mockEnsureLLMBearer).not.toHaveBeenCalled();
    expect(result.openAIApiKey).toBe('env-assistants-key');
    expect(mockOpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'env-assistants-key' }),
    );
  });

  it('falls back to env apiKey for non-OIDC user even when flag is on', async () => {
    mockIsLLMOIDCForwardingEnabled.mockReturnValue(true);

    const result = await initializeClient({
      req: makeReq({ provider: 'local' }),
      res: {},
      version: 2,
    });

    expect(mockEnsureLLMBearer).not.toHaveBeenCalled();
    expect(result.openAIApiKey).toBe('env-assistants-key');
  });
});
