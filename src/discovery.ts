/**
 * mcp-e Discovery: Client and server handler sketches.
 *
 * Implements the discovery protocol defined in the mcp-e spec:
 * - Client discovers server endpoints via `GET /.well-known/mcp`
 * - Client fetches capability document to determine supported features
 * - Both operations degrade gracefully on failure
 *
 * @packageDocumentation
 */

import type {
  McpDiscoveryDocument,
  McpCapabilitiesDocument,
  JsonRpcResponse,
} from "./types";

// ============================================================================
// Discovery Client
// ============================================================================

/**
 * Configuration options for the discovery client.
 */
export interface DiscoveryClientOptions {
  /**
   * Base URL of the MCP server.
   * Used to construct the discovery and capability document URLs.
   */
  baseUrl: string;

  /** Timeout in milliseconds for discovery requests. */
  timeoutMs?: number;

  /** Number of retries for transient failures. */
  maxRetries?: number;

  /** Custom headers to include in discovery requests. */
  headers?: Record<string, string>;
}

/** Default configuration values. */
const DEFAULT_DISCOVERY_OPTIONS: Partial<DiscoveryClientOptions> = {
  timeoutMs: 10_000,
  maxRetries: 2,
};

/**
 * Result of a full discovery sequence.
 */
export interface DiscoveryResult {
  /** Whether discovery was successful. */
  success: boolean;

  /** The parsed discovery document, if retrieved. */
  discovery?: McpDiscoveryDocument;

  /** The parsed capabilities document, if retrieved. */
  capabilities?: McpCapabilitiesDocument;

  /** Error information if discovery failed. */
  error?: {
    message: string;
    stage: "discovery" | "capabilities" | "all";
    cause?: unknown;
  };
}

/**
 * MCP discovery client.
 *
 * Handles the full discovery sequence:
 * 1. Fetch the discovery document from `/.well-known/mcp`
 * 2. If `capabilities_url` is present, fetch capabilities
 * 3. Return a consolidated result
 *
 * Degrades gracefully: if discovery fails, the client MAY fall back to
 * manual configuration as per the spec.
 */
export class DiscoveryClient {
  private readonly baseUrl: string;
  private readonly options: Required<DiscoveryClientOptions>;

  constructor(options: DiscoveryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.options = { ...DEFAULT_DISCOVERY_OPTIONS, ...options } as Required<
      DiscoveryClientOptions
    >;
  }

  /**
   * Perform the full discovery sequence.
   *
   * Steps:
   * 1. GET `/.well-known/mcp` → parse `McpDiscoveryDocument`
   * 2. If doc has `capabilities_url`, GET that URL → parse capabilities
   * 3. Return consolidated `DiscoveryResult`
   *
   * On failure, returns a `DiscoveryResult` with `success: false` and
   * error details. The caller should fall back to manual configuration.
   */
  async discover(): Promise<DiscoveryResult> {
    try {
      // Step 1: fetch the discovery document
      const discoveryDoc = await this.fetchDiscoveryDocument();

      if (!discoveryDoc) {
        return {
          success: false,
          error: {
            message: "Failed to retrieve discovery document",
            stage: "discovery",
          },
        };
      }

      // Step 2: fetch capabilities if URL is advertised
      let capabilitiesDoc: McpCapabilitiesDocument | undefined;

      if (discoveryDoc.capabilities_url) {
        try {
          capabilitiesDoc = await this.fetchCapabilitiesDocument(
            discoveryDoc.capabilities_url
          );
        } catch (capErr) {
          // Spec says: capability discovery failure does not prevent connection
          // Gracefully degrade — proceed with discovery doc only
          console.warn(
            `Capability discovery failed for ${discoveryDoc.capabilities_url}:`,
            capErr
          );
        }
      }

      return {
        success: true,
        discovery: discoveryDoc,
        capabilities: capabilitiesDoc,
      };
    } catch (err) {
      return {
        success: false,
        error: {
          message: err instanceof Error ? err.message : "Unknown error",
          stage: "all",
          cause: err,
        },
      };
    }
  }

