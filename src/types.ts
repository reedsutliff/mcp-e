/**
 * mcp-e TypeScript type definitions
 *
 * This module contains all interfaces, enums, and type aliases derived from
 * the mcp-e specification (v0.1.0 draft).
 *
 * @packageDocumentation
 */

// ============================================================================
// 1. Discovery
// ============================================================================

/**
 * Transport protocol identifier for an MCP endpoint.
 * The spec suggests "streamable-http", "websocket", but implementations MAY
 * define custom transport types. "stdio" is notably absent from examples
 * but is a valid MCP transport.
 */
export type TransportType = string & { __transport?: never };

/** Pre-defined transport identifiers used in the spec examples. */
export const TRANSPORTS = {
  STREAMABLE_HTTP: "streamable-http" as TransportType,
  WEBSOCKET: "websocket" as TransportType,
  STDIO: "stdio" as TransportType,
} as const;

/**
 * An accessible endpoint for MCP communication.
 * Each endpoint specifies a transport protocol and a connection URL.
 */
export interface McpEndpoint {
  /** Transport protocol identifier (e.g., "streamable-http", "websocket"). */
  transport: TransportType;

  /**
   * Full absolute URL for the endpoint.
   * - For HTTP transports: https://example.com/mcp
   * - For WebSocket: wss://example.com/mcp/ws
   * - For stdio: implementation-defined (may use a local scheme)
   */
  url: string;
}

// ---------------------------------------------------------------------------
// Authentication mechanism types
// ---------------------------------------------------------------------------

/**
 * Authentication mechanism descriptor.
 * Discriminated union keyed by `type`.
 */
export type AuthMechanism =
  | AuthNone
  | AuthBearer
  | AuthOAuth2
  | AuthApiKey
  // Extensible via index: implementations MAY define custom auth types
  | { type: string; [key: string]: unknown };

/** No authentication required. */
export interface AuthNone {
  type: "none";
}

/** Bearer token authentication. The spec gives no token acquisition guidance. */
export interface AuthBearer {
  type: "bearer";
}

/**
 * OAuth 2.0 authentication.
 * References OpenID Connect discovery for issuer metadata.
 */
export interface AuthOAuth2 {
  type: "oauth2";
  /** OpenID Connect issuer URL (e.g., "https://login.example.com"). */
  issuer: string;
  /** Requested OAuth scopes (e.g., ["mcp.read", "mcp.write"]). */
  scopes?: string[];
}

/** API key authentication. */
export interface AuthApiKey {
  type: "api_key";
  /** Header name or query parameter to pass the key in. */
  param_name?: string;
  /** Where the key is expected: "header", "query", or "cookie". */
  in?: "header" | "query" | "cookie";
}

/**
 * Complete discovery document.
 *
 * Served at `GET /.well-known/mcp` with content-type
 * `application/mcp-discovery+json`.
 */
export interface McpDiscoveryDocument {
  /**
   * The MCP protocol version the server supports.
   * Format: "YYYY-MM" (e.g., "2025-03", "2026-01").
   */
  mcp_version: string;

  /** Human-readable server name for display purposes. */
  server_name?: string;

  /** Human-readable description of the server's capabilities. */
  description?: string;

  /** Available transport endpoints for MCP communication. */
  endpoints: McpEndpoint[];

  /**
   * Optional URL to the capability discovery document.
   * If omitted, clients MAY attempt the default path `/.well-known/mcp/capabilities`.
   */
  capabilities_url?: string;

  /** Advertised authentication mechanisms. */
  auth?: AuthMechanism[];
}

// ============================================================================
// 2. Capability Discovery
// ============================================================================

/**
 * Capability discovery document.
 *
 * Served at `GET /.well-known/mcp/capabilities` (or the URL specified by
 * `capabilities_url` in the discovery document).
 */
export interface McpCapabilitiesDocument {
  /** MCP protocol versions supported by the server. */
  mcp_versions?: string[];

  /** Message encoding formats supported (e.g., "json", "jsonl", "json-seq"). */
  message_encodings?: string[];

  /** Compression codecs supported (e.g., "none", "gzip", "zstd"). */
  compression?: string[];

  /** Extension identifiers supported (e.g., "plans", "subscriptions", "resumable"). */
  extensions?: string[];

