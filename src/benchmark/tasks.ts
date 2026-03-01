// ── Benchmark Task Definitions ──────────────────────────────────────
// 12 standardized tasks across 6 categories, 3 difficulty levels.
// Each task contains realistic TypeScript code snippets.

import type { BenchmarkTask } from "./types.ts";

// ── Coding Tasks ────────────────────────────────────────────────────

const codingEasy: BenchmarkTask = {
  id: "coding-easy-email-validator",
  name: "Valid Email Checker",
  category: "coding",
  difficulty: "easy",
  prompt: `Write a TypeScript function \`isValidEmail(email: string): boolean\` that validates email addresses.

Requirements:
- Must have a local part and domain part separated by exactly one '@'
- Local part: 1-64 characters, allows alphanumeric, dots, hyphens, underscores, plus signs
- Local part must not start or end with a dot
- Local part must not have consecutive dots
- Domain part: must have at least one dot separating labels
- Domain labels: 1-63 characters each, alphanumeric and hyphens only
- Domain labels must not start or end with a hyphen
- TLD must be at least 2 characters, alphabetic only
- The function should NOT use a regex — implement character-by-character validation

Export the function as a named export.`,
  expectedOutcomes: [
    "Function correctly validates standard emails (user@example.com)",
    "Rejects emails without @, with multiple @, or empty parts",
    "Handles edge cases: consecutive dots, leading/trailing dots in local part",
    "Validates domain labels and TLD rules",
    "No regex used — character-by-character logic",
  ],
  evaluationCriteria: {
    correctness: "Does it correctly accept valid emails and reject invalid ones? Test at least 15 edge cases.",
    completeness: "Does it implement ALL specified rules? No shortcuts or missing validations.",
    codeQuality: "Is the code readable, well-structured, with clear variable names? Proper TypeScript types?",
  },
  timeoutMs: 60_000,
  maxCostUsd: 0.10,
};

const codingMedium: BenchmarkTask = {
  id: "coding-medium-rate-limiter",
  name: "Token Bucket Rate Limiter",
  category: "coding",
  difficulty: "medium",
  prompt: `Implement a token bucket rate limiter in TypeScript.

\`\`\`typescript
interface RateLimiterOptions {
  maxTokens: number;       // Maximum tokens in the bucket
  refillRate: number;      // Tokens added per second
  refillInterval?: number; // Custom refill interval in ms (default: 1000)
}

interface RateLimitResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterMs: number | null;  // null if allowed, ms to wait if denied
}
\`\`\`

Requirements:
1. Create a \`TokenBucketRateLimiter\` class that implements the token bucket algorithm
2. \`constructor(options: RateLimiterOptions)\` — initialize with given capacity and refill rate
3. \`tryConsume(tokens?: number): RateLimitResult\` — attempt to consume tokens (default 1)
   - If enough tokens: consume them, return allowed=true
   - If not enough: return allowed=false with retryAfterMs
4. \`peek(): { tokens: number; capacity: number }\` — check current state without consuming
5. \`reset(): void\` — reset bucket to full capacity
6. Token refill must be calculated lazily (not with timers) — compute elapsed time since last refill
7. Tokens must never exceed maxTokens
8. Handle edge cases: consuming 0 tokens, consuming more than capacity, negative values
9. Must be precise to millisecond level for retryAfterMs calculation
10. Create a \`createKeyedRateLimiter(options: RateLimiterOptions)\` factory that returns a rate limiter per key (e.g., per IP address), with a \`Map<string, TokenBucketRateLimiter>\` internally

Export both the class and the factory function.`,
  expectedOutcomes: [
    "TokenBucketRateLimiter class with correct token bucket algorithm",
    "Lazy refill calculation based on elapsed time",
    "Accurate retryAfterMs when tokens are insufficient",
    "Keyed rate limiter factory for per-key limiting",
    "Edge case handling for 0, negative, and over-capacity consumption",
  ],
  evaluationCriteria: {
    correctness: "Does the token bucket algorithm work correctly? Are refills calculated accurately? Is retryAfterMs precise?",
    completeness: "Are all 10 requirements implemented? Does the keyed factory work? Edge cases handled?",
    codeQuality: "Clean TypeScript with proper types, no any. Good separation of concerns. Efficient implementation.",
  },
  timeoutMs: 120_000,
  maxCostUsd: 0.20,
};

const codingHard: BenchmarkTask = {
  id: "coding-hard-cli-parser",
  name: "CLI Argument Parser",
  category: "coding",
  difficulty: "hard",
  prompt: `Build a CLI argument parser in TypeScript that supports flags, positional arguments, subcommands, and auto-generated help text.

\`\`\`typescript
interface FlagDef {
  short?: string;          // e.g. "-v"
  long: string;            // e.g. "--verbose"
  description: string;
  type: "boolean" | "string" | "number" | "string[]";
  default?: unknown;
  required?: boolean;
  env?: string;            // Environment variable fallback
}

interface PositionalDef {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;      // Collects remaining args into array
}

interface SubcommandDef {
  name: string;
  description: string;
  aliases?: string[];
  flags?: FlagDef[];
  positionals?: PositionalDef[];
}
\`\`\`

Requirements:
1. \`CliParser\` class with:
   - \`name(n: string): this\` — set program name
   - \`version(v: string): this\` — set version string
   - \`description(d: string): this\` — set program description
   - \`flag(def: FlagDef): this\` — add a global flag
   - \`positional(def: PositionalDef): this\` — add a positional argument
   - \`subcommand(def: SubcommandDef): this\` — add a subcommand
   - \`parse(argv: string[]): ParseResult\` — parse arguments

2. Parse result type:
   \`\`\`typescript
   interface ParseResult {
     command: string | null;       // Subcommand name or null
     flags: Record<string, unknown>;
     positionals: Record<string, unknown>;
     rest: string[];               // Unparsed arguments after --
     errors: string[];             // Validation errors
   }
   \`\`\`

3. Parsing rules:
   - \`--flag=value\` and \`--flag value\` both work for string/number flags
   - \`-v\` short flags, \`-abc\` combined short boolean flags
   - \`--\` stops flag parsing, rest goes to \`rest\` array
   - \`--no-verbose\` negates boolean flags
   - Environment variable fallback when flag not provided
   - Required flag/positional validation
   - Type coercion for number flags (error if not a valid number)
   - Variadic positional collects all remaining non-flag args

4. Auto-generated help:
   - \`generateHelp(): string\` — produces formatted help text
   - Includes usage line, description, flags table, positionals, subcommands
   - Aligned columns with proper padding
   - Shows defaults and required markers

5. Error handling:
   - Unknown flags produce errors (not exceptions)
   - Missing required flags/positionals produce errors
   - Type mismatches produce errors
   - All errors collected in \`errors\` array, never throws

Export the \`CliParser\` class and all type interfaces.`,
  expectedOutcomes: [
    "Complete CliParser class with fluent API",
    "Correct parsing of long flags, short flags, combined shorts, --no- negation",
    "Subcommand routing with per-command flags",
    "Auto-generated help text with aligned columns",
    "Comprehensive error collection without throwing",
    "Environment variable fallback for flags",
    "Variadic positional argument support",
  ],
  evaluationCriteria: {
    correctness: "Does parsing handle all flag formats correctly? Are subcommands routed? Is type coercion accurate?",
    completeness: "All 5 requirement groups implemented? Help generation? Error collection? Env fallback? Variadic?",
    codeQuality: "Well-architected with clear separation. Proper generics/types. No any. Readable formatting logic.",
  },
  timeoutMs: 300_000,
  maxCostUsd: 0.50,
};

