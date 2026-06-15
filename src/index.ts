/**
 * mcp-e — TypeScript types and sketched implementations.
 *
 * This package provides TypeScript type definitions and design-level
 * implementation sketches for the mcp-e specification (v0.1.0 draft).
 *
 * @packageDocumentation
 */

// ============================================================================
// Types
// ============================================================================

export type {
  // Discovery
  TransportType,
  McpEndpoint,
  AuthMechanism,
  AuthNone,
  AuthBearer,
  AuthOAuth2,
  McpDiscoveryDocument,
  // Capabilities
  McpCapabilitiesDocument,
  // Negotiation
  NegotiateParams,
  NegotiateResult,
  // Plans
  Plan,
  Step,
  ToolStep,
  OperationStep,
  ForeachBlock,
  ParallelBlock,
  ConditionalBlock,
  RetryPolicy,
  ErrorBehavior,
  ApprovalGate,
  PlanExecutionContext,
  PlanExecutionResult,
  PlanExecutionError,
  PlanValidationResult,
  PlanValidationError,
  PlanMetadata,
  RegexOperationResult,
  // Tool metadata
  ToolMetadata,
  // Structured errors
  StructuredError,
  // JSON-RPC
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  // Extended capabilities
} from "./types";

export {
  TRANSPORTS,
  DEFAULT_NEGOTIATION as DEFAULT_NEGOTIATION_CONST,
  DEFAULT_ERROR_BEHAVIOR,
  ErrorCodes,
} from "./types";

// ============================================================================
// Discovery
// ============================================================================

export {
  DiscoveryClient,
  DiscoveryServerHandler,
  mergeDiscoveryIntoCapabilities,
} from "./discovery";
export type {
  DiscoveryClientOptions,
  DiscoveryResult,
  DiscoveryServerHandlerOptions,
  ExtendedServerCapabilities,
} from "./discovery";

// ============================================================================
// Negotiation
// ============================================================================

export {
  NegotiationClient,
  NegotiateHandler,
} from "./negotiation";
export type {
  NegotiationClientOptions,
  NegotiationResult,
  NegotiateHandlerOptions,
  SelectionFunction,
  NegotiateRequestResult,
  JsonRpcTransport,
} from "./negotiation";

// ============================================================================
// Plans
// ============================================================================

export {
  PlanValidator,
  VariableResolver,
  ExpressionEvaluator,
  PlanExecutor,
  PlanBuilder,
} from "./plan";
export type {
  PlanExecutorOptions,
} from "./plan";
