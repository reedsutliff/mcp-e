/**
 * mcp-e Negotiation: Client and server protocol sketches.
 *
 * Implements the `mcp.negotiate` JSON-RPC method for negotiating protocol
 * versions, message encodings, and compression between client and server.
 *
 * @packageDocumentation
 */

import type {
  NegotiateParams,
  NegotiateResult,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  StructuredError,
} from "./types";

/** Default negotiation result when the server doesn't support negotiation. */
const DEFAULT_NEGOTIATION: NegotiateResult = {
  version: "2025-03",
  encoding: "json",
  compression: "none",
  extensions: [],
  expression_language: "cel",
};

// ============================================================================
// Negotiation Client
// ============================================================================

/**
 * Configuration for the negotiation client.
 */
export interface NegotiationClientOptions {
  /** Timeout in milliseconds for the negotiate request. */
  timeoutMs?: number;

  /**
   * Whether to use the negotiated compression for subsequent messages.
   * If true, the client will compress outgoing messages after negotiation.
   */
  applyCompression?: boolean;

  /**
   * Whether to use the negotiated encoding for subsequent messages.
   * If true, the client will encode outgoing messages accordingly.
   */
  applyEncoding?: boolean;
}

const DEFAULT_NEGOTIATION_OPTIONS: Required<NegotiationClientOptions> = {
  timeoutMs: 10_000,
  applyCompression: false,
  applyEncoding: false,
};

/**
 * Result of a negotiation attempt.
 */
export interface NegotiationResult {
  /** Whether negotiation was successful (or gracefully degraded). */
  success: boolean;

  /** The negotiated parameters (always populated — falls back to defaults). */
  result: NegotiateResult;

  /** Whether the server actually supports negotiation. */
  serverSupportsNegotiation: boolean;

  /** Error details if negotiation failed unexpectedly. */
  error?: {
    message: string;
    code?: number;
    structured?: StructuredError;
  };
}

/**
 * MCP negotiation client.
 *
 * Sends `mcp.negotiate` requests to the server to agree on:
 * - MCP protocol version
 * - Message encoding format (json, jsonl, json-seq)
 * - Compression codec (none, gzip, zstd)
 *
 * Degrades gracefully: if the server returns `-32601 Method not found`,
 * the client falls back to defaults (json, none, 2025-03).
 */
export class NegotiationClient {
  private readonly options: Required<NegotiationClientOptions>;
  private currentResult: NegotiateResult;

  constructor(options?: NegotiationClientOptions) {
    this.options = { ...DEFAULT_NEGOTIATION_OPTIONS, ...options };
    this.currentResult = { ...DEFAULT_NEGOTIATION };
  }

  /**
   * Perform negotiation with the server.
   *
   * Steps:
   * 1. Build a JSON-RPC `mcp.negotiate` request with client preferences
   * 2. Send via the established transport
   * 3. Handle the response:
   *    - Success → store negotiated values
   *    - `-32601 Method not found` → fall back to defaults
   *    - Other errors → fall back to defaults (spec: MUST gracefully fall back)
   * 4. Return the `NegotiationResult`
   *
   * @param transport - A function that sends a JSON-RPC request and returns the response.
   * @param params - Client's negotiation preferences.
   */
  async negotiate(
    transport: JsonRpcTransport,
    params: NegotiateParams
  ): Promise<NegotiationResult> {
    const request: JsonRpcRequest<NegotiateParams> = {
      jsonrpc: "2.0",
      id: 1,
      method: "mcp.negotiate",
      params,
    };

    try {
      const response = await transport.send(request, {
        timeout: this.options.timeoutMs,
      });

      // Check for JSON-RPC error response
      if ("error" in response) {
        const error = response.error;

        // Server does not support negotiation — graceful degradation
        if (error.code === -32601) {
          this.currentResult = { ...DEFAULT_NEGOTIATION };
          return {
            success: true,
            result: this.currentResult,
            serverSupportsNegotiation: false,
          };
        }

        // Other JSON-RPC error — fall back gracefully
        this.currentResult = { ...DEFAULT_NEGOTIATION };
        return {
          success: true,
          result: this.currentResult,
          serverSupportsNegotiation: true,
          error: {
            message: error.message,
            code: error.code,
            structured: error.data as StructuredError | undefined,
          },
        };
      }

      // Success — apply negotiated result
      const result = response.result as NegotiateResult;
      this.currentResult = result;

      return {
        success: true,
        result,
        serverSupportsNegotiation: true,
      };
    } catch (err) {
      // Transport error (timeout, network failure) — fall back
      this.currentResult = { ...DEFAULT_NEGOTIATION };
      return {
        success: true,
        result: this.currentResult,
        serverSupportsNegotiation: false,
        error: {
          message: err instanceof Error ? err.message : "Negotiation failed",
        },
      };
    }
  }