// ── Debugging Tasks ─────────────────────────────────────────────────

const debuggingEasy: BenchmarkTask = {
  id: "debugging-easy-sort",
  name: "Buggy Sort Function",
  category: "debugging",
  difficulty: "easy",
  prompt: `This function should sort an array of numbers in ascending order, but it returns wrong results. Find and fix ALL the bugs.

\`\`\`typescript
function bubbleSort(arr: number[]): number[] {
  const result = arr;  // Bug 1: should be a copy

  for (let i = 0; i < result.length; i++) {
    for (let j = 0; j < result.length; j++) {  // Bug 2: should be result.length - i - 1
      if (result[j] > result[j + 1]) {
        // Bug 3: this swap doesn't work correctly
        result[j] = result[j + 1];
        result[j + 1] = result[j];
      }
    }
  }

  return result;
}

function insertionSort(arr: number[]): number[] {
  const result = [...arr];

  for (let i = 0; i < result.length; i++) {  // Bug 4: should start at 1
    const key = result[i];
    let j = i - 1;

    while (j >= 0 && result[j] < key) {  // Bug 5: comparison direction is wrong, should be >
      result[j + 1] = result[j];
      j--;
    }

    result[j] = key;  // Bug 6: should be result[j + 1]
  }

  return result;
}

function mergeSort(arr: number[]): number[] {
  if (arr.length < 2) return arr;  // Bug 7: should be <= 1 (or < 2 is fine, but...)

  const mid = Math.floor(arr.length / 2);
  const left = arr.slice(0, mid);
  const right = arr.slice(mid + 1);  // Bug 8: should be arr.slice(mid), losing element at mid

  return merge(mergeSort(left), mergeSort(right));
}

function merge(left: number[], right: number[]): number[] {
  const result: number[] = [];
  let i = 0, j = 0;

  while (i < left.length && j < right.length) {  // Bug 9: should use || to not lose remaining
    if (left[i] <= right[j]) {
      result.push(left[i]);
      i++;
    } else {
      result.push(right[j]);
      j++;
    }
  }

  // Missing: concatenate remaining elements from both arrays

  return result;
}
\`\`\`

For each bug:
1. Identify the exact line and what's wrong
2. Explain WHY it's wrong
3. Provide the corrected code

Then provide the complete corrected versions of all three functions.`,
  expectedOutcomes: [
    "All 9+ bugs identified and explained",
    "Correct fix provided for each bug",
    "Complete corrected functions that actually sort correctly",
    "Clear explanation of why each bug causes incorrect behavior",
  ],
  evaluationCriteria: {
    correctness: "Are all bugs found? Are the fixes correct? Do the corrected functions sort properly?",
    completeness: "Every bug identified and explained? Complete corrected code provided?",
    codeQuality: "Clear explanations? Fixes follow TypeScript best practices?",
  },
  timeoutMs: 90_000,
  maxCostUsd: 0.15,
};

const debuggingMedium: BenchmarkTask = {
  id: "debugging-medium-async-queue",
  name: "Async Queue Race Condition",
  category: "debugging",
  difficulty: "medium",
  prompt: `This async queue processor sometimes loses items or processes them twice. Identify ALL race conditions and concurrency bugs, then fix them.

\`\`\`typescript
class AsyncTaskQueue {
  private queue: Array<{ id: string; task: () => Promise<void> }> = [];
  private processing = false;
  private processed = new Set<string>();
  private concurrency: number;
  private activeCount = 0;
  private results: Map<string, { success: boolean; error?: Error }> = new Map();

  constructor(concurrency = 3) {
    this.concurrency = concurrency;
  }

  async add(id: string, task: () => Promise<void>): Promise<void> {
    if (this.processed.has(id)) {
      return; // Already processed
    }

    this.queue.push({ id, task });
    // Bug: multiple calls to processNext can run before any awaits,
    // leading to the same item being dequeued multiple times
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.activeCount >= this.concurrency) return;
    if (this.queue.length === 0) return;

    // Bug: race condition — between checking queue.length and shifting,
    // another processNext call could have taken the item
    const item = this.queue.shift()!;
    this.activeCount++;

    try {
      // Bug: no check if item was already grabbed by another processNext
      await item.task();
      this.processed.add(item.id);
      this.results.set(item.id, { success: true });
    } catch (error) {
      this.results.set(item.id, { success: false, error: error as Error });
      // Bug: failed items are never retried and not re-added to queue
    } finally {
      this.activeCount--;
      // Bug: only processes one next item, should try to fill up to concurrency
      this.processNext();
    }
  }

  async drain(): Promise<void> {
    // Bug: this doesn't actually wait for processing to complete
    // It just checks the current state and returns immediately
    while (this.queue.length > 0 || this.activeCount > 0) {
      // Bug: busy-waiting with no yield point, will block the event loop
      // and prevent tasks from actually completing
    }
  }

  getResults(): Map<string, { success: boolean; error?: Error }> {
    return this.results;
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.activeCount;
  }
}
\`\`\`

For each bug:
1. Explain the race condition or concurrency issue
2. Describe a scenario where the bug manifests
3. Provide the fix

Then provide a complete corrected implementation with:
- Proper synchronization using promise-based coordination (no mutexes needed in JS)
- A working \`drain()\` method that returns a Promise resolving when all tasks complete
- Optional retry support with configurable max retries
- Event callbacks: \`onComplete\`, \`onError\`, \`onDrain\``,
  expectedOutcomes: [
    "All race conditions identified with clear scenarios",
    "Busy-wait in drain() identified and fixed with proper async coordination",
    "processNext race condition fixed with proper queue management",
    "Complete corrected implementation with drain/retry/callbacks",
  ],
  evaluationCriteria: {
    correctness: "Are all race conditions found? Do the fixes actually prevent the issues? Does drain() work correctly?",
    completeness: "All bugs identified? Retry support added? Event callbacks implemented? Complete working code?",
    codeQuality: "Proper async patterns? No busy-waiting? Clean event handling? Good TypeScript types?",
  },
  timeoutMs: 180_000,
  maxCostUsd: 0.25,
};

