/**
 * mcp-e Execution Plan: Parser, validator, and executor skeleton.
 *
 * Implements the execution plan specification:
 * - Plan parsing and structural validation
 * - Variable reference resolution with JSONPath-like traversal
 * - Step execution with foreach, parallel, conditional, retry, and approval
 * - Plan metadata extraction
 *
 * @packageDocumentation
 */

import type {
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
} from "./types";

// ============================================================================
// Plan Validator
// ============================================================================

/**
 * Validates an execution plan's structure before execution.
 *
 * Checks:
 * - Required fields are present
 * - Step structure is well-formed
 * - IDs are unique within scope
 * - Variable references are syntactically valid
 * - Retry policies are valid
 * - Recursion depth does not exceed limits
 */
export class PlanValidator {
  private readonly maxDepth: number;
  private readonly maxSteps: number;

  constructor(options?: { maxDepth?: number; maxSteps?: number }) {
    this.maxDepth = options?.maxDepth ?? 10;
    this.maxSteps = options?.maxSteps ?? 1000;
  }

  /**
   * Validate a complete plan.
   *
   * @param plan - The plan to validate.
   * @returns Validation result with errors (if any) and computed metadata.
   */
  validate(plan: unknown): PlanValidationResult {
    const errors: PlanValidationError[] = [];

    // Top-level type check
    if (!plan || typeof plan !== "object") {
      errors.push({
        path: "",
        message: "Plan must be a non-null object",
        severity: "error",
      });
      return { valid: false, errors };
    }

    const p = plan as Record<string, unknown>;

    // Required: type === "mcp.plan"
    if (p.type !== "mcp.plan") {
      errors.push({
        path: "type",
        message: `Expected "mcp.plan", got "${String(p.type)}"`,
        severity: "error",
      });
    }

    // Required: version (number)
    if (typeof p.version !== "number" || p.version < 1) {
      errors.push({
        path: "version",
        message: "Plan version must be a positive integer",
        severity: "error",
      });
    }

    // Required: steps (array)
    if (!Array.isArray(p.steps)) {
      errors.push({
        path: "steps",
        message: "Steps must be an array",
        severity: "error",
      });
      // Cannot continue validation without steps
      return { valid: errors.length === 0, errors };
    }

    // Validate each step recursively
    const ids = new Set<string>();
    const metadata = this.computeMetadata(plan as Plan);

    if (metadata.totalSteps > this.maxSteps) {
      errors.push({
        path: "steps",
        message: `Plan exceeds maximum step count: ${metadata.totalSteps} > ${this.maxSteps}`,
        severity: "error",
      });
    }

    this.validateSteps(p.steps as Step[], "steps", errors, ids, 0);

    return {
      valid: errors.filter((e) => e.severity === "error").length === 0,
      errors,
      metadata,
    };
  }

