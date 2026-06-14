const OpenAI = require('openai');
const { ProxyAgent } = require('undici');
const {
  isUserProvided,
  checkUserKeyExpiry,
  ensureLLMBearer,
  isLLMOIDCForwardingEnabled,
} = require('@librechat/api');
const { ErrorTypes, EModelEndpoint } = require('librechat-data-provider');
const { getUserKeyValues, getUserKeyExpiry } = require('~/models');
const { refreshOIDCAccessToken } = require('~/server/services/Auth/refreshOIDCToken');

const initializeClient = async ({ req, res, version }) => {
  const { PROXY, OPENAI_ORGANIZATION, ASSISTANTS_API_KEY, ASSISTANTS_BASE_URL } = process.env;

  const userProvidesKey = isUserProvided(ASSISTANTS_API_KEY);
  const userProvidesURL = isUserProvided(ASSISTANTS_BASE_URL);

  let userValues = null;
  if (userProvidesKey || userProvidesURL) {
    const expiresAt = await getUserKeyExpiry({
      userId: req.user.id,
      name: EModelEndpoint.assistants,
    });
    checkUserKeyExpiry(expiresAt, EModelEndpoint.assistants);
    userValues = await getUserKeyValues({ userId: req.user.id, name: EModelEndpoint.assistants });
  }

  let apiKey = userProvidesKey ? userValues.apiKey : ASSISTANTS_API_KEY;
  let baseURL = userProvidesURL ? userValues.baseURL : ASSISTANTS_BASE_URL;

  const opts = {
    defaultHeaders: {
      'OpenAI-Beta': `assistants=${version}`,
    },
  };

  if (userProvidesKey & !apiKey) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_USER_KEY,
      }),
    );
  }

  if (!apiKey) {
    throw new Error('Assistants API key not provided. Please provide it again.');
  }

  // Fork-only: forward the user's OIDC access_token as the OpenAI Assistants
  // API key. User-provided baseURL is rejected outright to prevent token
  // exfiltration to attacker-controlled hosts (mirrors custom/initialize.ts).
  if (isLLMOIDCForwardingEnabled() && req.user?.provider === 'openid') {
    if (userProvidesURL) {
      throw new Error(
        JSON.stringify({ type: ErrorTypes.AUTH_FAILED }) +
          ' — user-provided baseURL disallowed when forwarding OIDC bearer',
      );
    }
    const { accessToken } = await ensureLLMBearer(req, { refreshOIDCAccessToken });
    apiKey = accessToken;
  }

  if (baseURL) {
    opts.baseURL = baseURL;
  }

  if (PROXY) {
    const proxyAgent = new ProxyAgent(PROXY);
    opts.fetchOptions = {
      dispatcher: proxyAgent,
    };
  }

  if (OPENAI_ORGANIZATION) {
    opts.organization = OPENAI_ORGANIZATION;
  }

  /** @type {OpenAIClient} */
  const openai = new OpenAI({
    apiKey,
    ...opts,
  });

  openai.req = req;
  openai.res = res;

  return {
    openai,
    openAIApiKey: apiKey,
  };
};

module.exports = initializeClient;