// ── Refactoring Tasks ───────────────────────────────────────────────

const refactoringEasy: BenchmarkTask = {
  id: "refactoring-easy-extract",
  name: "Extract Functions from Monolith",
  category: "refactoring",
  difficulty: "easy",
  prompt: `Refactor this 100+ line function into smaller, well-named functions with clear single responsibilities. Maintain identical behavior.

\`\`\`typescript
interface Order {
  id: string;
  items: Array<{ productId: string; name: string; price: number; quantity: number; weight: number }>;
  customer: { id: string; name: string; email: string; tier: "standard" | "premium" | "vip" };
  shippingAddress: { country: string; state: string; zip: string };
  couponCode?: string;
  createdAt: Date;
}

interface ProcessedOrder {
  orderId: string;
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
  estimatedDelivery: Date;
  notifications: string[];
}

function processOrder(order: Order): ProcessedOrder {
  // Calculate subtotal
  let subtotal = 0;
  for (const item of order.items) {
    subtotal += item.price * item.quantity;
  }

  // Apply quantity discounts
  let discount = 0;
  for (const item of order.items) {
    if (item.quantity >= 10) {
      discount += item.price * item.quantity * 0.15;
    } else if (item.quantity >= 5) {
      discount += item.price * item.quantity * 0.10;
    } else if (item.quantity >= 3) {
      discount += item.price * item.quantity * 0.05;
    }
  }

  // Apply coupon
  if (order.couponCode) {
    if (order.couponCode === "SAVE20") {
      discount += (subtotal - discount) * 0.20;
    } else if (order.couponCode === "FLAT50") {
      discount += 50;
    } else if (order.couponCode.startsWith("PCT")) {
      const pct = parseInt(order.couponCode.slice(3));
      if (!isNaN(pct) && pct > 0 && pct <= 50) {
        discount += (subtotal - discount) * (pct / 100);
      }
    }
  }

  // Apply tier discount
  if (order.customer.tier === "premium") {
    discount += (subtotal - discount) * 0.05;
  } else if (order.customer.tier === "vip") {
    discount += (subtotal - discount) * 0.10;
  }

  // Cap discount
  if (discount > subtotal) {
    discount = subtotal;
  }

  // Calculate tax
  let taxRate = 0;
  if (order.shippingAddress.country === "US") {
    if (["CA", "NY", "TX"].includes(order.shippingAddress.state)) {
      taxRate = 0.08;
    } else if (["OR", "MT", "NH", "DE"].includes(order.shippingAddress.state)) {
      taxRate = 0;
    } else {
      taxRate = 0.06;
    }
  } else if (order.shippingAddress.country === "CA") {
    taxRate = 0.13;
  } else if (order.shippingAddress.country === "GB") {
    taxRate = 0.20;
  } else if (order.shippingAddress.country === "DE" || order.shippingAddress.country === "FR") {
    taxRate = 0.19;
  } else {
    taxRate = 0.10;
  }
  const tax = (subtotal - discount) * taxRate;

  // Calculate shipping
  let totalWeight = 0;
  for (const item of order.items) {
    totalWeight += item.weight * item.quantity;
  }
  let shipping = 0;
  if (order.customer.tier === "vip") {
    shipping = 0; // Free shipping for VIP
  } else if (subtotal - discount >= 100) {
    shipping = 0; // Free shipping over $100
  } else if (totalWeight <= 1) {
    shipping = 5.99;
  } else if (totalWeight <= 5) {
    shipping = 9.99;
  } else if (totalWeight <= 20) {
    shipping = 14.99;
  } else {
    shipping = 14.99 + (totalWeight - 20) * 0.50;
  }
  if (order.shippingAddress.country !== "US") {
    shipping *= 2.5;
  }

  // Calculate delivery estimate
  let businessDays = 5;
  if (order.customer.tier === "vip") {
    businessDays = 2;
  } else if (order.customer.tier === "premium") {
    businessDays = 3;
  }
  if (order.shippingAddress.country !== "US") {
    businessDays += 7;
  }
  const estimatedDelivery = new Date(order.createdAt);
  let daysAdded = 0;
  while (daysAdded < businessDays) {
    estimatedDelivery.setDate(estimatedDelivery.getDate() + 1);
    const dow = estimatedDelivery.getDay();
    if (dow !== 0 && dow !== 6) {
      daysAdded++;
    }
  }

  // Build notifications
  const notifications: string[] = [];
  notifications.push(\`Order \${order.id} confirmed for \${order.customer.name}\`);
  if (discount > 0) {
    notifications.push(\`You saved $\${discount.toFixed(2)}!\`);
  }
  if (shipping === 0) {
    notifications.push("Free shipping applied!");
  }
  if (order.customer.tier !== "standard") {
    notifications.push(\`\${order.customer.tier.toUpperCase()} member benefits applied\`);
  }

  const total = subtotal - discount + tax + shipping;

  return {
    orderId: order.id,
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    shipping: Math.round(shipping * 100) / 100,
    total: Math.round(total * 100) / 100,
    estimatedDelivery,
    notifications,
  };
}
\`\`\`

Extract at least 6 focused helper functions. Each should:
- Have a clear, descriptive name
- Handle one responsibility
- Be independently testable
- Have proper TypeScript types

Keep the top-level \`processOrder\` function as the orchestrator that calls the helpers.`,
  expectedOutcomes: [
    "At least 6 extracted helper functions with clear names",
    "Each helper has single responsibility",
    "Top-level processOrder orchestrates helpers cleanly",
    "Behavior is identical to original",
    "All functions have proper TypeScript types",
  ],
  evaluationCriteria: {
    correctness: "Does the refactored code produce identical results? Are all calculations preserved?",
    completeness: "At least 6 functions extracted? All sections refactored? Types complete?",
    codeQuality: "Clear naming? Single responsibility? Independently testable? Clean orchestration?",
  },
  timeoutMs: 120_000,
  maxCostUsd: 0.20,
};