  /**
   * Recursively validate an array of steps.
   */
  private validateSteps(
    steps: Step[],
    path: string,
    errors: PlanValidationError[],
    ids: Set<string>,
    depth: number
  ): void {
    if (depth > this.maxDepth) {
      errors.push({
        path,
        message: `Maximum nesting depth (${this.maxDepth}) exceeded`,
        severity: "error",
      });
      return;
    }

    steps.forEach((step, index) => {
      const stepPath = `${path}[${index}]`;

      if (!step || typeof step !== "object") {
        errors.push({
          path: stepPath,
          message: "Step must be a non-null object",
          severity: "error",
        });
        return;
      }

      // Check for duplicate IDs
      const s = step as Record<string, unknown>;
      if (s.id && typeof s.id === "string") {
        if (ids.has(s.id)) {
          errors.push({
            path: `${stepPath}.id`,
            message: `Duplicate step ID: "${s.id}"`,
            severity: "error",
          });
        }
        ids.add(s.id);
      }

      // Validate using `kind` discriminator when present, fall back to
      // field detection for backward compatibility
      const kind = typeof s.kind === "string" ? (s.kind as string) : null;

      if (kind === "tool_call" || (!kind && typeof s.tool === "string")) {
        // ToolStep validation
        if (s.retry) {
          this.validateRetryPolicy(s.retry as RetryPolicy, `${stepPath}.retry`, errors);
        }
        if (s.on_error && !["fail", "continue", "retry"].includes(s.on_error as string)) {
          errors.push({
            path: `${stepPath}.on_error`,
            message: `Invalid on_error value: "${String(s.on_error)}"`,
            severity: "error",
          });
        }
      } else if (kind === "foreach" || (!kind && typeof s.foreach === "string")) {
        // ForeachBlock validation
        if (typeof s.as !== "string") {
          errors.push({
            path: `${stepPath}.as`,
            message: "Foreach block requires a string 'as' field",
            severity: "error",
          });
        }
        if (Array.isArray(s.steps)) {
          this.validateSteps(s.steps as Step[], `${stepPath}.steps`, errors, ids, depth + 1);
        } else {
          errors.push({
            path: `${stepPath}.steps`,
            message: "Foreach block requires a steps array",
            severity: "error",
          });
        }
      } else if (kind === "parallel" || (!kind && typeof s.parallel !== "undefined")) {
        // ParallelBlock validation
        if (!Array.isArray(s.parallel)) {
          errors.push({
            path: `${stepPath}.parallel`,
            message: "Parallel must be an array of step arrays",
            severity: "error",
          });
        } else {
          (s.parallel as unknown[][]).forEach((branch, bIndex) => {
            if (!Array.isArray(branch)) {
              errors.push({
                path: `${stepPath}.parallel[${bIndex}]`,
                message: "Each parallel branch must be an array of steps",
                severity: "error",
              });
            } else {
              this.validateSteps(
                branch as Step[],
                `${stepPath}.parallel[${bIndex}]`,
                errors,
                ids,
                depth + 1
              );
            }
          });
        }
      } else if (kind === "conditional" || (!kind && typeof s.if === "string")) {
        // ConditionalBlock validation
        if (!Array.isArray((s as unknown as ConditionalBlock).then)) {
          errors.push({
            path: `${stepPath}.then`,
            message: "Conditional block requires a 'then' array of steps",
            severity: "error",
          });
        } else {
          this.validateSteps(
            (s as unknown as ConditionalBlock).then,
            `${stepPath}.then`,
            errors,
            ids,
            depth + 1
          );
        }
        if (s.else && Array.isArray(s.else)) {
          this.validateSteps(
            (s as unknown as ConditionalBlock).else!,
            `${stepPath}.else`,
            errors,
            ids,
            depth + 1
          );
        }
      } else if (kind === "operation" || (!kind && typeof s.operation === "string")) {
        // OperationStep — accepts variable references
        this.validateVariableReference(s.input as string | undefined, `${stepPath}.input`, errors);
      }
      // else: unknown step type — lenient, skip validation
    });
  }

  /**
   * Validate a retry policy.
   */
  private validateRetryPolicy(
    policy: RetryPolicy,
    path: string,
    errors: PlanValidationError[]
  ): void {
    if (typeof policy.attempts !== "number" || policy.attempts < 1) {
      errors.push({
        path,
        message: "Retry attempts must be >= 1",
        severity: "error",
      });
    }
    if (!["fixed", "exponential"].includes(policy.backoff)) {
      errors.push({
        path: `${path}.backoff`,
        message: `Unknown backoff strategy: "${policy.backoff}"`,
        severity: "warning",
      });
    }
  }

  /**
   * Basic variable reference syntax validation.
   */
  private validateVariableReference(
    ref: string | undefined,
    path: string,
    errors: PlanValidationError[]
  ): void {
    if (ref === undefined || ref === null) {
      return; // Optional
    }
    if (typeof ref !== "string") {
      errors.push({
        path,
        message: "Variable reference must be a string",
        severity: "error",
      });
      return;
    }
  }

  /**
   * Compute metadata for a plan (step count, nesting depth, etc.).
   */
  computeMetadata(plan: Plan): PlanMetadata {
    const toolsUsed = new Set<string>();
    let approvalCount = 0;
    let hasParallel = false;
    let hasForeach = false;
    let hasConditionals = false;
    let maxDepth = 0;

    function walk(steps: Step[], depth: number): number {
      let count = 0;
      maxDepth = Math.max(maxDepth, depth);

      for (const step of steps) {
        count++;

        if ("tool" in step && typeof step.tool === "string") {
          toolsUsed.add(step.tool);
        }

        if ("approval" in step && step.approval) {
          approvalCount++;
        }

        if ("foreach" in step) {
          hasForeach = true;
          count += walk((step as ForeachBlock).steps, depth + 1);
        }

        if ("parallel" in step) {
          hasParallel = true;
          for (const branch of (step as ParallelBlock).parallel) {
            count += walk(branch, depth + 1);
          }
        }

        if ("if" in step) {
          hasConditionals = true;
          count += walk((step as ConditionalBlock).then, depth + 1);
          if ((step as ConditionalBlock).else) {
            count += walk((step as ConditionalBlock).else!, depth + 1);
          }
        }
      }

      return count;
    }

    const totalSteps = walk(plan.steps, 0);

    return {
      totalSteps,
      maxDepth,
      approvalCount,
      hasParallel,
      hasForeach,
      hasConditionals,
      toolsUsed,
    };
  }
}

