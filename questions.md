# mcp-e Spec Review: Gaps, Ambiguities, Edge Cases, and Open Questions

**Spec version:** 0.1.0 (Draft)
**Review date:** 2026-06-15

Updates applied in [`decisions` branch](https://github.com/reedsutliff/mcp-e/tree/decisions):

| # | Question | Resolution |
|---|---|---|
| 1 | Step type discriminator | Added `kind` field: `tool_call`, `operation`, `foreach`, `parallel`, `conditional` |
| 2 | Condition expression language | CEL mandatory (section 2a), JSONata opt-in, sandbox optional, all negotiated |
| 3 | Structured error delivery | Inline via JSON-RPC `data`; async via `mcp.error` method |
| 4 | Human approval response | JSON-RPC `mcp.approve`/`mcp.deny` with `authorized_by` (human/policy/yolo) |
| 5 | Extension negotiation | Folded into `mcp.negotiate` params/result alongside version/encoding/compression |
| 6 | Expression language discovery | Advertised in capability document `expression_languages` field |

---

## Table of Contents

1. [Discovery](#1-discovery)
2. [Capability Discovery](#2-capability-discovery)
3. [Negotiation](#3-negotiation)
4. [Authentication Discovery](#4-authentication-discovery)
5. [Execution Plans](#5-execution-plans)
6. [Tool Metadata](#6-tool-metadata)
7. [Structured Errors](#7-structured-errors)
8. [Backward Compatibility](#8-backward-compatibility)
9. [Security Considerations](#9-security-considerations)
10. [Future Extensions](#10-future-extensions)
11. [Cross-Cutting Issues](#cross-cutting-issues)

---

## 1. Discovery

### Standard well-known URI
The spec uses `GET /.well-known/mcp` but RFC 8615 mandates `/.well-known/<resource>` with a hyphenated suffix (e.g., `/.well-known/mcp-discovery`). The dot-prefixed `mcp_version` field also conflicts with typical RFC 8615 practice of registering `/.well-known/mcp` at IANA.

- **Open question:** Should this be `/.well-known/mcp-e` or `/.well-known/mcp-config` to avoid collision with any future IANA registration?
- **Open question:** Is `.well-known` even the right mechanism for all transports? It only makes sense for HTTP(S). What about discovery for WebSocket-only or stdio servers?

### Missing cache-control semantics
No `Cache-Control`, `ETag`, or `TTL` guidance. A client could refetch the discovery document on every connection (wasteful) or cache indefinitely (stale). Server operators have no way to signal freshness.

- **Suggestion:** Add optional `cache_ttl` (seconds) field to the discovery document, or reference HTTP caching headers.

### Discovery document has no version/schema identifier
The response has `mcp_version` (the MCP protocol version the server supports), but the discovery schema itself has no version. If the schema evolves, clients cannot detect which shape to expect.

- **Open question:** Should the discovery document have its own `discovery_version` or `schema` field?

### Discovery for non-HTTP transports
The spec only shows `streamable-http` and `websocket` transports. MCP's original spec centres on **stdio** (local subprocess) which has no URL. How does a stdio server expose a `.well-known` endpoint?

- **Edge case:** A client started via CLI with `mcp run server.js` has no HTTP endpoint for discovery.
- **Open question:** Should discovery support a local-file alternative (e.g., `file:///.well-known/mcp.json` next to the server script)?

### Endpoint selection ambiguity
The `endpoints` array lists multiple transports but gives no priority, capability-restriction, or fallback semantics.

- **Open question:** If a server offers both `streamable-http` and `websocket`, how does the client choose?
- **Open question:** Can different endpoints serve different tools/resources?

### `capabilities_url` is well-known-relative?
`capabilities_url` is an absolute URL in the example. Could it be relative to the discovery root? Unclear.

- **Open question:** Should relative URLs be resolved against the discovery document's URL?

---

## 2. Capability Discovery

### Duplication with MCP's existing `initialize` handshake
MCP already has a client-server capability exchange in the `initialize` handshake (`ClientCapabilities`, `ServerCapabilities`). This section adds a separate REST endpoint for capabilities. The relationship between the two is not defined.

- **Open question:** Does capability discovery REPLACE, AUGMENT, or PRECEDE the `initialize` capabilities?
- **Conflict:** If the REST endpoint says `compression: ["zstd"]` but `initialize` says nothing about compression, which wins?

### No capability negotiation mechanism
The capabilities doc is a static advertisement; there's no way for the client to say "I support these 3 of your 5 extensions, use those."

- **Gap:** Capability advertisement is one-directional. Section 3 (Negotiation) handles version/encoding/compression, but _not_ which extensions to activate.

### No schema version
Like the discovery document, the capabilities response has no version field.

- **Gap:** Clients cannot detect breaking changes in the capabilities schema.

### `extensions` field is underspecified
`extensions: ["plans", "subscriptions", "resumable"]` — what does listing an extension mean? That the server implements the extension? That it supports a protocol version that includes it?

- **Open question:** Is there a registry of extension identifiers? Could two servers implement "plans" differently?
- **Open question:** Can an extension have its own parameters (e.g., `{"name": "plans", "max_steps": 50}`)?

### Compression is ambiguous
`compression` lists codec names, but it's not clear what level this applies to: HTTP transport encoding (`Content-Encoding`), message-level (per JSON-RPC message), or WebSocket frame compression?

- **Open question:** Is compression negotiated per-message or per-session?

### No CORS or preflight guidance
Browser-based MCP clients need CORS headers for cross-origin capability requests.

- **Gap:** Should the specification recommend `Access-Control-Allow-Origin` policies?

---

## 3. Negotiation

### Missing extension negotiation
The `mcp.negotiate` method only covers `versions`, `encodings`, and `compression`. The spec's own "extensions" concept (plans, subscriptions, resumable) cannot be negotiated through this mechanism.

- **Gap:** A client that supports plans might want to confirm the server activation before sending a plan.
- **Suggestion:** Add an `extensions` field to the negotiate params similar to how versions are negotiated.

### Server selection outside client offer
The example shows client offering `versions: ["2026-01"]` and server responding with `version: "2025-03"` — a version the client did NOT offer. This seems wrong.

- **Open question:** Should the server's response be constrained to the intersection of client-offered and server-supported? The spec doesn't say.
- **Edge case:** If server picks an encoding the client didn't list, the client may not be able to decode.

### Negotiation is stateless?
Nothing in the spec says whether negotiation changes session state or is a one-shot query.

- **Open question:** Does `mcp.negotiate` permanently set the session's encoding/compression, or is it a "capability query" that the client must then honour?
- **Open question:** Can negotiation be called mid-session? If so, what happens to in-flight messages?

### No version negotiation semantics
`versions` is an array in the request, but what does it mean? Client-supported? Client-preferred? In what order?

- **Open question:** Does the server pick the highest common version, or the client's first preference?
- **Edge case:** What if `versions` is empty? What if no intersection exists?

### Error handling beyond -32601
Only `-32601 Method not found` is given as an example. What about:
- `-32602 Invalid params` (e.g., empty array, null fields)?
- Custom errors for "no common version"?

### Relation to `initialize` version
MCP's `initialize` already negotiates protocol version. This would be a second version negotiation point — which one takes precedence?

- **Conflict:** The section 8 flow shows negotiate _after_ discover and _before_ initialize, which implies negotiation sets up parameters that `initialize` might override or conflict with.

### Default fallback undefined
"Clients MUST gracefully fall back" — to what defaults? The spec doesn't define a baseline.

- **Gap:** Should the spec define minimal defaults (e.g., encoding=json, compression=none)?

---

## 4. Authentication Discovery

### No auth selection mechanism
The `auth` array lists multiple options (e.g., `["none", "bearer", "oauth2"]`). How does the client choose?

- **Open question:** Is the first entry preferred? Last? Are they AND or OR?
- **Edge case:** If both `none` and `bearer` are listed, can the client skip auth?

### Bearer auth is underspecified
`{"type": "bearer"}` with no additional fields — where does the client get the bearer token? How is it presented? Is it an HTTP `Authorization` header? An MCP message field?

- **Gap:** No token endpoint, no credential grant type.

### OAuth2 missing client registration
The OAuth2 entry has `issuer` and `scopes` but no `client_id`, `token_endpoint`, `authorization_endpoint`, or `redirect_uris`. How does an MCP client (which may be a CLI tool or AI agent) complete an OAuth2 flow?

- **Gap:** Is the intent to use OAuth 2.0 Device Authorization Grant (RFC 8628)? Should be stated explicitly.
- **Gap:** No indication of whether the server supports refresh tokens or token expiry.

### No `api_key` auth type
Many MCP servers use API key authentication. The spec only lists `none`, `bearer`, and `oauth2`.

- **Gap:** Consider adding `api_key` as a standard auth type.

### Auth at transport vs message level
Unclear whether auth applies at the HTTP transport level (headers) or within MCP JSON-RPC messages.

- **Open question:** For WebSocket transport, how is auth presented? In the initial upgrade request?

### No auth error response format
Section 7 covers structured errors generally, but there's no specific guidance for auth failures (e.g., 401, 403 equivalents).

- **Gap:** Should there be a `TOKEN_EXPIRED` or `AUTH_REQUIRED` standard error code?

---

## 5. Execution Plans

### 5.1 Overview

### Multi-executor ambiguity
Execution Plans "MAY be executed by clients" and "MAY be executed by servers." But there's no guidance on who should execute when both are capable.

- **Open question:** If both client and server can execute plans, who decides?
- **Open question:** Can a plan be partially executed by the client and partially by the server?

### 5.2 Plan Object

### `version` type inconsistency
Plan `version` is an integer (`1`), while `mcp_version` in discovery is a string (`"2025-03"`). This inconsistency could cause confusion.

- **Open question:** Should plan version use semver or the MCP date-based scheme for consistency?

### Empty steps
The `steps` array is required but no guidance on what constitutes a valid plan. Can `steps` be empty?

- **Edge case:** `{"type": "mcp.plan", "version": 1, "steps": []}` — valid no-op plan or error?

### No plan metadata
No fields for author, description, timestamp, or execution constraints (timeout, max cost).

- **Gap:** Add optional `metadata` object for auditability.

### 5.3 Tool Invocation Step

### The `id` field is optional but critical
`id` is listed as "No" (optional), yet `$id.result` references depend on it. If a step has no `id`, it cannot be referenced.

- **Edge case:** A step without `id` that fails — how is the error reported? By index?
- **Suggestion:** Make `id` required, or define a default strategy (e.g., auto-generate `step_N`).

### No duplicate ID protection
Two steps could share the same `id`, making references ambiguous.

- **Edge case:** `{"id": "foo", ...}, {"id": "foo", ...}` — which does `$foo.result` refer to?
- **Suggestion:** MUST enforce unique IDs within a plan (or within a foreach/parallel scope).

### No server targeting
In a multi-server MCP setup, a plan step doesn't specify _which_ server provides the tool.

- **Gap:** How does a plan route tool calls to the correct server? Should steps have a `server` or `source` field?

### 5.4 Variable References

### JSONPath-like is underspecified
"Implementations SHOULD support JSONPath-like traversal" — but JSONPath has multiple flavours (Goessner, IETF RFC 9535, Jayway). No syntax is pinned.

- **Gap:** Specify the minimum supported operators (e.g., `.field`, `[n]`, `[*]`).
- **Edge case:** How are special characters in field names handled (e.g., `$step.result."weird.field"`)?

### Implicit vs explicit variables
`$step.result` references a step result, while `$var` references a "named variable." What's the scope/namespace?

- **Open question:** Can a step ID shadow a named variable?
- **Open question:** Where are named variables defined? In plan-level metadata? From external context?

### Undefined references
What happens when `$nonexistent.result` is referenced?

- **Edge case:** Should this produce a plan validation error, or a runtime error?
- **Edge case:** What about `$step.result` when the step hasn't executed yet (out-of-order evaluation)?

### 5.5 Regex Operation

### Step type ambiguity
This section defines `operation: "regex"` as a step, but 5.3 defines the step shape as `tool`+`arguments`+`id`. The regex step uses `operation`, `input`, `pattern`. This implies there are multiple step types, but the spec doesn't define a discriminator.

- **Gap:** Is `tool` vs `operation` the discriminator? What if both are present?
- **Suggestion:** Define a step type hierarchy with a `type` field for clarity (e.g., `"type": "tool_call"`, `"type": "regex"`, `"type": "foreach"`, etc.).

### Output shape
The example output shows `{"matches": ["123", "456"]}`. Is this always an array? What about named capture groups?

- **Open question:** Should named groups produce an object result instead?
- **Edge case:** No matches — empty array? Null? Error?

### No regex engine specified
Different programming languages have different regex syntaxes. Perl-compatible? ECMAScript? RE2?

- **Open question:** Should the spec recommend a minimum common subset (e.g., ECMAScript without backtracking)?

### 5.6 Foreach

### `parallelism` semantics
`"parallelism": 5` — is this a _maximum_ concurrency (pool size) or a _required_ concurrency (exactly 5)?

- **Open question:** If parallelism > number of items, does it scale down?
- **Open question:** Default parallelism if omitted? Unbounded?
- **Edge case:** `parallelism: 0` — is this valid? Should it be clamped to 1?

### Error handling inside foreach
If one iteration fails, do others continue? What's the combined error state?

- **Gap:** Should foreach accept `on_error` (inherit from steps, override, or separate policy)?

### Empty collection
If `$extract.matches` is an empty array, what happens?

- **Edge case:** Zero iterations is likely valid, but the spec should state this explicitly.

### Scope of `as` variable
The variable named by `as` (e.g., `"id"`) is available inside the foreach steps. But is it also available outside? Can it shadow step IDs?

- **Open question:** What's the scoping rule for `as` variables? Lexical? Dynamic?

### Nested foreach
Can foreach contain another foreach? What about variable shadowing?

- **Edge case:** A nested foreach with `"as": "id"` where the outer foreach also has `"as": "id"`.

### 5.7 Conditional Execution

### Condition expression language
The `if` field is a string like `"$search.count > 0"`, but there's no defined expression language syntax.

- **Gap:** What operators are supported? `>`, `<`, `==`, `!=`, `&&`, `||`, `!`? Parentheses? String comparisons?
- **Gap:** Is the condition evaluated by a JavaScript `eval`? A sandboxed expression parser? An external expression language (CEL, JSONata)?
- **Suggestion:** Reference a standard expression language or define a minimum grammar.

### Structure ambiguity
The `then` and `else` values are arrays of steps. But the conditional itself is shown as a "step" within a parent plan's `steps` array — yet it has no `id`, `tool`, or `operation` field.

- **Open question:** Is a conditional a step or a wrapper around steps? The current schema has no discriminator.

### Missing `else` branch
Is `else` required? What if only `then` is present — does execution continue on false?

- **Edge case:** `{"if": "$x", "then": [{"tool": "a"}]}` — valid? Or must `else` be present?

### 5.8 Parallel Execution

### Branch-as-array-of-steps
The `parallel` field is an array of arrays. Each inner array is a sequence of steps. But can a branch be a single step without the array wrapper?

- **Open question:** `"parallel": [{"tool": "a"}, {"tool": "b"}]` vs `"parallel": [[{"tool": "a"}], [{"tool": "b"}]]` — which is valid?

### Error aggregation
If one branch fails, do others continue? Is the overall plan failed on first error or after all branches complete?

- **Gap:** Define a failure propagation model for parallel branches.

### No timeout per branch
A long-running branch could delay completion indefinitely.

- **Gap:** Add optional `timeout` or `max_duration` per parallel branch.

### No parallelism limit
Unlike `foreach` which has `parallelism`, `parallel` has no concurrency control. For many branches, this could overwhelm resources.

- **Open question:** Should `parallel` have a `max_concurrency` or `parallelism` hint?

### 5.9 Retry Policy

### No backoff parameters
`backoff: "exponential"` — with what base? What initial delay? What max delay?

- **Gap:** Define optional parameters: `initial_delay_ms`, `max_delay_ms`, `multiplier`, `jitter`.
- **Edge case:** `attempts: 1` with `backoff: "exponential"` — degenerate but valid?

### No error filter
Retry currently applies to all errors. Not all errors are retryable.

- **Open question:** Should retry accept an `on_errors` filter (e.g., `"retryable_only": true` or a list of error codes)?

### Interaction with `on_error: "retry"`
Section 5.10 has `on_error: "retry"` as an error handling behaviour, while 5.9 has an inline `retry` policy on the tool step. This is redundant or conflicting.

- **Open question:** If both are present, which takes precedence?

### 5.10 Error Handling

### `on_error: "continue"` result semantics
If a step fails with `on_error: "continue"`, what value does `$step.result` resolve to for downstream steps? Null? An error object? The partial output?

- **Gap:** Define the result shape for failed-but-continued steps.

### `on_error: "retry"` without a retry block
What if a step has `on_error: "retry"` but no `retry` policy object?

- **Edge case:** Use default retry (1 retry? 3 retries with fixed backoff?) or error?

### Default `fail` means fail-at-step-level or plan-level?
If a step fails with default `on_error: "fail"`, does the entire plan abort immediately? Or does the step fail and the plan collects errors?

- **Open question:** Can a plan report partial results before the failing step?

### 5.11 Human Approval

### No approval response mechanism
The spec defines the approval request (`message`) but not the response. How does the human approve or deny?

- **Gap:** Define a mechanism for approval responses. Should it be a new JSON-RPC method (`mcp.approve`/`mcp.deny`)? An HTTP callback?
- **Gap:** Does approval happen out-of-band (email, UI) or in-band (MCP message back)?

### Timeout semantics
What happens if no approval response is received?

- **Edge case:** Does the plan timeout and fail? Wait indefinitely?
- **Gap:** Add optional `timeout` field to approval block.

### Nested/in-batch approval
Can approval blocks appear inside a `foreach` iteration? In a `parallel` branch? Could this cause 37 approval prompts for "Send 37 emails?"

- **Edge case:** Approval inside foreach with `parallelism: 10` — do 10 approval prompts appear simultaneously?

### Approval rejection handling
If a human denies approval, does the plan fail entirely? Continue to the next step? Trigger an `else` branch?

- **Gap:** Define rejection semantics: plan abort, skip step, or custom error handling?

---

## 6. Tool Metadata

### Where is metadata exposed?
The spec shows tool metadata as part of a tool definition, but doesn't say where. In `tools/list`? In the discovery document? In a new endpoint?

- **Gap:** Specify where and how tool metadata is communicated.
- **Suggestion:** Define it as an extension to MCP's existing `Tool` type in `tools/list` response.

### Relationship to existing MCP tool semantics
MCP already has `Tool.inputSchema`, `Tool.name`, `Tool.description`. Tool metadata adds new fields but doesn't specify if these are additions to the existing tool schema or a new separate structure.

- **Open question:** Should `metadata` be a new field on the existing MCP `Tool` type?

### `requires_confirmation` vs approval mechanism
There's overlap between `requires_confirmation: true` in tool metadata and the `approval` block in execution plans. Are these the same concept or different?

- **Open question:** If a tool has `requires_confirmation: true`, should the plan executor automatically insert an approval checkpoint? Or is it purely advisory?

### Missing metadata fields
Side effects and idempotency are useful, but there's no `rate_limit`, `cost`, `timeout_estimate`, or `deprecated` flag.

- **Suggestion:** Consider adding `timeout_ms`, `rate_limit`, `cost_estimate` as optional fields.

---

## 7. Structured Errors

### No error code registry
`code: "TOOL_AUTH_REQUIRED"` is given as an example, but there's no defined list of standard codes. Without a registry, error codes from different servers may collide or be inconsistent.

- **Gap:** Define an initial set of standard codes (e.g., `TOOL_NOT_FOUND`, `INVALID_ARGUMENTS`, `AUTH_REQUIRED`, `RATE_LIMITED`, `TIMEOUT`, `INTERNAL_ERROR`).

### `retry_after` format
`retry_after` is mentioned but no format is specified. Seconds? ISO 8601 duration? HTTP-date?

- **Gap:** Specify format (e.g., milliseconds as integer, or ISO 8601 duration string).

### Relationship to JSON-RPC errors
JSON-RPC already defines error codes (`-32700`, `-32600` to `-32603`). How do structured errors relate? Are they the `data` field of a JSON-RPC error? A replacement?

- **Open question:** Should structured errors be placed in the `data` field of a standard JSON-RPC error response?

### Error for plan execution failures
If a plan step fails, is the error returned as a structured error on the JSON-RPC response for the plan execution method, or embedded in the plan result?

- **Gap:** Define the error shape for plan execution results.

---

## 8. Backward Compatibility

### Enhanced flow vs `initialize` overlap
The enhanced flow (discover → authenticate → negotiate → initialize → use MCP) inserts three new steps before `initialize`. But MCP's `initialize` already sends version, client capabilities, and server capabilities.

- **Conflict:** If negotiation sets `version: "2025-03"` and `initialize` also negotiates version, which one takes precedence? If they disagree, what happens?
- **Suggestion:** Clarify that negotiation provides _transport-level_ parameters (encoding, compression) while `initialize` handles _protocol-level_ capabilities. If they overlap, `initialize` wins.

### Migration path for existing servers
The spec says servers "MUST continue supporting existing MCP initialization flows" and clients "MUST gracefully degrade." But there's no guidance on how an existing MCP server would add support incrementally.

- **Gap:** Could a server add just the discovery endpoint without implementing negotiation? What about plans-only without discovery?

### Client detection of mcp-e support
How does an enhanced client know whether to attempt discovery? Always try and fall back? Probe with a well-known header?

- **Open question:** Should there be an MCP extension capability field in the existing `initialize` handshake?

---

## 9. Security Considerations

### Plan injection
If plans are serialized as JSON and transferred between systems, what protects against malicious plan injection?

- **Gap:** Should plans support signing or content integrity checks?

### Recursion limits
"SHOULD impose recursion limits" — what's the recommended default? What's the limit for nested foreach/conditional/parallel?

- **Open question:** Should the spec recommend a maximum nesting depth (e.g., 5 levels)?

### Execution limits
"SHOULD enforce execution limits" — time-based? Step-count-based? Memory?

- **Gap:** Define what "execution limits" means and suggest defaults.

### Approval security
Approval checkpoints could be bypassed if a plan is modified in transit.

- **Open question:** Should there be a mechanism to make approval checkpoints tamper-evident?

### Variable reference injection
If a variable reference like `$step.result` is used in constructing arguments, can it cause argument injection attacks against tools?

- **Open question:** Should variable values be sanitized before being passed to tools?

---

## 10. Future Extensions

### No prioritization
The list of future extensions is useful but doesn't indicate which are planned for near-term vs long-term.

- **Suggestion:** Add a roadmap or prioritization indicator.

### Catalog discovery
"Catalog discovery" is listed but not defined. Is this related to server discovery or tool/resource discovery?

- **Open question:** Clarify what "catalog discovery" means in context.

---

## Cross-Cutting Issues

### No formal schema
The spec is prose + examples. There is no JSON Schema, TypeScript types, or protobuf definition.

- **Suggestion:** Provide formal schemas for the discovery document, capabilities, negotiation, execution plans, and error shapes.

### No IANA considerations
The spec introduces new media types (`application/mcp-discovery+json`), well-known URIs, and potentially new JSON-RPC methods. These typically require IANA registration or at least a considerations section.

- **Gap:** Add IANA Considerations section.

### No versioning strategy
The spec doesn't say how _this spec_ will version. Will there be a 0.2.0, 1.0.0? What constitutes a breaking change?

- **Gap:** Define a versioning policy for the spec itself.

### Inconsistent JSON formatting
Some examples use trailing commas (JSON-invalid in strict mode): `"oauth2",` followed by `"mcp.read",` — these are technically invalid JSON.

- **Minor:** Clean up example formatting to avoid confusion.

### No error code for unsupported negotiation
The spec uses `-32601 Method not found` when a server doesn't support `mcp.negotiate`. But a server that _supports_ negotiation but can't satisfy the request should return a different error.

- **Gap:** Define a `NEGOTIATION_FAILED` or `NO_COMMON_VERSION` error code.

### No concurrency model
The spec doesn't address connection lifecycle: can multiple discovery/negotiation/plan sessions run concurrently on the same transport? Does negotiation affect the transport state or the connection state?

- **Gap:** Define the concurrency and connection model.

### Testability
No conformance tests, test vectors, or implementation guide.

- **Suggestion:** Add a test suite or at minimum test vectors for execution plan parsing and variable resolution.