const refactoringMedium: BenchmarkTask = {
  id: "refactoring-medium-callbacks-to-async",
  name: "Callbacks to Async/Await",
  category: "refactoring",
  difficulty: "medium",
  prompt: `Convert this callback-based file processing API to async/await while maintaining backward compatibility.

\`\`\`typescript
import { readFile, writeFile, stat, readdir } from "node:fs";
import { join, extname } from "node:path";

type Callback<T> = (error: Error | null, result?: T) => void;

interface FileInfo {
  path: string;
  size: number;
  extension: string;
  content: string;
}

interface ProcessResult {
  processed: number;
  skipped: number;
  errors: string[];
  files: FileInfo[];
}

function processDirectory(
  dirPath: string,
  extensions: string[],
  transform: (content: string, cb: Callback<string>) => void,
  callback: Callback<ProcessResult>,
): void {
  const result: ProcessResult = { processed: 0, skipped: 0, errors: [], files: [] };

  readdir(dirPath, (err, entries) => {
    if (err) return callback(err);

    let pending = entries.length;
    if (pending === 0) return callback(null, result);

    entries.forEach((entry) => {
      const filePath = join(dirPath, entry);

      stat(filePath, (err, stats) => {
        if (err) {
          result.errors.push(\`stat failed: \${filePath}\`);
          if (--pending === 0) callback(null, result);
          return;
        }

        if (stats.isDirectory()) {
          processDirectory(filePath, extensions, transform, (err, subResult) => {
            if (err) {
              result.errors.push(\`subdir failed: \${filePath}\`);
            } else if (subResult) {
              result.processed += subResult.processed;
              result.skipped += subResult.skipped;
              result.errors.push(...subResult.errors);
              result.files.push(...subResult.files);
            }
            if (--pending === 0) callback(null, result);
          });
          return;
        }

        const ext = extname(entry);
        if (!extensions.includes(ext)) {
          result.skipped++;
          if (--pending === 0) callback(null, result);
          return;
        }

        readFile(filePath, "utf-8", (err, content) => {
          if (err) {
            result.errors.push(\`read failed: \${filePath}\`);
            if (--pending === 0) callback(null, result);
            return;
          }

          transform(content, (err, transformed) => {
            if (err) {
              result.errors.push(\`transform failed: \${filePath}: \${err.message}\`);
              if (--pending === 0) callback(null, result);
              return;
            }

            writeFile(filePath, transformed!, (err) => {
              if (err) {
                result.errors.push(\`write failed: \${filePath}\`);
              } else {
                result.processed++;
                result.files.push({
                  path: filePath,
                  size: Buffer.byteLength(transformed!, "utf-8"),
                  extension: ext,
                  content: transformed!,
                });
              }
              if (--pending === 0) callback(null, result);
            });
          });
        });
      });
    });
  });
}

function batchProcess(
  dirs: string[],
  extensions: string[],
  transform: (content: string, cb: Callback<string>) => void,
  concurrency: number,
  callback: Callback<ProcessResult>,
): void {
  const result: ProcessResult = { processed: 0, skipped: 0, errors: [], files: [] };
  let index = 0;
  let active = 0;
  let finished = false;

  function next(): void {
    if (finished) return;
    if (index >= dirs.length && active === 0) {
      finished = true;
      callback(null, result);
      return;
    }

    while (active < concurrency && index < dirs.length) {
      const dir = dirs[index++];
      active++;

      processDirectory(dir, extensions, transform, (err, subResult) => {
        active--;
        if (err) {
          result.errors.push(\`batch failed: \${dir}\`);
        } else if (subResult) {
          result.processed += subResult.processed;
          result.skipped += subResult.skipped;
          result.errors.push(...subResult.errors);
          result.files.push(...subResult.files);
        }
        next();
      });
    }
  }

  next();
}
\`\`\`

Requirements:
1. Convert to async/await using \`fs/promises\`
2. The \`transform\` parameter should accept both styles:
   - New: \`(content: string) => Promise<string>\`
   - Legacy: \`(content: string, cb: Callback<string>) => void\`
3. Create a helper \`wrapTransform\` that normalizes both styles to Promise-based
4. Maintain the same error-collection behavior (errors array, not throwing)
5. Keep \`batchProcess\` concurrency limiting behavior
6. Add \`AbortSignal\` support to both functions for cancellation
7. Export both the new async versions AND backward-compatible callback wrappers:
   \`\`\`typescript
   // New API
   export async function processDirectory(dirPath: string, ...): Promise<ProcessResult>
   export async function batchProcess(dirs: string[], ...): Promise<ProcessResult>
   // Legacy wrappers
   export function processDirectoryCallback(dirPath: string, ..., callback: Callback<ProcessResult>): void
   export function batchProcessCallback(dirs: string[], ..., callback: Callback<ProcessResult>): void
   \`\`\``,
  expectedOutcomes: [
    "Clean async/await conversion using fs/promises",
    "Transform wrapper supporting both callback and promise styles",
    "Concurrency limiting preserved in batchProcess",
    "AbortSignal cancellation support",
    "Backward-compatible callback wrappers",
    "Error collection behavior maintained",
  ],
  evaluationCriteria: {
    correctness: "Does the async version produce identical results? Is concurrency limiting correct? Does AbortSignal work?",
    completeness: "Both function styles (callback wrapper + async) exported? Transform wrapper? All features ported?",
    codeQuality: "Clean async patterns? No unnecessary promisification? Proper abort handling? Good types?",
  },
  timeoutMs: 180_000,
  maxCostUsd: 0.25,
};