  /**
   * Expression languages the server supports.
   * Servers advertising "plans" MUST include "cel".
   * Optional additions: "jsonata", "sandbox".
   */
  expression_languages?: string[];
}

// ============================================================================
// 3. Negotiation
// ============================================================================

/**
 * Parameters for the `mcp.negotiate` JSON-RPC method.
 *
 * The client offers its supported versions, encodings, compression codecs,
 * extensions, and preferred expression language. The server selects one
 * from each offered list.
 */
export interface NegotiateParams {
  /** Client-supported MCP protocol versions, in preference order (implied). */
  versions?: string[];

  /** Client-supported message encodings, in preference order (implied). */
  encodings?: string[];

  /** Client-supported compression codecs, in preference order (implied). */
  compression?: string[];

  /** Requested extension identifiers to activate (e.g., ["plans", "subscriptions"]). */
  extensions?: string[];

  /** Preferred expression language identifier (e.g., "cel", "jsonata"). */
  expression_language?: string;
}

/**
 * Result of a successful `mcp.negotiate` call.
 * The server picks a single value from each category, constrained to the
 * intersection of what the client offered and the server supports.
 */
export interface NegotiateResult {
  /** Selected MCP protocol version. */
  version: string;

  /** Selected message encoding for the session. */
  encoding: string;

  /** Selected compression codec for the session. */
  compression: string;

  /** Activated extension identifiers. */
  extensions?: string[];

  /** Selected expression language for conditional evaluation. */
  expression_language?: string;
}

/** Default negotiation values when a server does not support negotiation. */
export const DEFAULT_NEGOTIATION: NegotiateResult = {
  version: "2025-03",
  encoding: "json",
  compression: "none",
  extensions: [],
  expression_language: "cel",
} as const;

// ============================================================================
// 4. Execution Plans
// ============================================================================

// ---------------------------------------------------------------------------
// Step kind discriminator
// ---------------------------------------------------------------------------

/**
 * Discriminator for plan step types.
 * Every plan step SHALL have a `kind` field from this enum.
 */
export enum StepKind {
  TOOL_CALL = "tool_call",
  OPERATION = "operation",
  FOREACH = "foreach",
  PARALLEL = "parallel",
  CONDITIONAL = "conditional",
}

// ---------------------------------------------------------------------------
// Plan container
// ---------------------------------------------------------------------------

/**
 * A portable, deterministic representation of a multi-step operation.
 * Execution plans MUST be serializable as JSON and MUST NOT require
 * arbitrary code execution (unless sandbox is negotiated).
 */
export interface Plan {
  /** Discriminator — MUST equal "mcp.plan". */
  type: "mcp.plan";

  /** Plan schema version (integer). */
  version: number;

  /** Ordered sequence of execution steps. */
  steps: Step[];
}

// ---------------------------------------------------------------------------
// Step types — discriminated union on `kind`
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all step types.
 * The discriminator is the `kind` field — every step MUST set it.
 */
export type Step =
  | ToolStep
  | OperationStep
  | ForeachBlock
  | ParallelBlock
  | ConditionalBlock;

// ---------------------------------------------------------------------------
// Tool invocation
// ---------------------------------------------------------------------------

/**
 * A tool invocation step within a plan.
 * Calls a named tool with optional arguments.
 */
export interface ToolStep {
  /** Step type discriminator — MUST equal "tool_call". */
  kind: StepKind.TOOL_CALL;

  /** Optional identifier for result referencing via `$id.result`. */
  id?: string;

  /** Name of the tool to invoke. */
  tool: string;

  /** Arguments passed to the tool. */
  arguments?: Record<string, unknown>;

  /** Retry policy for transient failures. */
  retry?: RetryPolicy;

  /** Error handling behaviour when this step fails. */
  on_error?: ErrorBehavior;

  /** Human approval gate — pauses execution until approved. */
  approval?: ApprovalGate;
}

// ---------------------------------------------------------------------------
// Operational steps (regex, etc.)
// ---------------------------------------------------------------------------

/**
 * A non-tool operation step.
 * Currently only "regex" is specified, but the design is extensible.
 */