// ============================================================================
// Variable Reference Resolver
// ============================================================================

/**
 * Resolves variable references of the form `$step.result[.nested.field]`
 * against the execution context.
 *
 * Supports JSONPath-like traversal:
 * - `$step.result` — fetch step result by ID
 * - `$step.result.items` — nested field access
 * - `$step.result[0]` — array index access
 * - `$var` — named variable from context
 */
export class VariableResolver {
  /**
   * Resolve a variable reference string against the execution context.
   *
   * Syntax:
   * ```
   * reference ::= "$" ( step_ref | var_ref ) ( "." path )*
   * step_ref  ::= <step_id> ".result"
   * var_ref   ::= <variable_name>
   * path      ::= <identifier> | "[" <index> "]"
   * ```
   *
   * @param ref - The reference string (e.g., "$fetch.result", "$extract.matches[0]").
   * @param context - The current execution context.
   * @returns The resolved value, or null if unresolvable.
   */
  resolve(ref: string, context: PlanExecutionContext): unknown {
    if (!ref.startsWith("$")) {
      return ref; // Not a variable reference — return as-is
    }

    const path = ref.slice(1); // Remove leading "$"

    // Split into segments (dot-separated)
    const segments = this.tokenize(path);

    if (segments.length === 0) {
      return null;
    }

    // First segment: step ID or variable name
    let current: unknown;

    // Check if first segment ends with ".result" → step reference
    if (segments.length >= 2 && segments[1] === "result") {
      const stepId = segments[0];
      current = context.results.get(stepId);
      segments.splice(0, 2); // consume "stepId.result"
    } else {
      // Named variable
      const varName = segments[0];
      current = context.variables.get(varName) ?? context.loopVars.get(varName);
      segments.splice(0, 1); // consume variable name
    }

    // Traverse remaining segments as nested paths
    for (const segment of segments) {
      if (current == null) {
        return null; // Short-circuit on null/undefined
      }

      if (this.isArrayIndex(segment)) {
        // Array index access: [0], [1], etc.
        const index = parseInt(segment.slice(1, -1), 10);
        if (Array.isArray(current)) {
          current = current[index];
        } else {
          return null;
        }
      } else if (typeof current === "object" && current !== null) {
        // Object field access
        current = (current as Record<string, unknown>)[segment];
      } else {
        return null;
      }
    }

    return current;
  }

  /**
   * Simple path tokenizer that splits on dots and detects array indices.
   */
  private tokenize(path: string): string[] {
    const segments: string[] = [];
    let current = "";

    for (let i = 0; i < path.length; i++) {
      const ch = path[i];

      if (ch === ".") {
        if (current.length > 0) {
          segments.push(current);
          current = "";
        }
        // Skip consecutive dots
      } else {
        current += ch;
      }
    }

    if (current.length > 0) {
      segments.push(current);
    }

    return segments;
  }

  /**
   * Checks if a string looks like an array index accessor (e.g., "[0]", "[42]").
   */
  private isArrayIndex(segment: string): boolean {
    return /^\[\d+\]$/.test(segment);
  }
}

// ============================================================================
// Expression Evaluator (for conditionals)
// ============================================================================

/**
 * Evaluates condition expressions of the form `$search.count > 0`.
 *
 * Supports a limited, deterministic expression language:
 * - Variable references: `$x.y`
 * - Literals: numbers, strings (double-quoted), booleans, null
 * - Comparison: `==`, `!=`, `>`, `<`, `>=`, `<=`
 * - Logical: `&&`, `||`, `!`
 * - Parentheses for grouping
 */
// ============================================================================
// Plan Executor
// ============================================================================

/**
 * Configuration for the plan executor.
 */
export interface PlanExecutorOptions {
  /** Maximum concurrency for foreach blocks (default: infinity). */
  maxParallelism?: number;

  /** Whether to pause on approval gates (default: true). */
  enableApproval?: boolean;

  /** Callback invoked when an approval gate is encountered. */
  onApproval?: (gate: ApprovalGate) => Promise<boolean>;

  /** Callback invoked when a step completes. */
  onStepComplete?: (stepId: string | undefined, result: unknown) => void;

  /** Callback invoked when a step fails. */
  onStepError?: (stepId: string | undefined, error: PlanExecutionError) => void;

