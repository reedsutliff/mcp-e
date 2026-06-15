# MCP Extension: Discovery, Negotiation, and Execution Plans

**Status:** Draft
**Version:** 0.1.0
**Authors:** Community Proposal
**Intended Compatibility:** Backward compatible with existing Model Context Protocol (MCP) implementations.

---

## Abstract

This specification defines optional extensions to MCP that enable:

- Automatic server discovery
- Capability negotiation
- Authentication discovery
- Transport and encoding selection
- Structured execution plans
- Deterministic orchestration primitives

These extensions are designed to preserve interoperability with existing MCP clients and servers without requiring protocol-breaking changes.

---

## Goals

This specification aims to:

- Preserve compatibility with existing MCP implementations.
- Enable zero-configuration server discovery.
- Support transport-specific configuration.
- Allow capability negotiation.
- Standardize execution plans commonly implemented by agent frameworks.
- Improve auditability and reliability.

This specification does not attempt to replace workflow engines such as Temporal, Airflow, or Durable Functions.

---

## Terminology

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" are to be interpreted as described in RFC 2119.

---

## 1. Discovery

Servers MAY expose:

```
GET /.well-known/mcp
```

Response type:

```
application/mcp-discovery+json
```

Example:

```json
{
  "mcp_version": "2025-03",

  "server_name": "Acme MCP",

  "description": "Acme integrations",

  "endpoints": [
    {
      "transport": "streamable-http",
      "url": "https://example.com/mcp"
    },
    {
      "transport": "websocket",
      "url": "wss://example.com/mcp/ws"
    }
  ],

  "capabilities_url": "https://example.com/.well-known/mcp/capabilities",

  "auth": [
    {
      "type": "none"
    }
  ]
}
```

Clients SHOULD attempt discovery before requiring manual configuration.

Failure to retrieve this document MUST NOT prevent use of manually configured MCP endpoints.

---

## 2. Capability Discovery

Servers MAY expose:

```
GET /.well-known/mcp/capabilities
```

Example:

```json
{
  "mcp_versions": [
    "2025-03",
    "2026-01"
  ],

  "message_encodings": [
    "json",
    "jsonl",
    "json-seq"
  ],

  "compression": [
    "none",
    "gzip",
    "zstd"
  ],

  "extensions": [
    "plans",
    "subscriptions",
    "resumable"
  ],

  "expression_languages": [
    "cel"
  ]
}
```

The `expression_languages` array advertises the expression languages the server
supports for plan condition evaluation. By default, this MUST only include `"cel"`
(which is mandatory for plan-supporting servers). The `"sandbox"` identifier
MUST NOT appear in this array — clients request it during negotiation as an
opt-in upgrade (see Section 2a.3).

---

## 2a. Expression Language Support

### 2a.1 CEL (Default)

All servers that advertise `"plans"` in their extensions MUST support
[Common Expression Language (CEL)](https://github.com/google/cel-spec) as the default
expression language. Condition expressions (`if`), variable references, and foreach
collection paths SHALL be evaluated using CEL unless another language is negotiated.

### 2a.2 JSONata (Opt-in)

Servers MAY also support JSONata as an expression language. Clients that prefer
JSONata SHALL indicate this during negotiation (Section 3). If a server does not
support the requested expression language, the client MUST fall back to CEL.

### 2a.3 Sandboxed JavaScript (Opt-in Upgrade)

The sandbox is an **opt-in upgrade** over CEL. Servers MUST NOT advertise `"sandbox"`
in their capability document by default — a client may only use sandboxed JavaScript
if both sides have explicitly agreed to it through the following protocol:

1. The client requests `"sandbox"` as its `expression_language` during negotiation.
2. The server confirms `"sandbox"` in the negotiation response **and** activates
   the sandbox isolation layer.
3. If the server does not support sandbox, it responds with a mutually supported
   expression language (typically `"cel"` instead).

When sandbox is active, condition expressions and inline operations MAY contain
small, sandboxed JavaScript snippets executed in an isolated environment. The
sandbox environment exposes a predefined set of variables:

| Variable            | Description                                  |
|---------------------|----------------------------------------------|
| `plan.step[n]`      | Access step result by index                  |
| `plan.step[id]`     | Access step result by step ID                |
| `plan.variables`    | Named variables in the execution context     |
| `plan.input`        | Original plan input parameters               |

Implementations MUST enforce execution timeouts, recursion limits, and memory
bounds on sandbox execution. The sandbox MUST NOT have access to: filesystem,
network sockets, environment variables, or system processes.

### 2a.4 Negotiation Priority

When a plan step has a `kind` of `"conditional"`, the executor SHALL use
the expression language negotiated at connection time (see Section 3).

| Expression Language | Negotiation | Server Requirement           |
|---------------------|-------------|------------------------------|
| CEL                 | Default     | MUST support if plans active |
| JSONata             | Client-initiated opt-in | MAY support |
| Sandboxed JS        | Client-initiated opt-in | MUST NOT advertise; client MUST explicitly request |

---



## 3. Negotiation

Clients MAY invoke:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "mcp.negotiate",
  "params": {
    "versions": ["2026-01"],
    "encodings": ["jsonl"],
    "compression": ["zstd"],
    "extensions": ["plans", "subscriptions"],
    "expression_language": "cel"
  }
}
```

Servers respond:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "version": "2025-03",
    "encoding": "jsonl",
    "compression": "gzip",
    "extensions": ["plans"],
    "expression_language": "cel"
  }
}
```