  /**
   * Fetch and parse the discovery document.
   * Attempts `GET /.well-known/mcp` with optional retries.
   */
  private async fetchDiscoveryDocument(): Promise<McpDiscoveryDocument | null> {
    const url = `${this.baseUrl}/.well-known/mcp`;

    for (let attempt = 1; attempt <= this.options.maxRetries + 1; attempt++) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/mcp-discovery+json, application/json",
            ...this.options.headers,
          },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });

        if (!response.ok) {
          // 404 means the server does not support discovery — not an error
          if (response.status === 404) {
            return null;
          }
          throw new Error(
            `Discovery request failed: ${response.status} ${response.statusText}`
          );
        }

        const doc: McpDiscoveryDocument = await response.json();

        // Basic structural validation
        if (!doc.mcp_version || !Array.isArray(doc.endpoints)) {
          throw new Error(
            "Invalid discovery document: missing required fields"
          );
        }

        return doc;
      } catch (err) {
        if (attempt > this.options.maxRetries) {
          throw err;
        }
        // Exponential backoff before retry
        await this.delay(Math.pow(2, attempt) * 200);
      }
    }

    return null; // Should not reach here
  }

  /**
   * Fetch and parse the capabilities document from the given URL.
   */
  private async fetchCapabilitiesDocument(
    url: string
  ): Promise<McpCapabilitiesDocument> {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...this.options.headers,
      },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Capabilities request failed: ${response.status} ${response.statusText}`
      );
    }

    return (await response.json()) as McpCapabilitiesDocument;
  }

  /** Simple promise-based delay helper. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Discovery Server Handler
// ============================================================================

/**
 * Server-side handler for discovery requests.
 *
 * Processes incoming GET requests to `/.well-known/mcp` and
 * `/.well-known/mcp/capabilities`, returning the appropriate documents.
 */
export interface DiscoveryServerHandlerOptions {
  /** The server's discovery document to serve. */
  discoveryDocument: McpDiscoveryDocument;

  /** Optional capabilities document to serve at `capabilities_url`. */
  capabilitiesDocument?: McpCapabilitiesDocument;
}

/**
 * Server handler for the discovery endpoints.
 *
 * Usage:
 * ```ts
 * const handler = new DiscoveryServerHandler({
 *   discoveryDocument: { ... },
 *   capabilitiesDocument: { ... },
 * });
 *
 * // In your HTTP router:
 * app.get('/.well-known/mcp', (req, res) => handler.handleDiscovery(req, res));
 * ```
 */
export class DiscoveryServerHandler {
  private readonly options: DiscoveryServerHandlerOptions;

  constructor(options: DiscoveryServerHandlerOptions) {
    this.options = options;
  }

  /**
   * Handle a GET request to `/.well-known/mcp`.
   *
   * Returns the discovery document with content type
   * `application/mcp-discovery+json`.
   */
  handleDiscovery(): McpDiscoveryDocument {
    return this.options.discoveryDocument;
  }

  /**
   * Handle a GET request for the capabilities document.
   *
   * Returns the capabilities document with content type `application/json`.
   * Returns 404 if no capabilities document is configured.
   */
  handleCapabilities(): McpCapabilitiesDocument | null {
    return this.options.capabilitiesDocument ?? null;
  }

  /**
   * Resolve the full capabilities URL for inclusion in the discovery document.
   * If the server is mounted at a base path, this constructs the full URL.
   */
  resolveCapabilitiesUrl(serverBaseUrl: string): string {
    return `${serverBaseUrl.replace(/\/+$/, "")}/.well-known/mcp/capabilities`;
  }
}

// ============================================================================
// Utility: Merge discovery into JSON-RPC initialize flow
// ============================================================================

/**
 * Extended server capabilities that include mcp-e extensions.
 * This type represents what the server reports during the MCP `initialize`
 * handshake after discovery has been performed.
 *
 * This is a proposed contract — the spec does not define how discovery data
 * flows into the `initialize` exchange.
 */
export interface ExtendedServerCapabilities {
  /** Standard MCP protocol version. */
  protocolVersion: string;

  /** Whether the server supports mcp-e execution plans. */
  supportsPlans?: boolean;

  /** Whether the server supports negotiated compression. */
  compression?: string;

  /** Whether the server supports negotiated encodings. */
  encoding?: string;

  /** Known extensions supported by the server. */
  extensions?: string[];
}

/**
 * Merge discovery + capabilities into a capabilities object for the
 * `initialize` handshake. This allows the enhanced client to present
 * a unified view to the rest of the application.
 */
export function mergeDiscoveryIntoCapabilities(
  discoveryResult: DiscoveryResult
): ExtendedServerCapabilities {
  const base: ExtendedServerCapabilities = {
    protocolVersion:
      discoveryResult.discovery?.mcp_version ?? "2025-03",
  };

  if (!discoveryResult.capabilities) {
    return base;
  }

  return {
    ...base,
    supportsPlans: discoveryResult.capabilities.extensions?.includes("plans"),
    extensions: discoveryResult.capabilities.extensions,
  };
}
