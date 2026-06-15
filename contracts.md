# mcp-e Client/Server Contract Boundaries

**Spec version:** 0.1.0 (Draft)

This document breaks down each extension point in terms of who initiates, required vs optional fields, expected response shapes, failure modes, and state transitions.

---

## Table of Contents

- [1. Discovery](#1-discovery)
- [2. Capability Discovery](#2-capability-discovery)
- [3. Negotiation](#3-negotiation)
- [4. Authentication Discovery](#4-authentication-discovery)
- [5. Execution Plans](#5-execution-plans)
- [6. Tool Metadata](#6-tool-metadata)
- [7. Structured Errors](#7-structured-errors)
- [8. Lifecycle & State Transitions](#8-lifecycle--state-transitions)

---

## 1. Discovery

### Who initiates
**Client** initiates via `GET /.well-known/mcp` on the server's base URL.

### Contract
```
Client                          Server
  |                               |
  |-- GET /.well-known/mcp ------>|
  |                               |
  |<-- 200 application/mcp-discovery+json --|
  |    {                          |
  |      mcp_version: string,     |
  |      server_name?: string,    |
  |      description?: string,    |
  |      endpoints: Endpoint[],   |
  |      capabilities_url?: string, |
  |      auth?: AuthMechanism[]   |
  |    }                          |
```

### Required vs optional fields

| Field             | Required | Notes                                    |
|-------------------|----------|------------------------------------------|
| `mcp_version`     | Yes      | String, e.g. `"2025-03"`                 |
| `server_name`     | No       | Display name                             |
| `description`     | No       | Human-readable description               |
| `endpoints`       | Yes      | At least one endpoint expected           |
| `endpoints[].transport` | Yes | Transport type identifier                |
| `endpoints[].url` | Yes      | Full URL including scheme                |
| `capabilities_url`| No       | URL for capability discovery             |
| `auth`            | No       | Array of auth mechanism descriptors      |

### Endpoint shape

```typescript
interface Endpoint {
  transport: "streamable-http" | "websocket" | "stdio" | string;
  url: string; // absolute URL
}
```

### Failure modes

| Failure                      | Client behaviour                              |
|------------------------------|-----------------------------------------------|
| HTTP 404 / 4xx               | Falls back to manual configuration            |
| HTTP 5xx                     | Retry with backoff or fall back               |
| Timeout / unreachable        | Fall back; possibly retry                     |
| Malformed JSON               | Treat as unavailable, fall back               |
| Missing required fields      | Treat doc as invalid, fall back               |

### State transitions

```
UNKNOWN ──(discovery success)──> DISCOVERED
UNKNOWN ──(discovery failed)───> FALLBACK (manual config)
DISCOVERED ──(stale, refetch)──> DISCOVERED (refreshed)
```

---

## 2. Capability Discovery

### Who initiates
**Client** initiates via `GET /.well-known/mcp/capabilities` (or the URL specified in `capabilities_url` from the discovery doc).

### Contract

```
Client                          Server
  |                               |
  |-- GET /.well-known/mcp/capabilities -->|
  |                               |
  |<-- 200 application/json ------|
  |    {                          |
  |      mcp_versions: string[],  |
  |      message_encodings: string[], |
  |      compression: string[],   |
  |      extensions: string[]     |
  |    }                          |
```

### Required vs optional fields

| Field               | Required | Notes                                    |
|---------------------|----------|------------------------------------------|
| `mcp_versions`      | No       | Array of supported MCP versions          |
| `message_encodings` | No       | Array of encodings (e.g., `json`, `jsonl`) |
| `compression`       | No       | Array of codecs (e.g., `none`, `gzip`, `zstd`) |
| `extensions`        | No       | Array of supported extension identifiers |

All fields are logically optional — a capabilities doc could be empty. The spec does not define which fields are mandatory.

### Failure modes

| Failure                      | Client behaviour                              |
|------------------------------|-----------------------------------------------|
| Not found (404)              | Assume server supports baseline MCP only      |
| Server error                 | Retry or fall back                            |
| No capabilities_url in disc. | Skip capability discovery; use defaults       |
| Malformed response           | Treat as unavailable                          |

### State transitions

```
DISCOVERED ──(capabilities fetch)──> CAPABILITIES_KNOWN
DISCOVERED ──(no capabilities_url)─> CAPABILITIES_KNOWN (baseline)
DISCOVERED ──(fetch failed)───────> CAPABILITIES_KNOWN (baseline)
CAPABILITIES_KNOWN ──(negotiate)──> NEGOTIATED
```

---

## 3. Negotiation

### Who initiates
**Client** initiates via JSON-RPC method `mcp.negotiate` after the MCP transport is established (and after `initialize` or before — see note in section 8 of the main spec).

### Contract

```
Client                          Server
  |                               |
  |-- jsonrpc: "2.0"             |
  |   method: "mcp.negotiate"    |
  |   params: {                  |
  |     versions: string[],      |
  |     encodings: string[],     |
  |     compression: string[]    |
  |   }                        ->|
  |                               |
  |<-- result: {                  |
  |     version: string,          |
  |     encoding: string,         |
  |     compression: string       |
  |   }                           |
  |                               |
  |   OR                          |
  |<-- error: {                   |
  |     code: -32601,             |
  |     message: "Method not found" |
  |   }                           |
```

### Required vs optional fields

**Request (params):**

| Field        | Required | Notes                                      |
|--------------|----------|--------------------------------------------|
| `versions`   | No       | Not explicitly stated, but implied         |
| `encodings`  | No       | Client's preferred encodings in order?     |
| `compression`| No       | Client's supported compression codecs      |

The spec doesn't explicitly state which fields are required. All three appear in the example.

**Response (result):**

| Field        | Required | Notes                                      |
|--------------|----------|--------------------------------------------|
| `version`    | Yes      | Single version selected by server          |
| `encoding`   | Yes      | Single encoding selected                   |
| `compression`| Yes      | Single compression codec selected          |

### Negotiation response shape

```typescript
interface NegotiateParams {
  versions?: string[];
  encodings?: string[];
  compression?: string[];
}

interface NegotiateResult {
  version: string;
  encoding: string;
  compression: string;
}
```

### Server selection rules (undefined)

The spec does not define how the server selects from the client's offers. Expected semantics:
- Server picks **one** value from **each** array
- Selected value SHOULD be in the client's offered list (not enforced)
- If no intersection exists, server SHOULD return an error

### Failure modes

| Failure                          | Client behaviour                              |
|----------------------------------|-----------------------------------------------|
| `-32601 Method not found`        | Server doesn't support negotiation — fall back to defaults (json, none) |
| `-32602 Invalid params`          | Bad request — retry with valid params or fall back |
| No common version/encoding/codec | Unclear — spec doesn't define error code for this |
| Timeout                          | Retry or fall back to defaults                |

### State transitions

```
CAPABILITIES_KNOWN ──(negotiate success)──> NEGOTIATED
CAPABILITIES_KNOWN ──(negotiate fail)─────> NEGOTIATED (defaults)
NEGOTIATED ──(session end)────────────────> DISCONNECTED
```

The negotiation state affects _transport encoding_ and _compression_ for all subsequent messages.

---

## 4. Authentication Discovery

### Who initiates
**Client** reads the `auth` field from the discovery document (Section 1). No separate request.

### Contract
Passive — the `auth` field is embedded in the discovery document response. No additional round-trip.

### Required vs optional fields

| Field        | Required | Notes                                      |
|--------------|----------|--------------------------------------------|
| `auth`       | No       | Entire field is optional                   |
| `auth[].type`| Yes      | One of `none`, `bearer`, `oauth2`, or custom |
| `auth[].issuer` | No    | Required for `oauth2` type                 |
| `auth[].scopes` | No    | Array of scope strings for `oauth2`        |

### Auth mechanism shapes

```typescript
interface AuthNone {
  type: "none";
}

interface AuthBearer {
  type: "bearer";
  // No additional fields specified
}

interface AuthOAuth2 {
  type: "oauth2";
  issuer: string;       // OpenID Connect issuer URL
  scopes?: string[];    // e.g., ["mcp.read", "mcp.write"]
}

type AuthMechanism = AuthNone | AuthBearer | AuthOAuth2;
```

### Client selection policy (undefined)

When multiple auth mechanisms are available:
- No priority order defined
- No way for client to communicate which it chose
- Client with bearer token might pick `bearer` over `oauth2`
- `none` alongside others is ambiguous — can the client skip auth?

### Failure modes

| Failure                          | Client behaviour                              |
|----------------------------------|-----------------------------------------------|
| All auth mechanisms fail         | Connection fails                              |
| No compatible auth type          | Connection fails                              |
| Token expired                    | Attempt refresh (OAuth) or re-authenticate    |
| Auth required but not provided   | Server returns 401 / auth error               |

### State transitions (auth-aware flow)

```
DISCOVERED ──(auth: none)─────────> AUTHENTICATED (skip)
DISCOVERED ──(auth: bearer)───────> AUTHENTICATED (with token)
DISCOVERED ──(auth: oauth2)───────> AUTH_FLOW → AUTHENTICATED
DISCOVERED ──(auth fails)─────────> AUTH_FAILED → DISCONNECTED
```

---

## 5. Execution Plans

### Who initiates
Either **client** or **server** may initiate plan execution. The spec does not specify which party sends the plan.

- **Client-initiated:** Client sends plan steps via tool calls to the server.
- **Server-initiated:** Server returns a plan to the client (e.g., as a response to a tool call) and the client executes it.
- **Transferred:** Plan is serialized to JSON and sent via some other channel.

### 5.1 Plan Object

### Contract

```typescript
interface Plan {
  type: "mcp.plan";       // literal discriminator
  version: number;        // e.g., 1
  steps: Step[];          // ordered execution steps
}
```

### Required vs optional fields

| Field     | Required | Notes                                  |
|-----------|----------|----------------------------------------|
| `type`    | Yes      | MUST be `"mcp.plan"`                   |
| `version` | Yes      | Integer plan schema version            |
| `steps`   | Yes      | Array (may be empty? see edge cases)   |

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| Invalid type                     | Reject plan                               |
| Unknown version                  | Reject (plans are not forward-compatible) |
| Malformed steps                  | Validate; reject on first invalid step    |
| Circular variable references     | Detect during validation or execution     |
| Missing referenced step ID       | Reject during validation or runtime error |

### 5.2 Tool Invocation Step

### Contract

```typescript
interface ToolStep {
  id?: string;              // for result references
  tool: string;             // tool name
  arguments?: Record<string, unknown>;
  retry?: RetryPolicy;
  on_error?: ErrorBehavior;
  approval?: ApprovalGate;
}
```

### Required vs optional fields

| Field         | Required | Notes                                      |
|---------------|----------|--------------------------------------------|
| `tool`        | Yes      | Tool name string                           |
| `arguments`   | No       | Passed as-is to the tool                   |
| `id`          | No       | Required for cross-step references         |
| `retry`       | No       | Inline retry policy                        |
| `on_error`    | No       | Error handling behaviour (default: `fail`) |
| `approval`    | No       | Human approval gate                        |

### Step discriminator problem

The spec shows `tool`-based steps and `operation: "regex"` steps as different kinds, but there's no explicit discriminator field (like `type: "tool" | "regex" | "foreach" | "parallel" | "conditional"`). The presence of `tool` vs `operation` presumably distinguishes them, but this is fragile.

### 5.3 Foreach

### Contract

```typescript
interface ForeachBlock {
  foreach: string;          // variable reference to collection
  as: string;               // iteration variable name
  parallelism?: number;     // max concurrency
  steps: Step[];            // per-iteration steps
}
```

### Required vs optional fields

| Field         | Required | Notes                                      |
|---------------|----------|--------------------------------------------|
| `foreach`     | Yes      | String variable reference (`$x.y`)         |
| `as`          | Yes      | Variable name bound each iteration         |
| `parallelism` | No       | If omitted, sequential or unbounded?       |
| `steps`       | Yes      | May be empty?                              |

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| Collection ref resolves to non-array | Type error during execution           |
| Collection ref missing           | Reference resolution error                |
| Step inside foreach fails        | Depends on per-step `on_error` policy     |
| `parallelism` exceeded           | Capped at implementation-defined max      |

### Scope rules

- `as` variable is scoped to the foreach block's steps
- Iterations should not leak the `as` variable outside
- Nested foreach with same `as` name should shadow the outer binding

### 5.4 Parallel Execution

### Contract

```typescript
interface ParallelBlock {
  parallel: Step[][];       // array of step sequences (branches)
}
```

### Required vs optional fields

| Field     | Required | Notes                                  |
|-----------|----------|----------------------------------------|
| `parallel`| Yes      | Array of arrays of steps               |

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| Empty branches array             | No-op block (valid?)                      |
| Empty branch (empty inner array) | No-op branch                              |
| Branch fails                     | Depends on per-step `on_error` policy     |
| All branches fail                | Plan-level failure if no `on_error`       |
| Partial failure (some branches)  | Result contains partial errors + successes |

### 5.5 Conditional Execution

### Contract

```typescript
interface ConditionalBlock {
  if: string;               // expression string
  then: Step[];             // steps if truthy
  else?: Step[];            // steps if falsy (optional)
}
```

### Required vs optional fields

| Field     | Required | Notes                                  |
|-----------|----------|----------------------------------------|
| `if`      | Yes      | Expression language undefined           |
| `then`    | Yes      | Executed when condition is truthy       |
| `else`    | No       | Executed when condition is falsy        |

### Expression language

The spec defers this: "SHOULD be deterministic and side-effect free" and "MUST NOT require arbitrary scripting languages." Expected expression subset:
- Literals: strings, numbers, booleans, null
- Variable references: `$x.y`
- Comparison operators: `==`, `!=`, `>`, `<`, `>=`, `<=`
- Logical operators: `&&`, `||`, `!` (or `and`, `or`, `not`)
- Parentheses for grouping

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| Invalid expression syntax        | Plan validation error                     |
| Variable in expression missing   | Expression evaluates to null/false        |
| Type mismatch (string > number)  | False or error — undefined                |
| Missing `then`                   | Plan validation error                     |

### 5.6 Retry Policy

### Contract

```typescript
interface RetryPolicy {
  attempts: number;         // max retry count (including original?)
  backoff: "fixed" | "exponential" | string;
}
```

### Required vs optional fields

| Field      | Required | Notes                                      |
|------------|----------|--------------------------------------------|
| `attempts` | Yes      | Integer, >= 1                              |
| `backoff`  | Yes      | One of `fixed`, `exponential`, or custom   |

### Inferred semantics

- `fixed`: constant delay between retries (delay not specified — use default?)
- `exponential`: delay doubles (or multiplies) each attempt (factor not specified)
- `attempts: 3` with `exponential` = original + 2 retries? Or 3 total attempts?

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| `attempts: 0`                    | Reject or treat as 1                      |
| Invalid backoff value            | Default to `fixed` or reject              |
| All retries exhausted            | Apply `on_error` behaviour                |

### 5.7 Error Handling

### Contract

```typescript
type ErrorBehavior = "fail" | "continue" | "retry";
```

### Behaviours

| Value      | Effect                                      |
|------------|---------------------------------------------|
| `fail`     | Abort the plan. Default.                    |
| `continue` | Log error, skip step, continue execution. `$step.result` undefined/null. |
| `retry`    | Apply the step's `retry` policy. If no retry configured, default to 1 retry? |

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| `on_error: "retry"` with no `retry` block | Use default retry policy (1 attempt) or error |
| Step fails and `on_error: "continue"` | Subsequent steps referencing `$step.result` get undefined |

### 5.8 Human Approval

### Contract

```typescript
interface ApprovalGate {
  message: string;          // prompt shown to human
  // No response mechanism defined
}
```

### Required vs optional fields

| Field     | Required | Notes                                  |
|-----------|----------|----------------------------------------|
| `message` | Yes      | Human-readable approval prompt          |

### Inferred execution flow

```
Plan execution
  → encounter approval gate
  → pause execution
  → show `message` to human
  → WAIT for response (no protocol defined)
  → if approved: continue
  → if denied: plan abort or skip
  → if timeout: plan abort (or configurable)
```

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| No approval mechanism available  | Plan fails (cannot proceed)               |
| Timeout waiting for response     | Plan aborts (or configurable behaviour)   |
| Human denies                     | Plan aborts (or configured fallback)      |
| Nested approvals                 | Sequential (one at a time) or parallel (all prompts shown) |

---

## 6. Tool Metadata

### Who initiates
**Server** exposes tool metadata as part of tool definitions. **Client** consumes it during tool selection.

### Contract

Tool metadata extends the existing MCP tool definition. Where it fits in the protocol is not specified, but it would logically appear in the `tools/list` response.

```typescript
interface ToolMetadata {
  side_effects?: boolean;
  idempotent?: boolean;
  requires_confirmation?: boolean;
  [key: string]: unknown;  // extensible
}
```

### Required vs optional fields

| Field                   | Required | Default | Notes                        |
|-------------------------|----------|---------|------------------------------|
| `side_effects`          | No       | `true`  | Pessimistic default          |
| `idempotent`            | No       | `false` | Pessimistic default          |
| `requires_confirmation` | No       | `false` | Pessimistic default          |

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| Missing metadata                 | Assume defaults (side_effects=true)       |
| Unknown metadata fields          | Ignored by client (extensibility)         |
| Contradictory metadata           | e.g., `side_effects: false` but has 'delete' in name — trust metadata |

---

## 7. Structured Errors

### Who initiates
**Server** returns structured errors in response to client operations, including tool calls, plan execution, and authentication.

### Contract

```typescript
interface StructuredError {
  code: string;              // stable identifier, e.g., "TOOL_AUTH_REQUIRED"
  retryable?: boolean;      // whether retry is appropriate
  retry_after?: number;     // suggested delay (format unspecified)
  details?: Record<string, unknown>;  // implementation-specific
}
```

### Required vs optional fields

| Field         | Required | Notes                                      |
|---------------|----------|--------------------------------------------|
| `code`        | Yes      | Stable, human-readable identifier          |
| `retryable`   | No       | Default: `false`?                          |
| `retry_after` | No       | Only meaningful if `retryable: true`       |
| `details`     | No       | Free-form additional info                  |

### Relationship to JSON-RPC error

Structured errors likely reside within the `data` field of a JSON-RPC error response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Tool execution failed",
    "data": {
      "code": "TOOL_AUTH_REQUIRED",
      "retryable": true,
      "retry_after": 5000,
      "details": { "tool": "send_email", "reason": "Token expired" }
    }
  }
}
```

### Failure modes

| Failure                          | Behaviour                                 |
|----------------------------------|-------------------------------------------|
| Missing `code`                   | Not a valid structured error              |
| Unknown `code`                   | Client treats as generic error            |
| `retryable: true` but no retry policy | Client may still use default retry  |

### Standard error codes (proposed — not in spec)

| Code                    | Meaning                     | Retryable |
|-------------------------|-----------------------------|-----------|
| `TOOL_NOT_FOUND`        | Requested tool doesn't exist| No        |
| `INVALID_ARGUMENTS`     | Arguments failed validation | No        |
| `AUTH_REQUIRED`         | Authentication needed       | Yes       |
| `TOKEN_EXPIRED`         | Auth token expired          | Yes       |
| `RATE_LIMITED`          | Too many requests           | Yes       |
| `TIMEOUT`               | Operation timed out         | Yes       |
| `INTERNAL_ERROR`        | Unexpected server error     | No        |
| `PLAN_VALIDATION_ERROR` | Plan failed validation      | No        |
| `APPROVAL_DENIED`       | Human rejected approval     | No        |

---

## 8. Lifecycle & State Transitions

### Basic MCP flow (existing)
```
CLOSED → CONNECTING → INITIALIZING → READY → DISCONNECTED
```

### Enhanced mcp-e flow
```
CLOSED → CONNECTING
  → DISCOVERING → DISCOVERED
    → AUTHENTICATING → AUTHENTICATED
      → CAPABILITIES_FETCHING → CAPABILITIES_KNOWN
        → NEGOTIATING → NEGOTIATED
          → INITIALIZING → READY
            → EXECUTING (tool calls / plans)
              → PLAN_PAUSED (approval gate)
              → EXECUTING (after approval)
            → RECONNECTING (on disconnect)
            → REFETCHING (stale discovery)
→ DISCONNECTED
```

### Detailed state machine

```
                    ┌──────────────────────────────────────────────┐
                    │                                              │
                    v                                              │
  CLOSED ──connect──> DISCOVERING ──success──> DISCOVERED ───────┐│
                       │    │                                      ││
                       │    └──> AUTH_FAILED ──> DISCONNECTED      ││
                       │                                           ││
                       v                                           ││
                   AUTHENTICATING ──success──> AUTHENTICATED       ││
                       │                                           ││
                       v                                           ││
                   CAPABILITIES_FETCHING ──> CAPABILITIES_KNOWN    ││
                       │                                           ││
                       v                                           ││
                   NEGOTIATING ──> NEGOTIATED                      ││
                       │                                           ││
                       v                                           ││
                   INITIALIZING ──> READY                          ││
                       │                                           ││
                       v                                           ││
                   EXECUTING ──> (plan with approval) ──> PAUSED ──┘│
                       │                  │        │               │
                       │                  └─resume─┘               │
                       │                                           │
                       v                                           │
                   DISCONNECTED ◄──────────────────────────────────┘
```

### Key transitions

| From              | To                | Trigger                                  |
|-------------------|-------------------|------------------------------------------|
| CLOSED            | DISCOVERING       | Client initiates connection              |
| DISCOVERING       | DISCOVERED        | Successful response from `/.well-known/mcp` |
| DISCOVERING       | DISCONNECTED      | Discovery fails & no manual config       |
| DISCOVERED        | AUTHENTICATING    | Auth mechanism selected (non-none)       |
| DISCOVERED        | CAPABILITIES_FETCHING | Auth=none or post-auth               |
| AUTHENTICATED     | AUTH_FAILED       | Token rejected / flow failed             |
| AUTH_FAILED       | DISCONNECTED      | No alternative auth available            |
| CAPABILITIES_FETCHING | CAPABILITIES_KNOWN | Success or fallback to baseline       |
| CAPABILITIES_KNOWN | NEGOTIATING      | Client sends `mcp.negotiate`             |
| NEGOTIATING       | NEGOTIATED        | Successful negotiation response          |
| NEGOTIATING       | NEGOTIATED        | Server returns -32601 (fallback)         |
| NEGOTIATED        | INITIALIZING      | Proceed to MCP `initialize`              |
| READY             | EXECUTING         | Tool call or plan execution starts       |
| EXECUTING         | PAUSED            | Approval gate encountered                |
| PAUSED            | EXECUTING         | Human approves                           |
| PAUSED            | DISCONNECTED      | Human denies or timeout                  |
| ANY               | DISCONNECTED      | Transport error / explicit close         |
| READY             | REFETCHING        | Stale discovery (TTL expired)            |
| REFETCHING        | DISCOVERED        | Refreshed discovery doc                  |

---

## Contract Summary Table

| Extension          | Initiator | Required fields               | Response shape                              | Failure modes                             |
|--------------------|-----------|-------------------------------|---------------------------------------------|-------------------------------------------|
| Discovery          | Client    | `mcp_version`, `endpoints`    | JSON doc                                    | 404/5xx/timeout → fallback                |
| Capability Disc.   | Client    | (none required, all optional) | JSON doc with `expression_languages`        | 404 → baseline; 5xx → baseline            |
| Negotiation        | Client    | Params optional; result: v5 fields | `NegotiateResult` (including `extensions`, `expression_language`) | -32601 → defaults; no intersection → defaults |
| Auth Discovery     | Client    | `type` within each entry      | Embedded in discovery doc                   | No compatible type → disconnect            |
| Execution Plans    | Client/Server | `kind`, `type`, `version`, `steps` | Plan object (serialized JSON)               | Invalid schema → validation error         |
| Tool Metadata      | Server    | (none, all optional)          | Extended tool definition                    | Missing → pessimistic defaults             |
| Structured Errors  | Server    | `code` (9 standard codes)     | `data` field (inline) or `mcp.error` (async) | Missing code → treated as generic error   |
| Human Approval     | Client    | `plan_id`, `step_id`, `authorized_by` | JSON-RPC `mcp.approve`/`mcp.deny`    | Timeout → denial; rejection → `APPROVAL_DENIED` |
| Expression Eval    | Client/Server | CEL default, negotiated per session | Boolean from condition evaluation       | Unsupported language → fallback to CEL     |