  /**
   * Returns the currently active negotiation result.
   * Useful for determining how to encode/compress subsequent messages.
   */
  getCurrentNegotiation(): NegotiateResult {
    return { ...this.currentResult };
  }

  /**
   * Reset negotiation to defaults (e.g., on reconnection).
   */
  reset(): void {
    this.currentResult = { ...DEFAULT_NEGOTIATION };
  }
}

// ============================================================================
// Negotiation Server Handler
// ============================================================================

/**
 * Server-side negotiation handler options.
 */
export interface NegotiateHandlerOptions {
  /** MCP protocol versions the server supports. */
  supportedVersions: string[];

  /** Message encodings the server supports. */
  supportedEncodings: string[];

  /** Compression codecs the server supports. */
  supportedCompression: string[];

  /** Extension identifiers the server supports (e.g., "plans", "subscriptions"). */
  supportedExtensions?: string[];

  /** Expression languages the server supports (e.g., "cel", "jsonata", "sandbox"). */
  supportedExpressionLanguages?: string[];

  /**
   * Selection strategy for picking from the client's offers.
   * - "prefer-first": pick the first matching value from each list
   * - "prefer-latest": pick the highest version, preferred encoding/codec
   * - Custom function
   */
  selectionStrategy?: "prefer-first" | "prefer-latest" | SelectionFunction;
}

/**
 * Custom selection function for negotiation.
 * Returns the selected value from the intersection of client offers and server supports.
 */
export type SelectionFunction = (
  clientOffers: string[] | undefined,
  serverSupports: string[],
  category: "version" | "encoding" | "compression" | "extension" | "expression_language"
) => string | null;

/**
 * Result of processing a negotiate request.
 */
export interface NegotiateRequestResult {
  /** Whether negotiation succeeded. */
  success: boolean;

  /** The negotiated result (only on success). */
  result?: NegotiateResult;

  /** JSON-RPC error response (on failure). */
  error?: {
    code: number;
    message: string;
    data?: StructuredError;
  };
}

/**
 * MCP negotiation server handler.
 *
 * Processes incoming `mcp.negotiate` JSON-RPC requests.
 */
export class NegotiateHandler {
  private readonly options: Required<NegotiateHandlerOptions>;

  constructor(options: NegotiateHandlerOptions) {
    this.options = {
      selectionStrategy: "prefer-first",
      ...options,
    };
  }

  /**
   * Handle an `mcp.negotiate` request.
   *
   * Selection logic:
   * 1. Compute intersection of client-offered and server-supported values
   * 2. Apply selection strategy to pick one value per category
   * 3. If no intersection exists for a required category, return error
   * 4. Otherwise, return the `NegotiateResult`
   *
   * @param request - The parsed negotiate parameters.
   * @returns Success with negotiated result, or error.
   */
  handle(params: NegotiateParams): NegotiateRequestResult {
    const version = this.select(
      params.versions,
      this.options.supportedVersions,
      "version"
    );
    const encoding = this.select(
      params.encodings,
      this.options.supportedEncodings,
      "encoding"
    );
    const compression = this.select(
      params.compression,
      this.options.supportedCompression,
      "compression"
    );

    // Extensions: compute intersection, return all matches
    const extensions = this.selectExtensions(
      params.extensions,
      this.options.supportedExtensions ?? []
    );

    // Expression language: single selection with CEL fallback
    const expressionLanguage = this.selectExpressionLanguage(
      params.expression_language,
      this.options.supportedExpressionLanguages ?? ["cel"]
    );

    // If any required selection fails, return an error
    if (!version || !encoding || !compression) {
      return {
        success: false,
        error: {
          code: -32602,
          message: "No common parameters found",
          data: {
            code: "NEGOTIATION_FAILED",
            details: {
              clientVersions: params.versions,
              serverVersions: this.options.supportedVersions,
              clientEncodings: params.encodings,
              serverEncodings: this.options.supportedEncodings,
            },
          },
        },
      };
    }

    return {
      success: true,
      result: { version, encoding, compression, extensions, expression_language: expressionLanguage },
    };
  }

