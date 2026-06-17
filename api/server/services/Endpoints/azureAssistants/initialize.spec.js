const mockEnsureLLMBearer = jest.fn();
const mockIsLLMOIDCForwardingEnabled = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  ensureLLMBearer: (...args) => mockEnsureLLMBearer(...args),
  isLLMOIDCForwardingEnabled: (...args) => mockIsLLMOIDCForwardingEnabled(...args),
  isUserProvided: jest.fn(() => false),
  checkUserKeyExpiry: jest.fn(),
  resolveHeaders: jest.fn(({ headers }) => ({ ...headers })),
  constructAzureURL: jest.fn(({ baseURL }) => baseURL),
}));

jest.mock('~/models', () => ({
  getUserKeyValues: jest.fn(),
  getUserKeyExpiry: jest.fn(),
}));

jest.mock('~/server/services/Auth/refreshOIDCToken', () => ({
  refreshOIDCAccessToken: jest.fn(),
}));

const mockMapModelToAzureConfig = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  mapModelToAzureConfig: (...args) => mockMapModelToAzureConfig(...args),
}));

const mockOpenAICtor = jest.fn();
jest.mock('openai', () => {
  const Mock = function MockOpenAI(opts) {
    mockOpenAICtor(opts);
    this.beta = { assistants: {} };
    this.locals = {};
  };
  return Mock;
});

const initializeClient = require('./initialize');

const ORIGINAL_KEY = process.env.AZURE_ASSISTANTS_API_KEY;
const ORIGINAL_FLAG = process.env.OIDC_FORWARD_TO_LLM;

function makeReq({ provider = 'openid' } = {}) {
  return {
    user: { id: 'u-1', provider },
    body: {},
    query: {},
    config: { endpoints: {} },
  };
}

describe('azureAssistants initializeClient — OIDC apiKey override', () => {
  beforeEach(() => {
    process.env.AZURE_ASSISTANTS_API_KEY = 'env-azure-key';
    delete process.env.AZURE_ASSISTANTS_BASE_URL;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.AZURE_ASSISTANTS_API_KEY;
    else process.env.AZURE_ASSISTANTS_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_FLAG === undefined) delete process.env.OIDC_FORWARD_TO_LLM;
    else process.env.OIDC_FORWARD_TO_LLM = ORIGINAL_FLAG;
  });

  it('overrides apiKey when flag on + OIDC user (no pre-built api-key header)', async () => {
    mockIsLLMOIDCForwardingEnabled.mockReturnValue(true);
    mockEnsureLLMBearer.mockResolvedValue({ accessToken: 'oidc-jwt' });

    const result = await initializeClient({
      req: makeReq(),
      res: {},
      version: 2,
      endpointOption: {},
    });

    expect(mockEnsureLLMBearer).toHaveBeenCalledTimes(1);
    expect(result.openAIApiKey).toBe('oidc-jwt');
    expect(mockOpenAICtor).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'oidc-jwt' }));
  });

  it('overrides BOTH apiKey AND opts.defaultHeaders["api-key"] when azureConfig already populated the header', async () => {
    mockIsLLMOIDCForwardingEnabled.mockReturnValue(true);
    mockEnsureLLMBearer.mockResolvedValue({ accessToken: 'oidc-jwt' });
    mockMapModelToAzureConfig.mockReturnValue({
      azureOptions: {
        azureOpenAIApiKey: 'azure-static-key',
        azureOpenAIApiVersion: '2024-02-15',
        azureOpenAIApiDeploymentName: 'dep',
      },
      baseURL: 'https://acme.openai.azure.com/openai',
      headers: {},
      serverless: false,
    });

    const req = makeReq();
    req.config = {
      endpoints: {
        azureOpenAI: {
          assistants: true,
          modelGroupMap: { 'gpt-4': { group: 'g' } },
          groupMap: { g: {} },
          assistantModels: ['gpt-4'],
        },
      },
    };
    req.body.model = 'gpt-4';

    const result = await initializeClient({
      req,
      res: {},
      version: 2,
      endpointOption: {},
    });

    expect(result.openAIApiKey).toBe('oidc-jwt');
    const ctorArg = mockOpenAICtor.mock.calls[0][0];
    expect(ctorArg.apiKey).toBe('oidc-jwt');
    expect(ctorArg.defaultHeaders['api-key']).toBe('oidc-jwt');
    expect(ctorArg.defaultHeaders['api-key']).not.toBe('azure-static-key');
  });

  it('falls back to env apiKey when flag is off', async () => {
    mockIsLLMOIDCForwardingEnabled.mockReturnValue(false);

    const result = await initializeClient({
      req: makeReq(),
      res: {},
      version: 2,
      endpointOption: {},
    });

    expect(mockEnsureLLMBearer).not.toHaveBeenCalled();
    expect(result.openAIApiKey).toBe('env-azure-key');
  });

  it('falls back to env apiKey for non-OIDC user even when flag is on', async () => {
    mockIsLLMOIDCForwardingEnabled.mockReturnValue(true);

    const result = await initializeClient({
      req: makeReq({ provider: 'local' }),
      res: {},
      version: 2,
      endpointOption: {},
    });

    expect(mockEnsureLLMBearer).not.toHaveBeenCalled();
    expect(result.openAIApiKey).toBe('env-azure-key');
  });
});