// ── Review Tasks ────────────────────────────────────────────────────

const reviewEasy: BenchmarkTask = {
  id: "review-easy-security",
  name: "Security Code Review",
  category: "review",
  difficulty: "easy",
  prompt: `Review this Express.js API code for security vulnerabilities. Identify ALL issues, categorize their severity, and provide fixes.

\`\`\`typescript
import express from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: "postgres://admin:password123@localhost:5432/myapp",
});

// User login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  // SQL Injection vulnerability
  const result = await pool.query(
    \`SELECT * FROM users WHERE username = '\${username}' AND password = '\${password}'\`
  );

  if (result.rows.length > 0) {
    const user = result.rows[0];
    // Exposing sensitive data
    res.json({ success: true, user });
  } else {
    res.json({ success: false, message: "Invalid credentials" });
  }
});

// User profile
app.get("/profile/:id", async (req, res) => {
  // IDOR vulnerability — no auth check
  const result = await pool.query(
    \`SELECT * FROM users WHERE id = \${req.params.id}\`
  );
  res.json(result.rows[0]);
});

// File upload
app.post("/upload", (req, res) => {
  const { filename, content } = req.body;

  // Path traversal vulnerability
  const fs = require("fs");
  fs.writeFileSync(\`./uploads/\${filename}\`, content);

  res.json({ success: true, path: \`/uploads/\${filename}\` });
});

// Search
app.get("/search", async (req, res) => {
  const { q } = req.query;

  // XSS vulnerability — rendering user input as HTML
  const result = await pool.query(
    \`SELECT * FROM products WHERE name ILIKE '%\${q}%'\`
  );

  const html = \`<h1>Results for: \${q}</h1><ul>\` +
    result.rows.map((r: any) => \`<li>\${r.name} - $\${r.price}</li>\`).join("") +
    \`</ul>\`;

  res.send(html);
});

// Admin endpoint
app.delete("/admin/users/:id", async (req, res) => {
  // No authentication or authorization
  await pool.query(\`DELETE FROM users WHERE id = \${req.params.id}\`);
  res.json({ deleted: true });
});

// Error handler
app.use((err: any, req: any, res: any, next: any) => {
  // Leaking stack trace and internal details
  res.status(500).json({
    error: err.message,
    stack: err.stack,
    query: (err as any).query,
  });
});

app.listen(3000);
\`\`\`

For each vulnerability:
1. Name the vulnerability type (e.g., SQL Injection, XSS)
2. Rate severity: Critical / High / Medium / Low
3. Explain the attack vector — how an attacker would exploit it
4. Provide a secure fix with code

Also list any missing security best practices (rate limiting, CORS, helmet, etc.).`,
  expectedOutcomes: [
    "SQL injection identified in at least 4 queries",
    "XSS vulnerability in search endpoint identified",
    "Path traversal in file upload identified",
    "IDOR in profile endpoint identified",
    "Hardcoded credentials flagged",
    "Missing auth on admin endpoint flagged",
    "Stack trace leakage in error handler flagged",
    "Missing security practices listed (rate limiting, CORS, helmet, CSRF, password hashing)",
  ],
  evaluationCriteria: {
    correctness: "All vulnerabilities found? Severity ratings appropriate? Attack vectors realistic?",
    completeness: "Every vulnerability addressed? Fixes provided for each? Missing practices listed?",
    codeQuality: "Fixes follow security best practices? Parameterized queries? Proper auth patterns?",
  },
  timeoutMs: 120_000,
  maxCostUsd: 0.20,
};

