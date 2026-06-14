import { EModelEndpoint, AuthKeys, ErrorTypes } from 'librechat-data-provider';
import type { BaseInitializeParams, InitializeResultBase, AnthropicConfigOptions } from '~/types';
import { loadAnthropicVertexCredentials, getVertexCredentialOptions } from './vertex';
import { ensureLLMBearer, isLLMOIDCForwardingEnabled } from '~/auth/llmBearer';
import { checkUserKeyExpiry, isEnabled } from '~/utils';
import { getLLMConfig } from './llm';

/**
 * Initializes Anthropic endpoint configuration.
 * Supports both direct API key authentication and Google Cloud Vertex AI.
 *
 * @param params - Configuration parameters
 * @returns Promise resolving to Anthropic configuration options
 * @throws Error if API key is not provided (when not using Vertex AI)
 */
export async function initializeAnthropic({
  req,
  endpoint,
  model_parameters,
  db,
  refreshOIDCAccessToken,
}: BaseInitializeParams): Promise<InitializeResultBase> {
  void endpoint;
  const appConfig = req.config;
  const { ANTHROPIC_API_KEY, ANTHROPIC_REVERSE_PROXY, PROXY } = process.env;
  const { key: expiresAt } = req.body;

  let credentials: Record<string, unknown> = {};
  let vertexOptions: { region?: string; projectId?: string } | undefined;

  /** @type {undefined | import('librechat-data-provider').TVertexAIConfig} */
  const vertexConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig;

  // Check for Vertex AI configuration: YAML config takes priority over env var
  // When vertexConfig exists and enabled is not explicitly false, Vertex AI is enabled
  const useVertexAI =
    (vertexConfig && vertexConfig.enabled !== false) || isEnabled(process.env.ANTHROPIC_USE_VERTEX);

  if (useVertexAI) {
    // Load credentials with optional YAML config overrides
    const credentialOptions = vertexConfig ? getVertexCredentialOptions(vertexConfig) : undefined;
    credentials = await loadAnthropicVertexCredentials(credentialOptions);

    // Store vertex options for client creation
    if (vertexConfig) {
      vertexOptions = {
        region: vertexConfig.region,
        projectId: vertexConfig.projectId,
      };
    }
  } else {
    const isUserProvided = ANTHROPIC_API_KEY === 'user_provided';

    const anthropicApiKey = isUserProvided
      ? await db.getUserKey({ userId: req.user?.id ?? '', name: EModelEndpoint.anthropic })
      : ANTHROPIC_API_KEY;

    if (!anthropicApiKey) {
      throw new Error('Anthropic API key not provided. Please provide it again.');
    }

    if (expiresAt && isUserProvided) {
      checkUserKeyExpiry(expiresAt, EModelEndpoint.anthropic);
    }

    credentials[AuthKeys.ANTHROPIC_API_KEY] = anthropicApiKey;
  }

  const clientOptions: AnthropicConfigOptions = {
    proxy: PROXY ?? undefined,
    reverseProxyUrl: ANTHROPIC_REVERSE_PROXY ?? undefined,
    modelOptions: {
      ...(model_parameters ?? {}),
      user: req.user?.id,
    },
    // Pass Vertex AI options if configured
    ...(vertexOptions && { vertexOptions }),
    // Pass full Vertex AI config including model mappings
    ...(vertexConfig && { vertexConfig }),
  };

  const anthropicConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic];
  const allConfig = appConfig?.endpoints?.all;

  // Fork-only: forward the user's OIDC access_token as the Anthropic API key.
  // SDK wire format: x-api-key header. When the flag is off or the user is not
  // OIDC, the original credential is preserved.
  if (isLLMOIDCForwardingEnabled() && req.user?.provider === 'openid' && refreshOIDCAccessToken) {
    if (useVertexAI) {
      throw new Error(
        JSON.stringify({ type: ErrorTypes.AUTH_FAILED }) +
          ' — Anthropic Vertex AI is incompatible with OIDC bearer forwarding',
      );
    }
    const { accessToken } = await ensureLLMBearer(req, { refreshOIDCAccessToken });
    credentials[AuthKeys.ANTHROPIC_API_KEY] = accessToken;
  }

  const result = getLLMConfig(credentials, clientOptions);

  let clientIp = '';
  if (req.headers?.['x-forwarded-for']) {
    clientIp = (req.headers['x-forwarded-for'] as string).split(',')[0].trim();
  }

  if (clientIp) {
    if (!result.llmConfig.clientOptions) {
      result.llmConfig.clientOptions = {};
    }
    if (!result.llmConfig.clientOptions.defaultHeaders) {
      result.llmConfig.clientOptions.defaultHeaders = {};
    }
    (result.llmConfig.clientOptions.defaultHeaders as Record<string, string>)['x-cs-client-ip'] =
      clientIp;
  }

  // Apply stream rate delay
  if (anthropicConfig?.streamRate) {
    (result.llmConfig as Record<string, unknown>)._lc_stream_delay = anthropicConfig.streamRate;
  }

  if (allConfig?.streamRate) {
    (result.llmConfig as Record<string, unknown>)._lc_stream_delay = allConfig.streamRate;
  }

  return result;
}