### 3.1 Negotiation Parameters

| Field               | Required | Description                                      |
|---------------------|----------|--------------------------------------------------|
| versions            | No       | Ordered list of supported MCP protocol versions  |
| encodings           | No       | Ordered list of supported message encodings      |
| compression         | No       | Ordered list of supported compression codecs     |
| extensions          | No       | Requested extension identifiers to activate       |
| expression_language | No       | Preferred expression language identifier         |

### 3.2 Selection Semantics

The server SHOULD select the highest mutually-supported value from each
client-offered list. The server MUST NOT select a value the client did not offer.
If no intersection exists for a field, the server SHOULD select a sensible default
or omit the field from the result.

### 3.3 Graceful Degradation

Servers that do not support negotiation SHOULD return:

```json
{
  "error": {
    "code": -32601,
    "message": "Method not found"
  }
}
```

Clients MUST gracefully fall back to the following defaults when negotiation
is unavailable or fails:

| Field               | Default    |
|---------------------|------------|
| version             | "2025-03"  |
| encoding            | "json"     |
| compression         | "none"     |
| extensions          | []         |
| expression_language | "cel"      |

---

## 4. Authentication Discovery

Discovery documents MAY advertise authentication mechanisms.

Example:

```json
{
  "auth": [
    {
      "type": "none"
    },
    {
      "type": "bearer"
    },
    {
      "type": "oauth2",
      "issuer": "https://login.example.com",
      "scopes": [
        "mcp.read",
        "mcp.write"
      ]
    }
  ]
}
```

OAuth implementations SHOULD reuse existing OpenID Connect discovery mechanisms.

---

## 5. Execution Plans

### 5.1 Overview

Execution Plans provide a portable, deterministic representation of multi-step operations.

Execution Plans:

- MAY be executed by clients.
- MAY be executed by servers.
- MAY be transferred between systems.
- MUST be serializable as JSON.

Execution Plans MUST NOT require arbitrary code execution.

---

### 5.2 Plan Object

A Plan SHALL have the following structure:

```json
{
  "type": "mcp.plan",
  "version": 1,
  "steps": []
}
```

Fields:

| Field   | Required | Description                |
|---------|----------|----------------------------|
| type    | Yes      | MUST equal "mcp.plan"      |
| version | Yes      | Plan schema version        |
| steps   | Yes      | Ordered execution steps    |

---

### 5.3 Step Structure

Every step in a plan SHALL have a `kind` field that explicitly identifies the
step type. This replaces reliance on implicit field presence.

| Kind           | Step Type         | Section |
|----------------|-------------------|---------|
| `"tool_call"`  | Tool invocation   | 5.4     |
| `"operation"`  | Regex, transform  | 5.6     |
| `"foreach"`    | Fan-out iteration | 5.7     |
| `"parallel"`   | Branch fan-out    | 5.9     |
| `"conditional"`| If-then-else      | 5.8     |

### 5.4 Tool Invocation Step

Example:

```json
{
  "kind": "tool_call",
  "id": "fetch",
  "tool": "search",
  "arguments": {
    "query": "foo"
  }
}
```

Fields:

| Field     | Required |
|-----------|----------|
| kind      | Yes      |
| tool      | Yes      |
| arguments | No       |
| id        | No       |

Results MAY be referenced by later steps.

---

### 5.4 Variable References

Results are referenced using "$".

Example:

```
$fetch.result
```

Examples:

| Reference            | Meaning              |
|----------------------|----------------------|
| "$step.result"       | Entire result        |
| "$step.result.items" | Nested field         |
| "$var"               | Named variable       |

Implementations SHOULD support JSONPath-like traversal.

---

### 5.6 Regex Operation

Plans MAY perform regex extraction.

Example:

```json
{
  "kind": "operation",
  "id": "extract",
  "operation": "regex",
  "input": "$fetch.result.text",
  "pattern": "ID:(\\d+)"
}
```

Output:

```json
{
  "matches": [
    "123",
    "456"
  ]
}
```

---

### 5.7 Foreach

Plans MAY fan out execution.

Example:

```json
{
  "kind": "foreach",
  "foreach": "$extract.matches",
  "as": "id",
  "parallelism": 5,

  "steps": [
    {
      "tool": "lookup",
      "arguments": {
        "id": "$id"
      }
    }
  ]
}
```

Behavior:

- The referenced collection SHALL be enumerated.
- Each iteration SHALL bind the variable specified by "as".
- Iterations MAY execute concurrently.

---

### 5.8 Conditional Execution

Example:

```json
{
  "kind": "conditional",
  "if": "$search.count > 0",

  "then": [
    {
      "tool": "update_customer"
    }
  ],

  "else": [
    {
      "tool": "create_customer"
    }
  ]
}
```

Condition expressions SHALL use the negotiated expression language (CEL by
default; see Sections 2a and 3). The expression MUST be deterministic and
side-effect free. Implementations MUST NOT require arbitrary scripting languages
unless the `"sandbox"` expression language has been negotiated, in which case
sandbox restrictions (Section 2a.3) SHALL apply.

---

### 5.9 Parallel Execution

Example:

```json
{
  "kind": "parallel",
  "parallel": [
    [
      {
        "tool": "calendar"
      }
    ],

    [
      {
        "tool": "email"
      }
    ]
  ]
}
```

Behavior:

- Branches MAY execute simultaneously.
- Completion SHALL occur after all branches finish.

---

### 5.10 Retry Policy

Tool invocations MAY specify retry behavior.

Example:

```json
{
  "kind": "tool_call",
  "tool": "fetch",
  "retry": {
    "attempts": 3,
    "backoff": "exponential"
  }
}
```

Supported backoff values:

- fixed
- exponential

---

### 5.11 Error Handling

Example:

```json
{
  "kind": "tool_call",
  "tool": "lookup",
  "on_error": "continue"
}
```

Supported behaviors:

| Value    | Meaning            |
|----------|--------------------|
| fail     | Abort plan         |
| continue | Continue execution |
| retry    | Apply retry policy |

Default: `fail`

---

### 5.12 Human Approval

Execution MAY pause awaiting approval.

Example:

```json
{
  "approval": {
    "message": "Send 37 emails?"
  }
}
```

Executors SHOULD expose an approval mechanism appropriate to their environment.

#### 5.12.1 Approval Response