const reviewMedium: BenchmarkTask = {
  id: "review-medium-pr",
  name: "Pull Request Review",
  category: "review",
  difficulty: "medium",
  prompt: `Review this pull request for correctness, performance, and maintainability. The PR adds a caching layer to a data fetching service.

**Before (existing code):**
\`\`\`typescript
interface DataRecord {
  id: string;
  data: unknown;
  updatedAt: Date;
}

class DataService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getById(id: string): Promise<DataRecord | null> {
    return this.db.query<DataRecord>("SELECT * FROM records WHERE id = ?", [id]);
  }

  async getByIds(ids: string[]): Promise<DataRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.queryAll<DataRecord>(
      \`SELECT * FROM records WHERE id IN (\${placeholders})\`,
      ids
    );
  }

  async update(id: string, data: unknown): Promise<void> {
    await this.db.execute(
      "UPDATE records SET data = ?, updated_at = NOW() WHERE id = ?",
      [JSON.stringify(data), id]
    );
  }
}
\`\`\`

**After (PR diff):**
\`\`\`typescript
interface DataRecord {
  id: string;
  data: unknown;
  updatedAt: Date;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class DataService {
  private db: Database;
  private cache: Map<string, CacheEntry<DataRecord>> = new Map();
  private ttlMs: number;

  constructor(db: Database, ttlMs = 60_000) {
    this.db = db;
    this.ttlMs = ttlMs;
  }

  async getById(id: string): Promise<DataRecord | null> {
    // Check cache first
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const record = await this.db.query<DataRecord>(
      "SELECT * FROM records WHERE id = ?", [id]
    );

    if (record) {
      this.cache.set(id, {
        value: record,
        expiresAt: Date.now() + this.ttlMs,
      });
    }

    return record;
  }

  async getByIds(ids: string[]): Promise<DataRecord[]> {
    if (ids.length === 0) return [];

    const results: DataRecord[] = [];
    const uncachedIds: string[] = [];

    // Check cache for each ID
    for (const id of ids) {
      const cached = this.cache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        results.push(cached.value);
      } else {
        uncachedIds.push(id);
      }
    }

    // Fetch uncached from DB
    if (uncachedIds.length > 0) {
      const placeholders = uncachedIds.map(() => "?").join(",");
      const dbRecords = await this.db.queryAll<DataRecord>(
        \`SELECT * FROM records WHERE id IN (\${placeholders})\`,
        uncachedIds
      );

      for (const record of dbRecords) {
        this.cache.set(record.id, {
          value: record,
          expiresAt: Date.now() + this.ttlMs,
        });
        results.push(record);
      }
    }

    return results;
  }

  async update(id: string, data: unknown): Promise<void> {
    await this.db.execute(
      "UPDATE records SET data = ?, updated_at = NOW() WHERE id = ?",
      [JSON.stringify(data), id]
    );
    // Invalidate cache
    this.cache.delete(id);
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
\`\`\`

Provide a thorough code review covering:
1. **Correctness issues** — bugs, edge cases, logic errors
2. **Performance concerns** — memory leaks, unbounded growth, inefficiencies
3. **Maintainability** — naming, structure, testability, documentation
4. **Missing features** — what should be added for production readiness
5. **Rating** — Approve, Request Changes, or Comment (with justification)`,
  expectedOutcomes: [
    "Unbounded cache growth identified (no eviction strategy)",
    "Expired entries not cleaned up (only checked on access)",
    "getByIds doesn't preserve order of original ids",
    "No concurrent request deduplication (thundering herd problem)",
    "Cache not shared across instances in multi-process deployments",
    "Missing metrics/observability for cache hit/miss rates",
    "Constructor signature change is a breaking change",
    "Clear rating with justification",
  ],
  evaluationCriteria: {
    correctness: "Are real bugs found? Is the thundering herd issue mentioned? Order preservation noted?",
    completeness: "All 5 review areas covered? Actionable suggestions for each issue?",
    codeQuality: "Review is constructive? Suggestions include code examples? Priority/severity indicated?",
  },
  timeoutMs: 180_000,
  maxCostUsd: 0.25,
};

// ── Architecture Tasks ──────────────────────────────────────────────

const architectureMedium: BenchmarkTask = {
  id: "architecture-medium-cache",
  name: "REST API Caching Layer",
  category: "architecture",
  difficulty: "medium",
  prompt: `Design and implement a caching layer for a REST API in TypeScript. The cache should support TTL, LRU eviction, and cache invalidation patterns.

Requirements:
1. \`LRUCache<K, V>\` class with:
   - \`constructor(options: { maxSize: number; defaultTtlMs: number; onEvict?: (key: K, value: V) => void })\`
   - \`get(key: K): V | undefined\` — returns value if exists and not expired, updates access order
   - \`set(key: K, value: V, ttlMs?: number): void\` — sets with optional per-key TTL
   - \`delete(key: K): boolean\` — manual invalidation
   - \`has(key: K): boolean\` — check existence (without updating access order)
   - \`clear(): void\` — clear all entries
   - \`size: number\` — current entry count (excluding expired)
   - \`stats(): { hits: number; misses: number; evictions: number; hitRate: number }\`

2. Implementation must use a doubly-linked list + Map for O(1) operations

3. \`CacheMiddleware\` for HTTP caching:
   \`\`\`typescript
   interface CacheMiddlewareOptions {
     cache: LRUCache<string, CachedResponse>;
     keyGenerator?: (req: Request) => string;
     shouldCache?: (req: Request, res: Response) => boolean;
     ttlMs?: number;
     varyHeaders?: string[];          // Cache varies by these headers
     staleWhileRevalidate?: number;   // Serve stale while fetching fresh
   }
   \`\`\`

4. Cache invalidation patterns:
   - Tag-based: \`setWithTags(key, value, tags: string[])\` + \`invalidateByTag(tag: string)\`
   - Pattern-based: \`invalidateByPattern(pattern: string | RegExp)\`
   - Dependency-based: \`setWithDeps(key, value, deps: string[])\` — when a dep is invalidated, dependents are too

5. \`CacheWarmer\` utility:
   - \`warm(keys: string[], fetcher: (key: string) => Promise<V>): Promise<void>\`
   - Populates cache proactively with configurable concurrency

6. Export all classes and types. Include JSDoc comments on public methods.`,
  expectedOutcomes: [
    "LRUCache with O(1) doubly-linked list + Map implementation",
    "Correct TTL expiration with lazy cleanup",
    "Cache middleware with key generation and vary-header support",
    "Tag-based, pattern-based, and dependency-based invalidation",
    "CacheWarmer with concurrent pre-population",
    "Hit/miss statistics tracking",
    "Proper eviction callback support",
  ],
  evaluationCriteria: {
    correctness: "Is LRU order maintained correctly? Are expired entries handled? Does tag invalidation cascade correctly?",
    completeness: "All 6 requirement groups implemented? All methods present? JSDoc comments?",
    codeQuality: "O(1) operations verified? Clean generics? Proper separation of cache core vs middleware? Good types?",
  },
  timeoutMs: 300_000,
  maxCostUsd: 0.40,
};