export interface OperationStep {
  /** Step type discriminator — MUST equal "operation". */
  kind: StepKind.OPERATION;

  /** Optional identifier for result referencing. */
  id?: string;

  /**
   * Operation type discriminator.
   * Currently defined: "regex".
   */
  operation: string;

  /** Input value (typically a variable reference). */
  input?: string;

  /** Operation-specific parameters. */
  [key: string]: unknown;
}

/**
 * Result shape for a regex operation step.
 */
export interface RegexOperationResult {
  /** Array of match strings. */
  matches: string[];
}

// ---------------------------------------------------------------------------
// Foreach
// ---------------------------------------------------------------------------

/**
 * Fan-out execution block.
 * Enumerates a collection and executes sub-steps for each element.
 */
export interface ForeachBlock {
  /** Step type discriminator — MUST equal "foreach". */
  kind: StepKind.FOREACH;

  /** Optional identifier for result referencing. */
  id?: string;

  /** Variable reference to the collection to iterate (e.g., "$extract.matches"). */
  foreach: string;

  /** Variable name to bind each iteration's value to (e.g., "id"). */
  as: string;

  /** Maximum concurrency hint for parallel iteration. */
  parallelism?: number;

  /** Sub-steps to execute per iteration. */
  steps: Step[];

  /** Error handling behaviour for the foreach block as a whole. */
  on_error?: ErrorBehavior;
}

// ---------------------------------------------------------------------------
// Parallel
// ---------------------------------------------------------------------------

/**
 * Parallel execution block.
 * Executes multiple branch sequences simultaneously.
 */
export interface ParallelBlock {
  /** Step type discriminator — MUST equal "parallel". */
  kind: StepKind.PARALLEL;

  /** Optional identifier for result referencing. */
  id?: string;

  /** Array of branch sequences, each branch is a sequential array of steps. */
  parallel: Step[][];

  /** Error handling behaviour for the parallel block. */
  on_error?: ErrorBehavior;
}

// ---------------------------------------------------------------------------
// Conditional
// ---------------------------------------------------------------------------

/**
 * Conditional execution block.
 * Evaluates an expression using the negotiated expression language
 * (CEL by default) and executes the appropriate branch.
 */
export interface ConditionalBlock {
  /** Step type discriminator — MUST equal "conditional". */
  kind: StepKind.CONDITIONAL;

  /** Optional identifier for result referencing. */
  id?: string;

  /**
   * Condition expression string.
   * Evaluated using the negotiated expression language (CEL by default;
   * see Sections 2a and 3 of the spec).
   */
  if: string;

  /** Steps to execute when the condition evaluates to truthy. */
  then: Step[];

  /** Steps to execute when the condition evaluates to falsy. */
  else?: Step[];

  /** Error handling behaviour for the conditional block. */
  on_error?: ErrorBehavior;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Retry policy for tool invocations.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts. */
  attempts: number;

  /**
   * Backoff strategy.
   * Defined values: "fixed", "exponential".
   * Implementations MAY support custom strategies.
   */
  backoff: "fixed" | "exponential" | string;

  /** Initial backoff delay in milliseconds (default: 1000). */
  initial_delay_ms?: number;

  /** Maximum backoff delay in milliseconds (default: 60000). */
  max_delay_ms?: number;

  /** Backoff multiplier for exponential strategy (default: 2). */
  multiplier?: number;

  /** Apply jitter to backoff (default: true). */
  jitter?: boolean;
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Error handling behaviour for a step or block.
 *
 * - `"fail"`: Abort the entire plan on error (default).
 * - `"continue"`: Log the error, skip the step, continue execution.
 * - `"retry"`: Apply the step's retry policy (falls back to default if none configured).
 */
export type ErrorBehavior = "fail" | "continue" | "retry";

/** Default error behaviour when `on_error` is not specified. */
export const DEFAULT_ERROR_BEHAVIOR: ErrorBehavior = "fail";

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * Human approval gate.
 * Pauses plan execution until a human or policy approves or denies.
 */
export interface ApprovalGate {
  /** Message displayed to the human for context (e.g., "Send 37 emails?"). */
  message: string;

