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
}

// ============================================================================
// 3. Negotiation
// ============================================================================

/**
 * Parameters for the `mcp.negotiate` JSON-RPC method.
 *
 * The client offers its supported versions, encodings, and compression codecs.
 * The server selects one from each list.
 */
export interface NegotiateParams {
  /** Client-supported MCP protocol versions, in preference order (implied). */
  versions?: string[];

  /** Client-supported message encodings, in preference order (implied). */
  encodings?: string[];

  /** Client-supported compression codecs, in preference order (implied). */
  compression?: string[];
}

/**
 * Result of a successful `mcp.negotiate` call.
 * The server picks a single value from each category.
 */
export interface NegotiateResult {
  /** Selected MCP protocol version. */
  version: string;

  /** Selected message encoding for the session. */
  encoding: string;

  /** Selected compression codec for the session. */
  compression: string;
}

/** Default negotiation values when a server does not support negotiation. */
export const DEFAULT_NEGOTIATION: NegotiateResult = {
  version: "2025-03",
  encoding: "json",
  compression: "none",
} as const;

// ============================================================================
// 4. Execution Plans
// ============================================================================

// ---------------------------------------------------------------------------
// Plan container
// ---------------------------------------------------------------------------

/**
 * A portable, deterministic representation of a multi-step operation.
 * Execution plans MUST be serializable as JSON and MUST NOT require
 * arbitrary code execution.
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
// Step types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all step types.
 * The discriminator is implicit via the presence of specific fields:
 * - `tool` present + no `operation` → ToolStep
 * - `operation` present → OperationStep (regex, etc.)
 * - `foreach` present → ForeachBlock
 * - `parallel` present → ParallelBlock
 * - `if` present → ConditionalBlock
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
 * Evaluates an expression and executes the appropriate branch.
 */
export interface ConditionalBlock {
  /** Optional identifier for result referencing. */
  id?: string;

  /**
   * Condition expression string.
   * The expression language is implementation-defined per the spec.
   * SHOULD be deterministic and side-effect free.
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
 * Pauses plan execution until a human approves or denies the operation.
 */
export interface ApprovalGate {
  /** Message displayed to the human for context (e.g., "Send 37 emails?"). */
  message: string;
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
  pendingApproval?: ApprovalGate;
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

  /** Error severity. */
  severity: "error" | "warning";
}

/**
 * Computed metadata about a plan.
 */
export interface PlanMetadata {
  /** Total number of steps (recursive). */
  totalSteps: number;

  /** Maximum nesting depth (foreach/parallel/conditional). */
  maxDepth: number;

  /** Number of approval gates. */
  approvalCount: number;

  /** Whether the plan contains parallel execution. */
  hasParallel: boolean;

  /** Whether the plan contains foreach. */
  hasForeach: boolean;

  /** Whether the plan contains conditionals. */
  hasConditionals: boolean;

  /** Set of tool names used in the plan. */
  toolsUsed: Set<string>;
}

// ============================================================================
// 5. Tool Metadata
// ============================================================================

/**
 * Extended metadata for MCP tools.
 * These fields augment the standard MCP Tool definition to describe
 * execution characteristics.
 */
export interface ToolMetadata {
  /** Whether the tool causes external state changes. Default: true. */
  side_effects?: boolean;

  /** Whether the tool is safe to retry without side effects. Default: false. */
  idempotent?: boolean;

  /** Whether the tool should prompt for human confirmation. Default: false. */
  requires_confirmation?: boolean;

  /** Extensible: implementations MAY define additional metadata fields. */
  [key: string]: unknown;
}

// ============================================================================
// 6. Structured Errors
// ============================================================================

/**
 * A structured error object returned by the server.
 * Provides richer error information than standard JSON-RPC errors.
 */
export interface StructuredError {
  /**
   * Stable, machine-readable error identifier.
   * Examples: "TOOL_AUTH_REQUIRED", "TOOL_NOT_FOUND", "RATE_LIMITED".
   */
  code: string;

  /** Whether the operation may succeed if retried. */
  retryable?: boolean;

  /** Suggested delay before retrying (format TBD — likely milliseconds). */
  retry_after?: number;

  /** Implementation-specific error context. */
  details?: Record<string, unknown>;
}

/**
 * Well-known error codes proposed for the structured error model.
 * (Not yet standardized in the spec — proposed here for reference.)
 */
export const ErrorCodes = {
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  PLAN_VALIDATION_ERROR: "PLAN_VALIDATION_ERROR",
  APPROVAL_DENIED: "APPROVAL_DENIED",
} as const;

// ============================================================================
// 7. JSON-RPC Wrappers
// ============================================================================

/**
 * Minimal JSON-RPC request shape (the parts relevant to mcp-e).
 */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: TParams;
}

/**
 * Minimal JSON-RPC success response shape.
 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: TResult;
}

/**
 * Minimal JSON-RPC error response shape with optional structured error data.
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

/** Union type for JSON-RPC responses. */
export type JsonRpcResponse<TResult = unknown, TData = StructuredError> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse<TData>;
