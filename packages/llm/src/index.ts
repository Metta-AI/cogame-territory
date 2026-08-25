// @cogweb/llm — the LLM autopilot driver and the inter-player messaging bus.
// `LlmPilot` implements the core `Pilot` seam; `robustDecide` is the shared
// retry-then-fallback backbone for both action decisions and message generation;
// `MessageBus` is the visibility-aware negotiation substrate.

export {
  BedrockLlmClient,
  bedrockConfigFromEnv,
  bedrockRequestMetadataFromEnv,
  bedrockUsageTotals,
  resetBedrockUsage,
  isCredentialsUnavailable,
  type BedrockConfig,
  type BedrockSend,
  type BedrockUsageTotals,
  type ConverseMessage,
  type ConverseResult,
  type ConverseUsage,
  type ToolSpec,
} from "./bedrock.js";

export { discoverModels, MODEL_CANDIDATES, type ModelProbe } from "./model-discovery.js";

export {
  parseClaudeModel,
  orderCandidates,
  bedrockProfileLister,
  type ClaudeTier,
  type ClaudeModelId,
  type ProfileLister,
} from "./latest-model.js";

export { robustDecide, extractJson, type RobustDecideOpts } from "./robust-decide.js";

export { LlmPilot, type LlmPilotOpts } from "./llm-pilot.js";

export { applyGuidance } from "./guidance.js";

export { MessageBus, visibleToSeat, type BusMessage } from "./message-bus.js";