  /** Timeout in milliseconds. If exceeded, treated as denial. */
  timeout_ms?: number;
}

/**
 * Source of an approval decision.
 *
 * - `"human"`: Explicit human consent (click, confirm, voice).
 * - `"policy"`: Automated rule or policy (e.g., "auto-approve < 10 items").
 * - `"yolo"`: Pre-configured blanket approval mode on the client.
 */
export type ApprovalAuthority = "human" | "policy" | "yolo";

/**
 * Parameters for the `mcp.approve` JSON-RPC method.
 */
export interface ApproveParams {
  /** Plan identifier. */
  plan_id: string;

  /** Step identifier for the approval gate being responded to. */
  step_id: string;

  /** Source of the approval decision. */
  authorized_by: ApprovalAuthority;
}

/**
 * Parameters for the `mcp.deny` JSON-RPC method.
 */
export interface DenyParams {
  /** Plan identifier. */
  plan_id: string;

  /** Step identifier for the approval gate being responded to. */
  step_id: string;

  /** Source of the denial decision. */
  authorized_by: ApprovalAuthority;

  /** Human-readable reason for denial. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Plan execution context & state
// ---------------------------------------------------------------------------

/**
 * The accumulated state during plan execution.
 * Tracks intermediate results, variables, and execution control.
 */
export interface PlanExecutionContext {
  /** Resolved step results keyed by step ID. */
  results: Map<string, unknown>;

  /** Named variables available in the execution scope. */
  variables: Map<string, unknown>;

  /** Current iteration variables (for foreach blocks). */
  loopVars: Map<string, unknown>;

  /** Whether the plan is paused awaiting human approval. */
  paused: boolean;

  /** Current approval gate details, if paused. */
  pendingApproval?: ApprovalGate & { step_id: string };
}

/**
 * The final result of executing a plan.
 */
export interface PlanExecutionResult {
  /** Overall success or failure. */
  success: boolean;

  /** Resolved outputs from each top-level step, keyed by step ID (or index). */
  outputs: Record<string, unknown>;

  /** Error details if the plan failed. */
  error?: PlanExecutionError;

  /** Duration of execution in milliseconds. */
  durationMs: number;
}

/**
 * Error information from plan execution.
 */
export interface PlanExecutionError {
  /** Machine-readable error code. */
  code: string;

  /** Human-readable error message. */
  message: string;

  /** The step ID (or index) where the error occurred. */
  step?: string | number;

  /** Whether the operation may succeed if retried. */
  retryable?: boolean;

  /** Additional error context. */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

/**
 * Result of validating a plan before execution.
 */
export interface PlanValidationResult {
  /** Whether the plan passes validation. */
  valid: boolean;

  /** Validation errors, if any. */
  errors: PlanValidationError[];

  /** Computed plan metadata (step count, nesting depth, etc.). */
  metadata?: PlanMetadata;
}

/**
 * A single validation error.
 */
export interface PlanValidationError {
  /** Path to the invalid field (e.g., "steps[2].tool"). */
  path: string;

  /** Error message. */
  message: string;

  /**
   * Severity of the validation issue.
   * - "error": plan cannot be executed
   * - "warning": advisory, plan may still execute
   */
  severity?: "error" | "warning";
}

/**
 * Computed metadata about a plan after validation.
 */
export interface PlanMetadata {
  /** Total number of steps (top-level + nested). */
  totalSteps: number;

  /** Maximum nesting depth of blocks. */
  nestingDepth: number;

  /** Number of tool invocation steps. */
  toolCount: number;

  /** Number of foreach blocks. */
  foreachCount: number;

  /** Number of parallel blocks. */
  parallelCount: number;

  /** Number of conditional blocks. */
  conditionalCount: number;

  /** Number of approval gates. */
  approvalCount: number;