  /**
   * Select active extensions from client request.
   * Returns the intersection of requested and supported extensions.
   */
  private selectExtensions(
    clientExtensions: string[] | undefined,
    serverExtensions: string[]
  ): string[] {
    if (!clientExtensions || clientExtensions.length === 0) {
      return [];
    }
    const serverSet = new Set(serverExtensions);
    return clientExtensions.filter((e) => serverSet.has(e));
  }

  /**
   * Select expression language.
   * Client's preference wins if supported; otherwise CEL.
   */
  private selectExpressionLanguage(
    clientLanguage: string | undefined,
    serverLanguages: string[]
  ): string {
    if (clientLanguage && serverLanguages.includes(clientLanguage)) {
      return clientLanguage;
    }
    // Fall back to CEL if available
    if (serverLanguages.includes("cel")) return "cel";
    // Otherwise first supported
    return serverLanguages[0] ?? "cel";
  }

  /**
   * Select a single value using the configured strategy.
   */
  private select(
    clientOffers: string[] | undefined,
    serverSupports: string[],
    category: "version" | "encoding" | "compression"
  ): string | null {
    if (!clientOffers || clientOffers.length === 0) {
      // Client didn't specify — pick server default (first supported)
      return serverSupports[0] ?? null;
    }

    // Compute intersection preserving client order
    const serverSet = new Set(serverSupports);
    const intersection = clientOffers.filter((o) => serverSet.has(o));

    if (intersection.length === 0) {
      return null;
    }

    if (typeof this.options.selectionStrategy === "function") {
      return this.options.selectionStrategy(
        clientOffers,
        serverSupports,
        category
      );
    }

    switch (this.options.selectionStrategy) {
      case "prefer-latest": {
        // Use the last (newest/highest) intersecting value
        return intersection[intersection.length - 1];
      }
      case "prefer-first":
      default: {
        // Use the client's first preference that the server supports
        return intersection[0];
      }
    }
  }

  /**
   * Build a JSON-RPC success response for negotiation.
   */
  buildSuccessResponse(
    id: number | string,
    result: NegotiateResult
  ): JsonRpcSuccessResponse<NegotiateResult> {
    return { jsonrpc: "2.0", id, result };
  }

  /**
   * Build a JSON-RPC error response when negotiation is not supported.
   */
  buildMethodNotFoundResponse(
    id: number | string
  ): JsonRpcErrorResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Method not found",
      },
    };
  }
}

// ============================================================================
// Transport abstraction
// ============================================================================

/**
 * Minimal transport abstraction for sending JSON-RPC requests.
 * Implementations would wire this to WebSocket, streamable HTTP, or stdio.
 */
export interface JsonRpcTransport {
  /**
   * Send a JSON-RPC request and receive a response.
   *
   * @param request - The JSON-RPC request object.
   * @param options - Transport options (timeout, etc.).
   * @returns The JSON-RPC response (success or error).
   */
  send<TResult = unknown, TData = StructuredError>(
    request: JsonRpcRequest,
    options?: { timeout?: number }
  ): Promise<
    | JsonRpcSuccessResponse<TResult>
    | JsonRpcErrorResponse<TData>
  >;

  /**
   * Whether the transport is currently open/connected.
   */
  isConnected(): boolean;

  /**
   * Close the transport connection.
   */
  close(): void;
}