When an approval gate is triggered, the executor SHALL suspend plan execution
and surface the approval request. A human or policy mechanism responds via
the `mcp.approve` and `mcp.deny` JSON-RPC methods:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "mcp.approve",
  "params": {
    "plan_id": "plan-abc-123",
    "step_id": "email-batch",
    "authorized_by": "human"
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "mcp.deny",
  "params": {
    "plan_id": "plan-abc-123",
    "step_id": "email-batch",
    "authorized_by": "human",
    "reason": "Too many emails"
  }
}
```

#### 5.12.2 Authorized By

The `authorized_by` field SHALL indicate the source of the approval decision:

| Value     | Meaning                                                   |
|-----------|-----------------------------------------------------------|
| `"human"` | Explicit human consent (click, confirm, voice)            |
| `"policy"`| Automated rule or policy (e.g., "auto-approve < 10 items")|
| `"yolo"`  | Pre-configured blanket approval mode on the client        |

Implementations MAY define additional `authorized_by` values.

#### 5.12.3 Timeout

Implementations SHOULD support an optional `timeout` field on the approval block.
If no approval response is received within the timeout window, the executor SHALL
treat it as a denial and fail the step unless `on_error` specifies otherwise.

```json
{
  "approval": {
    "message": "Send 37 emails?",
    "timeout_ms": 300000
  }
}
```

#### 5.12.4 Rejection Handling

If a human denies approval:

- The step SHALL fail with error code `APPROVAL_DENIED`.
- If `on_error` is set on the step, it SHALL be honoured (e.g., `on_error: "continue"` skips the step).
- If no `on_error` is set, the default (`fail`) SHALL abort the plan.

---

## 6. Tool Metadata

Tools MAY expose execution characteristics.

Example:

```json
{
  "name": "send_email",

  "metadata": {
    "side_effects": true,
    "idempotent": false,
    "requires_confirmation": true
  }
}
```

Defined metadata:

| Field                | Description                    |
|----------------------|--------------------------------|
| side_effects         | External state changes         |
| idempotent           | Safe to retry                  |
| requires_confirmation | Human approval recommended     |

Additional fields MAY be defined.

---

## 7. Structured Errors

Implementations MAY provide structured error information.

### 7.1 Inline (Request-Response)

For JSON-RPC request-response flows, structured errors SHOULD be placed in the
`data` field of a standard JSON-RPC error object:

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
      "details": {}
    }
  }
}
```

### 7.2 Async (Streaming / Notifications)

For streaming or asynchronous error delivery, implementations MAY use the
`mcp.error` JSON-RPC method to deliver structured errors out-of-band:

```json
{
  "jsonrpc": "2.0",
  "method": "mcp.error",
  "params": {
    "request_id": "req-42",
    "code": "TOOL_AUTH_REQUIRED",
    "retryable": true,
    "retry_after": 5000,
    "details": {}
  }
}
```

### 7.3 Error Fields

Suggested fields:|

| Field       | Description                              |
|-------------|------------------------------------------|
| code        | Stable identifier                        |
| retryable   | Whether retry is appropriate             |
| retry_after | Suggested delay in milliseconds          |
| details     | Implementation-specific information       |

### 7.4 Standard Error Codes

The following error codes SHOULD be recognised:

| Code                     | Description                    | Retryable |
|--------------------------|--------------------------------|-----------|
| `TOOL_NOT_FOUND`         | Referenced tool does not exist | false     |
| `INVALID_ARGUMENTS`      | Tool arguments failed validation| false    |
| `AUTH_REQUIRED`          | Authentication needed          | false     |
| `TOKEN_EXPIRED`          | Bearer/oauth token expired     | true      |
| `RATE_LIMITED`           | Server rate limit exceeded     | true      |
| `TIMEOUT`                | Tool execution timed out       | true      |
| `INTERNAL_ERROR`         | Unspecified server error       | false     |
| `APPROVAL_DENIED`        | Human or policy denied approval| false     |
| `PLAN_VALIDATION_FAILED` | Plan failed schema validation  | false     |

Implementations MAY define additional error codes.

---

## 8. Backward Compatibility

Existing MCP clients:

```
connect
↓
initialize
↓
use MCP
```

Enhanced clients:

```
discover
↓
authenticate
↓
negotiate
↓
initialize
↓
use MCP
```

Servers implementing this specification MUST continue supporting existing MCP initialization flows.

Clients implementing this specification MUST gracefully degrade when extensions are unavailable.

---

## 9. Security Considerations

Execution Plan implementations:

- MUST NOT execute arbitrary code.
- SHOULD validate plan schemas.
- SHOULD enforce execution limits.
- SHOULD impose recursion limits.
- SHOULD bound parallel execution.
- SHOULD surface approval checkpoints for high-risk operations.

Regex implementations SHOULD protect against catastrophic backtracking.

Authentication mechanisms SHOULD follow established best practices.

---

## 10. Future Extensions

Potential future extensions include:

- Subscriptions
- Session resumption
- Sequence numbers
- Rate limit discovery
- Cost estimation
- Capability scopes
- Signed capability documents
- Catalog discovery

These features are intentionally excluded from this specification to preserve simplicity.