  /** Whether the plan contains any approval gates. */
  requiresApproval: boolean;
}

// ============================================================================
// 7. Structured Errors
// ============================================================================

/**
 * Well-known structured error codes.
 * Servers MAY define additional codes beyond these.
 */
export enum ErrorCode {
  TOOL_NOT_FOUND = "TOOL_NOT_FOUND",
  INVALID_ARGUMENTS = "INVALID_ARGUMENTS",
  AUTH_REQUIRED = "AUTH_REQUIRED",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  RATE_LIMITED = "RATE_LIMITED",
  TIMEOUT = "TIMEOUT",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  APPROVAL_DENIED = "APPROVAL_DENIED",
  PLAN_VALIDATION_FAILED = "PLAN_VALIDATION_FAILED",
}

/**
 * Retryability classification for standard error codes.
 */
export const ERROR_RETRYABILITY: Record<ErrorCode, boolean> = {
  [ErrorCode.TOOL_NOT_FOUND]: false,
  [ErrorCode.INVALID_ARGUMENTS]: false,
  [ErrorCode.AUTH_REQUIRED]: false,
  [ErrorCode.TOKEN_EXPIRED]: true,
  [ErrorCode.RATE_LIMITED]: true,
  [ErrorCode.TIMEOUT]: true,
  [ErrorCode.INTERNAL_ERROR]: false,
  [ErrorCode.APPROVAL_DENIED]: false,
  [ErrorCode.PLAN_VALIDATION_FAILED]: false,
};

/**
 * Structured error information for JSON-RPC error `data` field
 * or the `mcp.error` async method.
 */
export interface StructuredError {
  /** Stable error code identifier (see ErrorCode for standard codes). */
  code: string;

  /** Whether retrying the operation may succeed. */
  retryable?: boolean;

  /** Suggested delay before retrying, in milliseconds. */
  retry_after?: number;

  /** Implementation-specific error context. */
  details?: Record<string, unknown>;
}

/**
 * Parameters for the `mcp.error` async notification method.
 */
export interface McpErrorParams {
  /** The original request ID that triggered the error. */
  request_id: string;

  /** Stable error code identifier. */
  code: string;

  /** Whether retrying the operation may succeed. */
  retryable?: boolean;

  /** Suggested delay before retrying, in milliseconds. */
  retry_after?: number;

  /** Implementation-specific error context. */
  details?: Record<string, unknown>;
}

// ============================================================================
// 6. Tool Metadata
// ============================================================================

/**
 * Execution metadata for a tool.
 * Exposed as part of the tool definition (e.g., in `tools/list` response).
 */
export interface ToolMetadata {
  /** Whether the tool has external side effects (writes, sends, mutates). */
  side_effects?: boolean;

  /** Whether the tool is idempotent (safe to retry without side effects). */
  idempotent?: boolean;

  /** Whether human confirmation is recommended before execution. */
  requires_confirmation?: boolean;

  /** Expected execution timeout in milliseconds. */
  timeout_ms?: number;

  /** Rate limit hint: max calls per second. */
  rate_limit?: number;

  /** Cost estimate per invocation (arbitrary unit, implementation-defined). */
  cost_estimate?: number;
}

// ============================================================================
// Standard Error Codes
// ============================================================================

/** Standard error codes recognised by mcp-e implementations. */
export enum StandardErrorCode {
  TOOL_NOT_FOUND = "TOOL_NOT_FOUND",
  INVALID_ARGUMENTS = "INVALID_ARGUMENTS",
  AUTH_REQUIRED = "AUTH_REQUIRED",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  RATE_LIMITED = "RATE_LIMITED",
  TIMEOUT = "TIMEOUT",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  APPROVAL_DENIED = "APPROVAL_DENIED",
  PLAN_VALIDATION_FAILED = "PLAN_VALIDATION_FAILED",
}

// ============================================================================
// JSON-RPC Base Types
// ============================================================================

/**
 * A JSON-RPC request object.
 */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: TParams;
}

/**
 * A successful JSON-RPC response.
 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: TResult;
}

/**
 * A JSON-RPC error response.
 * Structured error information sits in the `data` field.
 */
export interface JsonRpcErrorResponse<TData = StructuredError> {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: TData;
  };
}

// ============================================================================
// Expression Language
// ============================================================================

/**
 * Standard expression language identifiers.
 */
export enum ExpressionLanguage {
  /** Common Expression Language (default) — mandatory for plan-supporting servers. */
  CEL = "cel",

  /** JSONata query/expression language — opt-in. */
  JSONATA = "jsonata",

  /**
   * Sandboxed JavaScript — opt-in upgrade only.
   * Servers MUST NOT advertise this in capability documents.
   * Clients MUST explicitly request it during negotiation.
   */
  SANDBOX = "sandbox",
}