  /**
   * Function to execute a tool call.
   * This is how the executor bridges to the actual MCP tool invocation.
   */
  executeTool: (
    tool: string,
    args: Record<string, unknown> | undefined
  ) => Promise<unknown>;

  /** Maximum execution time for the entire plan (ms). */
  timeoutMs?: number;
}

/**
 * Execution plan executor.
 *
 * Processes a plan's steps in order, handling:
 * - Tool invocations with argument interpolation
 * - Foreach fan-out with configurable parallelism
 * - Parallel branch execution
 * - Conditional branching
 * - Retry policies with backoff
 * - Error handling (fail/continue/retry)
 * - Human approval gates
 * - Variable reference resolution
 */
export class PlanExecutor {
  private readonly options: Required<PlanExecutorOptions>;
  private readonly resolver: VariableResolver;
  private readonly expressionEvaluator: ExpressionEvaluator;

  constructor(options: PlanExecutorOptions) {
    this.options = {
      maxParallelism: 10,
      enableApproval: true,
      onApproval: async () => true, // Auto-approve if no callback
      onStepComplete: () => {},
      onStepError: () => {},
      timeoutMs: 300_000,
      ...options,
    };
    this.resolver = new VariableResolver();
    this.expressionEvaluator = new ExpressionEvaluator();
  }