const architectureHard: BenchmarkTask = {
  id: "architecture-hard-plugin-system",
  name: "Plugin System Design",
  category: "architecture",
  difficulty: "hard",
  prompt: `Design and implement a plugin system that supports dynamic loading, dependency resolution, and lifecycle hooks.

\`\`\`typescript
// The plugin contract
interface Plugin {
  name: string;
  version: string;
  dependencies?: Record<string, string>;  // name -> semver range

  // Lifecycle hooks
  onLoad?(context: PluginContext): Promise<void> | void;
  onActivate?(context: PluginContext): Promise<void> | void;
  onDeactivate?(context: PluginContext): Promise<void> | void;
  onUnload?(context: PluginContext): Promise<void> | void;

  // Extension points
  commands?: Record<string, CommandHandler>;
  hooks?: Record<string, HookHandler>;
  services?: Record<string, ServiceFactory>;
}

interface PluginContext {
  config: Record<string, unknown>;
  logger: Logger;
  getService<T>(name: string): T;
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): void;
}
\`\`\`

Requirements:

1. \`PluginManager\` class:
   - \`register(plugin: Plugin): void\` — register a plugin (validates contract)
   - \`loadFromDirectory(dirPath: string): Promise<void>\` — scan dir for plugin modules
   - \`activate(pluginName: string): Promise<void>\` — activate with dependency resolution
   - \`deactivate(pluginName: string): Promise<void>\` — deactivate (reverse dependency order)
   - \`activateAll(): Promise<void>\` — topological sort, activate in dependency order
   - \`deactivateAll(): Promise<void>\` — reverse order deactivation
   - \`getPlugin(name: string): Plugin | undefined\`
   - \`listPlugins(): PluginInfo[]\` — name, version, status, dependencies

2. Dependency resolution:
   - Topological sort for activation order
   - Circular dependency detection (throw clear error)
   - Semver range validation for dependency versions
   - Missing dependency detection with helpful error messages

3. Lifecycle management:
   - States: registered -> loaded -> activated -> deactivated -> unloaded
   - Cannot skip states (must load before activate)
   - Error in lifecycle hook should not break other plugins
   - Graceful error handling with rollback on activation failure

4. Service registry:
   - Plugins register services via \`services\` map
   - Other plugins access services via \`context.getService<T>(name)\`
   - Lazy initialization of services (created on first access)
   - Service override: later plugins can override earlier ones (with warning)

5. Event system:
   - Cross-plugin event bus via \`context.emit\` / \`context.on\`
   - Namespaced events: \`pluginName:eventName\`
   - Wildcard listeners: \`on("*:error", handler)\`

6. Hook system:
   - Named extension points that plugins can tap into
   - Hooks execute in plugin activation order
   - Support for waterfall hooks (each transforms the value) and parallel hooks (all run independently)
   \`\`\`typescript
   type HookType = "waterfall" | "parallel";
   \`\`\`

Export \`PluginManager\`, all types, and a \`createPlugin\` helper function.`,
  expectedOutcomes: [
    "PluginManager with full lifecycle management",
    "Topological sort for dependency resolution",
    "Circular dependency detection",
    "Semver-compatible version range checking",
    "Service registry with lazy initialization",
    "Cross-plugin event bus with namespacing and wildcards",
    "Waterfall and parallel hook execution",
    "Graceful error handling and rollback",
  ],
  evaluationCriteria: {
    correctness: "Does topological sort work? Circular deps detected? Lifecycle states enforced? Semver matching correct?",
    completeness: "All 6 requirement groups implemented? Both hook types? Wildcards? Service overrides? Error rollback?",
    codeQuality: "Clean architecture? Proper generics? Good separation of concerns? Testable design? JSDoc?",
  },
  timeoutMs: 360_000,
  maxCostUsd: 0.60,
};

// ── Testing Tasks ───────────────────────────────────────────────────

const testingEasy: BenchmarkTask = {
  id: "testing-easy-unit",
  name: "Unit Test Suite",
  category: "testing",
  difficulty: "easy",
  prompt: `Write comprehensive unit tests for this utility module using the built-in Bun test runner.

\`\`\`typescript
// utils.ts
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as T;
  if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags) as T;
  if (obj instanceof Map) {
    const map = new Map();
    for (const [key, value] of obj) {
      map.set(deepClone(key), deepClone(value));
    }
    return map as T;
  }
  if (obj instanceof Set) {
    const set = new Set();
    for (const value of obj) {
      set.add(deepClone(value));
    }
    return set as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(deepClone) as T;
  }
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
  }
  return cloned as T;
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delayMs: number,
): { (...args: Parameters<T>): void; cancel(): void; flush(): void } {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const debounced = (...args: Parameters<T>): void => {
    lastArgs = args;
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      timerId = null;
      fn(...args);
      lastArgs = null;
    }, delayMs);
  };

  debounced.cancel = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
      lastArgs = null;
    }
  };

  debounced.flush = () => {
    if (timerId !== null && lastArgs !== null) {
      clearTimeout(timerId);
      timerId = null;
      fn(...lastArgs);
      lastArgs = null;
    }
  };

  return debounced;
}

export function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; delayMs?: number; backoff?: "linear" | "exponential" } = {},
): Promise<T> {
  const { maxAttempts = 3, delayMs = 100, backoff = "exponential" } = options;

  return new Promise<T>((resolve, reject) => {
    let attempt = 0;

    const tryOnce = async () => {
      attempt++;
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        if (attempt >= maxAttempts) {
          reject(error);
          return;
        }
        const delay = backoff === "exponential"
          ? delayMs * Math.pow(2, attempt - 1)
          : delayMs * attempt;
        setTimeout(tryOnce, delay);
      }
    };

    tryOnce();
  });
}
\`\`\`

Write tests using \`import { test, expect, describe, beforeEach, mock } from "bun:test"\`.

Cover:
- \`deepClone\`: primitives, objects, arrays, nested structures, Date, RegExp, Map, Set, circular reference handling (if supported), prototype chain behavior
- \`debounce\`: basic delay, rapid calls, cancel, flush, timing precision (use fake timers if available, or real timers with tolerance)
- \`retry\`: success on first try, success after retries, exhausted retries, exponential vs linear backoff timing, custom options

Aim for at least 25 test cases total with descriptive names.`,
  expectedOutcomes: [
    "At least 25 test cases with descriptive names",
    "deepClone tests for all data types including Map, Set, Date, RegExp",
    "debounce tests with timing verification and cancel/flush",
    "retry tests with mock functions and backoff verification",
    "Edge cases covered: empty inputs, null, undefined, nested structures",
  ],
  evaluationCriteria: {
    correctness: "Do the tests actually verify the correct behavior? Are assertions accurate?",
    completeness: "At least 25 tests? All three functions covered? Edge cases included? Cancel/flush tested?",
    codeQuality: "Descriptive test names? Good use of describe blocks? Clean assertions? No test interdependencies?",
  },
  timeoutMs: 120_000,
  maxCostUsd: 0.20,
};

