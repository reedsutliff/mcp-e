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
  ]
}
```

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
    "compression": ["zstd"]
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
    "compression": "gzip"
  }
}
```

Servers that do not support negotiation SHOULD return:

```json
{
  "error": {
    "code": -32601,
    "message": "Method not found"
  }
}
```

Clients MUST gracefully fall back.

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

### 5.3 Tool Invocation Step

Example:

```json
{
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

### 5.5 Regex Operation

Plans MAY perform regex extraction.

Example:

```json
{
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

### 5.6 Foreach

Plans MAY fan out execution.

Example:

```json
{
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

### 5.7 Conditional Execution

Example:

```json
{
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

Condition syntax SHOULD be deterministic and side-effect free.

Implementations MUST NOT require arbitrary scripting languages.

---

### 5.8 Parallel Execution

Example:

```json
{
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

### 5.9 Retry Policy

Tool invocations MAY specify retry behavior.

Example:

```json
{
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

### 5.10 Error Handling

Example:

```json
{
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

### 5.11 Human Approval

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

Example:

```json
{
  "error": {
    "code": "TOOL_AUTH_REQUIRED",
    "retryable": true,
    "details": {}
  }
}
```

Suggested fields:

| Field       | Description                              |
|-------------|------------------------------------------|
| code        | Stable identifier                        |
| retryable   | Whether retry is appropriate              |
| retry_after | Suggested delay                          |
| details     | Implementation-specific information       |

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