  /**
   * Execute a plan from start to finish.
   *
   * Flow:
   * 1. Validate the plan
   * 2. Create an execution context
   * 3. Execute top-level steps sequentially
   * 4. Return aggregated results
   *
   * @param plan - The plan to execute.
   * @returns The execution result.
   */
  async execute(plan: Plan): Promise<PlanExecutionResult> {
    const startTime = Date.now();

    // Create execution context
    const context: PlanExecutionContext = {
      results: new Map(),
      variables: new Map(),
      loopVars: new Map(),
      paused: false,
    };

    try {
      // Execute steps sequentially (top-level)
      for (const step of plan.steps) {
        await this.executeStep(step, context);
      }

      return {
        success: true,
        outputs: Object.fromEntries(context.results),
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const error = err as PlanExecutionError;
      return {
        success: false,
        outputs: Object.fromEntries(context.results),
        error,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a single step, dispatching to the correct handler based on type.
   */
  private async executeStep(
    step: Step,
    context: PlanExecutionContext
  ): Promise<void> {
    // Use `kind` discriminator, fall back to field detection
    const kind = "kind" in step ? (step as Record<string, unknown>).kind : undefined;

    if (kind === "tool_call" || (kind === undefined && "tool" in step && typeof (step as ToolStep).tool === "string")) {
      await this.executeToolStep(step as ToolStep, context);
    } else if (kind === "foreach" || (kind === undefined && "foreach" in step)) {
      await this.executeForeachBlock(step as ForeachBlock, context);
    } else if (kind === "parallel" || (kind === undefined && "parallel" in step)) {
      await this.executeParallelBlock(step as ParallelBlock, context);
    } else if (kind === "conditional" || (kind === undefined && "if" in step)) {
      await this.executeConditionalBlock(step as ConditionalBlock, context);
    } else if (kind === "operation" || (kind === undefined && "operation" in step && typeof (step as OperationStep).operation === "string")) {
      await this.executeOperationStep(step as OperationStep, context);
    } else {
      throw this.makeError("UNKNOWN_STEP", `Unknown step type`, undefined);
    }
  }

  /**
   * Execute a tool invocation step.
   *
   * Flow:
   * 1. Check for approval gate
   * 2. Interpolate variable references in arguments
   * 3. Execute the tool (with retry if configured)
   * 4. Store result in context
   */
  private async executeToolStep(
    step: ToolStep,
    context: PlanExecutionContext
  ): Promise<void> {
    // Check approval gate
    if (step.approval) {
      await this.handleApproval(step.approval, context, step.id);
    }

    const errorBehavior = step.on_error ?? "fail";

    try {
      // Resolve variable references in arguments
      const resolvedArgs = step.arguments
        ? this.resolveArguments(step.arguments, context)
        : undefined;

      // Execute with retry policy
      const result = await this.executeWithRetry(
        step.tool,
        resolvedArgs,
        step.retry,
        context
      );

      // Store result
      if (step.id) {
        context.results.set(step.id, result);
      }

      this.options.onStepComplete(step.id, result);
    } catch (err) {
      const planError = this.normalizeError(err, step.id);

      this.options.onStepError(step.id, planError);

      switch (errorBehavior) {
        case "continue":
          // Skip this step, continue execution
          if (step.id) {
            context.results.set(step.id, null);
          }
          break;
        case "retry":
          // Attempt retry (with default policy if none configured)
          try {
            const retryPolicy = step.retry ?? { attempts: 2, backoff: "fixed" };
            const result = await this.executeWithRetry(
              step.tool,
              this.resolveArguments(step.arguments ?? {}, context),
              retryPolicy,
              context
            );
            if (step.id) {
              context.results.set(step.id, result);
            }
          } catch (retryErr) {
            throw this.normalizeError(retryErr, step.id);
          }
          break;
        case "fail":
        default:
          throw planError;
      }
    }
  }

  /**
   * Execute a tool with retry logic.
   */
  private async executeWithRetry(
    tool: string,
    args: Record<string, unknown> | undefined,
    retryPolicy: RetryPolicy | undefined,
    _context: PlanExecutionContext
  ): Promise<unknown> {
    const maxAttempts = retryPolicy?.attempts ?? 1;
    const backoff = retryPolicy?.backoff ?? "fixed";
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.options.executeTool(tool, args);
      } catch (err) {
        lastError = err;

        if (attempt < maxAttempts) {
          // Calculate delay
          const delayMs =
            backoff === "exponential"
              ? Math.min(1000 * Math.pow(2, attempt - 1), 30_000)
              : 1000;

          await this.delay(delayMs);
        }
      }
    }

    throw lastError;
  }

  /**
   * Execute a foreach block.
   *
   * Flow:
   * 1. Resolve the collection reference
   * 2. Validate it's an array
   * 3. Iterate with bounded concurrency
   * 4. Execute per-iteration steps
   */
  private async executeForeachBlock(
    block: ForeachBlock,
    context: PlanExecutionContext
  ): Promise<void> {
    const collection = this.resolver.resolve(
      block.foreach,
      context
    );

    if (!Array.isArray(collection)) {
      if (block.on_error === "continue") {
        return;
      }
      throw this.makeError(
        "FOREACH_TYPE_ERROR",
        `Expected array for foreach, got ${typeof collection}`,
        block.id
      );
    }

    const parallelism = Math.min(
      block.parallelism ?? collection.length,
      this.options.maxParallelism
    );
    const results: unknown[] = [];

    if (parallelism <= 1) {
      // Sequential execution
      for (const item of collection) {
        const iterationResult = await this.executeForeachIteration(
          block, item, context
        );
        results.push(iterationResult);
      }
    } else {
      // Concurrent execution with bounded parallelism
      const iterator = collection.entries();
      const workers: Promise<void>[] = [];

      for (let i = 0; i < parallelism; i++) {
        workers.push(this.foreachWorker(block, iterator, context, results));
      }

      await Promise.all(workers);
    }

    if (block.id) {
      context.results.set(block.id, results);
    }
  }

  /**
   * Worker for concurrent foreach execution.
   */
  private async foreachWorker(
    block: ForeachBlock,
    iterator: IterableIterator<[number, unknown]>,
    context: PlanExecutionContext,
    results: unknown[]
  ): Promise<void> {
    for (const [index, item] of iterator) {
      const iterationResult = await this.executeForeachIteration(
        block, item, context
      );
      results[index] = iterationResult;
    }
  }

  /**
   * Execute a single foreach iteration.
   */
  private async executeForeachIteration(
    block: ForeachBlock,
    item: unknown,
    outerContext: PlanExecutionContext
  ): Promise<unknown> {
    // Create a child context with the iteration variable bound
    const iterationContext: PlanExecutionContext = {
      ...outerContext,
      loopVars: new Map(outerContext.loopVars).set(block.as, item),
    };

    const iterationResults: Record<string, unknown> = {};

    for (const step of block.steps) {
      await this.executeStep(step, iterationContext);
    }

    return iterationResults;
  }

  /**
   * Execute a parallel block.
   *
   * All branches execute concurrently; the block completes when all
   * branches have finished.
   */
  private async executeParallelBlock(
    block: ParallelBlock,
    context: PlanExecutionContext
  ): Promise<void> {
    const branchResults = await Promise.allSettled(
      block.parallel.map(async (branch, index) => {
        const branchContext: PlanExecutionContext = {
          ...context,
          results: new Map(context.results),
          variables: new Map(context.variables),
          loopVars: new Map(context.loopVars),
        };

        for (const step of branch) {
          await this.executeStep(step, branchContext);
        }

        return Object.fromEntries(branchContext.results);
      })
    );

    const result: Record<string, unknown> = {};
    const errors: PlanExecutionError[] = [];

    branchResults.forEach((branchResult, index) => {
      if (branchResult.status === "fulfilled") {
        result[`branch_${index}`] = branchResult.value;
      } else {
        const error = this.normalizeError(branchResult.reason, `branch_${index}`);
        errors.push(error);
        result[`branch_${index}`] = { error: error.message };
      }
    });

    if (block.id) {
      const blockResult = { branches: result, errors: errors.length > 0 ? errors : undefined };
      context.results.set(block.id, blockResult);
    }

    // If all branches failed and error behavior is "fail", propagate
    if (
      errors.length === block.parallel.length &&
      block.on_error !== "continue"
    ) {
      throw errors[0];
    }
  }

  /**
   * Execute a conditional block.
   */
  private async executeConditionalBlock(
    block: ConditionalBlock,
    context: PlanExecutionContext
  ): Promise<void> {
    const conditionResult = this.expressionEvaluator.evaluateCondition(
      block.if,
      context
    );

    const stepsToExecute = conditionResult ? block.then : block.else;

    if (!stepsToExecute) {
      return; // No else branch, condition is false
    }

    for (const step of stepsToExecute) {
      await this.executeStep(step, context);
    }
  }

  /**
   * Execute an operation step (e.g., regex extraction).
   */
  private async executeOperationStep(
    step: OperationStep,
    context: PlanExecutionContext
  ): Promise<void> {
    switch (step.operation) {
      case "regex": {
        const input = step.input
          ? this.resolver.resolve(step.input, context)
          : null;

        if (typeof input !== "string") {
          if (step.id) {
            context.results.set(step.id, { matches: [] });
          }
          return;
        }

        const pattern = step.pattern as string | undefined;
        if (!pattern) {
          throw this.makeError("REGEX_ERROR", "No pattern provided", step.id);
        }

        // Placeholder: a real implementation would use a safe regex engine
        // with protection against catastrophic backtracking.
        const regex = new RegExp(pattern, "g");
        const matches: string[] = [];
        let match: RegExpExecArray | null;

        while ((match = regex.exec(input)) !== null) {
          matches.push(match[1] ?? match[0]);
        }

        const result: RegexOperationResult = { matches };
        if (step.id) {
          context.results.set(step.id, result);
        }
        break;
      }

      default:
        throw this.makeError(
          "UNKNOWN_OPERATION",
          `Unknown operation: "${step.operation}"`,
          step.id
        );
    }
  }

  /**
   * Handle an approval gate.
   *
   * Pauses execution and invokes the approval callback.
   * If the callback is not configured, auto-approves.
   */
  private async handleApproval(
    gate: ApprovalGate,
    context: PlanExecutionContext,
    stepId?: string
  ): Promise<void> {
    if (!this.options.enableApproval) {
      return; // Approval disabled — skip
    }

    context.paused = true;
    context.pendingApproval = { ...gate, step_id: stepId ?? "unknown" };

    try {
      const approved = await this.options.onApproval(gate);
      if (!approved) {
        throw this.makeError(
          "APPROVAL_DENIED",
          `Approval denied: ${gate.message}`,
          undefined
        );
      }
    } finally {
      context.paused = false;
      context.pendingApproval = undefined;
    }
  }

  /**
   * Resolve variable references in tool arguments.
   * Walks the arguments object and resolves any `$xxx` strings.
   */
  private resolveArguments(
    args: Record<string, unknown>,
    context: PlanExecutionContext
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && value.startsWith("$")) {
        resolved[key] = this.resolver.resolve(value, context);
      } else if (Array.isArray(value)) {
        resolved[key] = value.map((v) =>
          typeof v === "string" && v.startsWith("$")
            ? this.resolver.resolve(v, context)
            : v
        );
      } else if (typeof value === "object" && value !== null) {
        resolved[key] = this.resolveArguments(
          value as Record<string, unknown>,
          context
        );
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private makeError(
    code: string,
    message: string,
    stepId: string | undefined
  ): PlanExecutionError {
    return { code, message, step: stepId, retryable: false };
  }

  private normalizeError(err: unknown, stepId: string | undefined): PlanExecutionError {
    if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
      return err as PlanExecutionError;
    }
    return {
      code: "EXECUTION_ERROR",
      message: err instanceof Error ? err.message : String(err),
      step: stepId,
      retryable: false,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Plan Factory
// ============================================================================

/**
 * Helper to construct plan objects with type safety.
 */
export class PlanBuilder {
  private steps: Step[] = [];

  /**
   * Add a tool invocation step.
   */
  tool(name: string, args?: Record<string, unknown>, id?: string): this {
    this.steps.push({ kind: "tool_call", id, tool: name, arguments: args });
    return this;
  }

  /**
   * Add a foreach block.
   */
  foreach(
    collection: string,
    as: string,
    subSteps: Step[],
    parallelism?: number
  ): this {
    this.steps.push({ kind: "foreach", foreach: collection, as, steps: subSteps, parallelism });
    return this;
  }

  /**
   * Add a parallel block.
   */
  parallel(...branches: Step[][]): this {
    this.steps.push({ kind: "parallel", parallel: branches });
    return this;
  }

  /**
   * Add a conditional block.
   */
  conditional(
    ifExpr: string,
    thenSteps: Step[],
    elseSteps?: Step[]
  ): this {
    const block: ConditionalBlock = { kind: "conditional", if: ifExpr, then: thenSteps };
    if (elseSteps) {
      block.else = elseSteps;
    }
    // We need to cast since ConditionalBlock is part of Step union
    this.steps.push(block as Step);
    return this;
  }

  /**
   * Build the plan object.
   */
  build(version: number = 1): Plan {
    return {
      type: "mcp.plan",
      version,
      steps: this.steps,
    };
  }
}

// ============================================================================
// Expression Evaluator
// ============================================================================

/**
 * Supported expression language identifiers.
 */
export type ExpressionLanguageId = "cel" | "jsonata" | "sandbox" | (string & {});

/**
 * Options for the expression evaluator.
 */
export interface ExpressionEvaluatorOptions {
  /** The active expression language (default: "cel"). */
  language?: ExpressionLanguageId;

  /** Maximum execution time for sandboxed expressions, in ms. */
  sandboxTimeoutMs?: number;

  /** Maximum number of operations for sandboxed expressions. */
  sandboxMaxOps?: number;
}

/**
 * Evaluates condition expressions and variable paths using the
 * negotiated expression language.
 *
 * CEL (default) — all plan-supporting servers MUST implement CEL as the
 * baseline expression language for conditions and variable references.
 *
 * JSONata — opt-in, negotiated via `mcp.negotiate`. Processes expressions
 * using JSONata syntax.
 *
 * Sandbox — optional server feature. Evaluates inline JavaScript in an
 * isolated environment with predefined variables (plan.step[n], plan.variables).
 *
 * @remarks
 * This is a design sketch showing the interface and dispatch logic.
 * Actual CEL/JSONata evaluation would require their respective runtime
 * libraries (`cel-js`, `jsonata`, etc.).
 */
export class ExpressionEvaluator {
  private readonly language: ExpressionLanguageId;
  private readonly sandboxTimeoutMs: number;
  private readonly sandboxMaxOps: number;

  constructor(options?: ExpressionEvaluatorOptions) {
    this.language = options?.language ?? "cel";
    this.sandboxTimeoutMs = options?.sandboxTimeoutMs ?? 1000;
    this.sandboxMaxOps = options?.sandboxMaxOps ?? 10000;
  }

  /**
   * Evaluate a boolean condition expression against the execution context.
   *
   * @param expression - The condition string (e.g., "$search.count > 0").
   * @param context - The current execution context with step results.
   * @returns The boolean result of the condition.
   */
  evaluateCondition(
    expression: string,
    context: PlanExecutionContext
  ): boolean {
    switch (this.language) {
      case "cel":
        return this.evaluateCelCondition(expression, context);
      case "jsonata":
        return this.evaluateJsonataCondition(expression, context);
      case "sandbox":
        return this.evaluateSandboxCondition(expression, context);
      default:
        // Graceful fallback: truthy check on resolved variable
        return this.evaluateFallback(expression, context);
    }
  }

  /**
   * Resolve a variable reference path against the execution context.
   *
   * Supports dot-notation traversal: "$step.result.items" resolves
   * to context.results.get("step")?.result?.items.
   *
   * @param path - The variable reference path (e.g., "$fetch.result").
   * @param context - The current execution context.
   * @returns The resolved value, or undefined if not found.
   */
  resolveReference(
    path: string,
    context: PlanExecutionContext
  ): unknown {
    if (!path.startsWith("$")) {
      return path;
    }

    const segments = path.slice(1).split(".");
    const root = segments[0];

    let value: unknown;

    // Check step results first
    if (context.results.has(root)) {
      value = context.results.get(root);
    }
    // Check loop variables
    else if (context.loopVars.has(root)) {
      value = context.loopVars.get(root);
    }
    // Check named variables
    else if (context.variables.has(root)) {
      value = context.variables.get(root);
    }

    // Traverse remaining path segments
    for (let i = 1; i < segments.length && value !== undefined; i++) {
      const segment = segments[i];
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[segment];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Evaluate a CEL-style boolean expression.
   *
   * Supports: >, <, >=, <=, ==, !=, &&, ||, !, parentheses, string literals,
   * number literals, and variable references.
   *
   * This is a simplified evaluator for the design sketch. A production
   * implementation should use a proper CEL parser/runtime.
   */
  private evaluateCelCondition(
    expression: string,
    context: PlanExecutionContext
  ): boolean {
    // Normalise variable references in the expression
    const resolved = this.resolveVariablesInExpression(expression, context);

    // Simple comparison evaluator for the sketch
    try {
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return Boolean(${resolved});`)();
    } catch {
      return false;
    }
  }

  /**
   * Evaluate a JSONata expression.
   *
   * @remarks
   * Production implementation would use the `jsonata` npm package.
   */
  private evaluateJsonataCondition(
    expression: string,
    context: PlanExecutionContext
  ): boolean {
    // Resolve variable references first
    const resolvedCtx = this.buildJsonataContext(context);
    const resolved = this.replaceReferences(expression, resolvedCtx);

    try {
      // eslint-disable-next-line no-new-func
      return Boolean(Function(`"use strict"; return (${resolved});`)());
    } catch {
      return this.evaluateCelCondition(expression, context);
    }
  }

  /**
   * Evaluate an expression in the sandbox.
   *
   * Provides `plan.step[n]`, `plan.step[id]`, `plan.variables`,
   * and `plan.input` as predefined bindings.
   *
   * @remarks
   * Production implementation MUST use an actual sandbox (isolated-vm,
   * vm2, or a Web Worker) with strict timeout and resource limits.
   */
  private evaluateSandboxCondition(
    expression: string,
    context: PlanExecutionContext
  ): boolean {
    const planContext = {
      step: Object.fromEntries(context.results),
      variables: Object.fromEntries(context.variables),
      loopVars: Object.fromEntries(context.loopVars),
    };

    const sandboxCode = `
      const plan = ${JSON.stringify(planContext)};
      const result = (${expression});
      return Boolean(result);
    `;

    try {
      // eslint-disable-next-line no-new-func
      return Boolean(Function(`"use strict"; ${sandboxCode}`)());
    } catch {
      return false;
    }
  }

  /**
   * Fallback evaluator: tries to resolve the expression as a variable
   * reference and returns its truthiness.
   */
  private evaluateFallback(
    expression: string,
    context: PlanExecutionContext
  ): boolean {
    if (expression.startsWith("$")) {
      const value = this.resolveReference(expression, context);
      return Boolean(value);
    }
    return expression.length > 0;
  }

  /**
   * Replace $variable.ref patterns with their resolved values in an expression.
   */
  private resolveVariablesInExpression(
    expr: string,
    context: PlanExecutionContext
  ): string {
    return expr.replace(/\$([a-zA-Z_][a-zA-Z0-9_.]*)/g, (match, path) => {
      const value = this.resolveReference(`$${path}`, context);
      if (typeof value === "string") {
        return JSON.stringify(value);
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      if (value === null) {
        return "null";
      }
      if (value === undefined) {
        return "undefined";
      }
      return JSON.stringify(value);
    });
  }

  /**
   * Build a flat context object from PlanExecutionContext for JSONata.
   */
  private buildJsonataContext(
    context: PlanExecutionContext
  ): Record<string, unknown> {
    return {
      results: Object.fromEntries(context.results),
      variables: Object.fromEntries(context.variables),
      loopVars: Object.fromEntries(context.loopVars),
    };
  }

  /**
   * Replace $variable references with their values from a flat context.
   */
  private replaceReferences(
    expr: string,
    context: Record<string, unknown>
  ): string {
    return expr.replace(
      /\$([a-zA-Z_][a-zA-Z0-9_.]*)/g,
      (match, path: string) => {
        const parts = path.split(".");
        let value: unknown = context[parts[0]];
        for (let i = 1; i < parts.length && value !== undefined; i++) {
          if (typeof value === "object" && value !== null) {
            value = (value as Record<string, unknown>)[parts[i]];
          } else {
            return "undefined";
          }
        }
        if (typeof value === "string") return JSON.stringify(value);
        if (typeof value === "number" || typeof value === "boolean")
          return String(value);
        return JSON.stringify(value);
      }
    );
  }
}
