// @cogweb/llm — the LLM autopilot driver and the inter-player messaging bus.
// `LlmPilot` implements the core `Pilot` seam; `robustDecide` is the shared
// retry-then-fallback backbone for both action decisions and message generation;
// `MessageBus` is the visibility-aware negotiation substrate.

export {
  OpenRouterLlmClient, llmConfigFromEnv, llmUsageTotals, resetLlmUsage,
  isCredentialsUnavailable, type LlmConfig, type MessagesClient,
  type LlmUsageTotals, type LlmMessage, type LlmResult, type LlmUsage, type ToolSpec,
} from "./openrouter.js";

export { robustDecide, extractJson, type RobustDecideOpts } from "./robust-decide.js";

export { LlmPilot, type LlmPilotOpts } from "./llm-pilot.js";

export { applyGuidance } from "./guidance.js";

export { MessageBus, visibleToSeat, type BusMessage } from "./message-bus.js";