const testingMedium: BenchmarkTask = {
  id: "testing-medium-integration",
  name: "API Integration Tests",
  category: "testing",
  difficulty: "medium",
  prompt: `Write integration tests for this HTTP API service, including error cases and edge cases.

\`\`\`typescript
// task-api.ts
interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done";
  priority: number; // 1-5
  assignee: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface TaskStore {
  tasks: Map<string, Task>;

  create(input: { title: string; description?: string; priority?: number; tags?: string[] }): Task;
  getById(id: string): Task | null;
  list(filters?: { status?: string; assignee?: string; tag?: string; minPriority?: number }): Task[];
  update(id: string, patch: Partial<Pick<Task, "title" | "description" | "status" | "priority" | "assignee" | "tags">>): Task;
  delete(id: string): boolean;
  bulkUpdate(ids: string[], patch: Partial<Pick<Task, "status" | "priority" | "assignee">>): { updated: number; errors: string[] };
  search(query: string): Task[];
}

// Assume this store is already implemented and works correctly.
// Your tests should verify the HTTP handler layer wrapping this store.

// handler.ts
function createTaskHandler(store: TaskStore) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // POST /tasks — create
      if (method === "POST" && path === "/tasks") {
        const body = await req.json();
        if (!body.title || typeof body.title !== "string" || body.title.trim() === "") {
          return Response.json({ error: "title is required" }, { status: 400 });
        }
        if (body.priority !== undefined && (typeof body.priority !== "number" || body.priority < 1 || body.priority > 5)) {
          return Response.json({ error: "priority must be 1-5" }, { status: 400 });
        }
        const task = store.create(body);
        return Response.json(task, { status: 201 });
      }

      // GET /tasks — list with optional filters
      if (method === "GET" && path === "/tasks") {
        const filters: Record<string, unknown> = {};
        if (url.searchParams.has("status")) filters.status = url.searchParams.get("status");
        if (url.searchParams.has("assignee")) filters.assignee = url.searchParams.get("assignee");
        if (url.searchParams.has("tag")) filters.tag = url.searchParams.get("tag");
        if (url.searchParams.has("minPriority")) filters.minPriority = Number(url.searchParams.get("minPriority"));
        const tasks = store.list(Object.keys(filters).length > 0 ? filters : undefined);
        return Response.json(tasks);
      }

      // GET /tasks/:id — get by id
      const getMatch = path.match(/^\\/tasks\\/([\\w-]+)$/);
      if (method === "GET" && getMatch) {
        const task = store.getById(getMatch[1]);
        if (!task) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(task);
      }

      // PATCH /tasks/:id — update
      const patchMatch = path.match(/^\\/tasks\\/([\\w-]+)$/);
      if (method === "PATCH" && patchMatch) {
        const body = await req.json();
        try {
          const task = store.update(patchMatch[1], body);
          return Response.json(task);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 404 });
        }
      }

      // DELETE /tasks/:id — delete
      const delMatch = path.match(/^\\/tasks\\/([\\w-]+)$/);
      if (method === "DELETE" && delMatch) {
        const deleted = store.delete(delMatch[1]);
        if (!deleted) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ deleted: true });
      }

      // POST /tasks/bulk-update — bulk update
      if (method === "POST" && path === "/tasks/bulk-update") {
        const body = await req.json();
        if (!Array.isArray(body.ids) || body.ids.length === 0) {
          return Response.json({ error: "ids array required" }, { status: 400 });
        }
        const result = store.bulkUpdate(body.ids, body.patch || {});
        return Response.json(result);
      }

      // GET /tasks/search?q=... — search
      if (method === "GET" && path === "/tasks/search") {
        const q = url.searchParams.get("q");
        if (!q) return Response.json({ error: "q parameter required" }, { status: 400 });
        return Response.json(store.search(q));
      }

      return Response.json({ error: "not found" }, { status: 404 });

    } catch (e) {
      if (e instanceof SyntaxError) {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
\`\`\`

Write integration tests using Bun test runner. Create a real \`TaskStore\` implementation (in-memory) for testing.

Cover:
1. **CRUD operations**: Create, Read, List, Update, Delete — happy paths
2. **Validation**: Missing title, invalid priority, invalid JSON body
3. **Filters**: List with status filter, assignee filter, tag filter, combined filters
4. **Error cases**: Get non-existent task, update non-existent, delete non-existent
5. **Bulk operations**: Bulk update multiple tasks, partial failures
6. **Search**: Basic search, no results, special characters
7. **Edge cases**: Empty body, extra fields, concurrent requests
8. **Status codes**: Verify correct HTTP status for each scenario

Aim for at least 30 test cases.`,
  expectedOutcomes: [
    "In-memory TaskStore implementation for testing",
    "At least 30 integration test cases",
    "All CRUD operations tested with proper assertions",
    "Validation error cases covered",
    "Filter combinations tested",
    "Correct HTTP status codes verified",
    "Bulk operations and search tested",
  ],
  evaluationCriteria: {
    correctness: "Do tests actually send HTTP requests to the handler? Are assertions checking the right things?",
    completeness: "At least 30 tests? All 8 coverage areas addressed? Edge cases included?",
    codeQuality: "Clean test structure? Good setup/teardown? Descriptive names? No test coupling?",
  },
  timeoutMs: 180_000,
  maxCostUsd: 0.25,
};

// ── All Tasks ───────────────────────────────────────────────────────

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  codingEasy,
  codingMedium,
  codingHard,
  debuggingEasy,
  debuggingMedium,
  refactoringEasy,
  refactoringMedium,
  reviewEasy,
  reviewMedium,
  architectureMedium,
  architectureHard,
  testingEasy,
  testingMedium,
];

export function getTasksByCategory(category: string): BenchmarkTask[] {
  return BENCHMARK_TASKS.filter((t) => t.category === category);
}

export function getTasksByDifficulty(difficulty: string): BenchmarkTask[] {
  return BENCHMARK_TASKS.filter((t) => t.difficulty === difficulty);
}

export function getTaskById(id: string): BenchmarkTask | undefined {
  return BENCHMARK_TASKS.find((t) => t.id === id);
}
