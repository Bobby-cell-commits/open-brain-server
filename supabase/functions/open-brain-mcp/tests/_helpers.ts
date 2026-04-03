// Test helpers for MCP tool handler testing.
//
// IMPORT ORDER MATTERS: import this module FIRST in every test file.
// It sets env vars that supabase-client.ts reads at evaluation time.
// Because ESM evaluates in depth-first post-order, this module's
// top-level code runs before supabase-client.ts (which is imported
// by the tool modules listed after this in your test file).

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");
Deno.env.set("OPENROUTER_API_KEY", "test-key");
Deno.env.set("MCP_ACCESS_KEY", "test-key");

// Stop Supabase auth timers that trigger Deno's leak detector.
// Dynamic import ensures env vars are set before supabase-client.ts evaluates.
const { supabaseAdmin: _client } = await import("../../_shared/supabase-client.ts");
_client.auth.stopAutoRefresh();
// Drain any one-shot auth initialization timer before tests start.
await new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// Mock MCP server — captures handlers registered via mcp.tool()
// ---------------------------------------------------------------------------

export function createMockMcp() {
  const tools = new Map<string, (args: any) => Promise<any>>();
  const mcp = {
    tool(
      name: string,
      config: { handler: (args: any) => Promise<any>; [k: string]: unknown },
    ) {
      tools.set(name, config.handler);
    },
  };
  return { mcp, tools };
}

// ---------------------------------------------------------------------------
// Chainable mock for Supabase query builders
// ---------------------------------------------------------------------------
// Any method call returns the chain; `await` resolves to `result`.
// Supports arbitrary chains like .from().select().order().limit().eq()

export function mockChain(result: Record<string, unknown>): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: (v: any) => void) => res(result);
        if (typeof prop === "symbol") return undefined;
        return (..._a: unknown[]) => mockChain(result);
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Supabase stubbing — replace .from() / .rpc() on the client instance
// ---------------------------------------------------------------------------

export function stubFrom(
  client: any,
  fn: (table: string, ...rest: any[]) => any,
) {
  client.from = fn;
}

export function stubRpc(
  client: any,
  fn: (name: string, args?: any) => any,
) {
  client.rpc = fn;
}

// Delete own-property overrides so prototype methods re-surface
export function restore(client: any) {
  delete client.from;
  delete client.rpc;
}

// ---------------------------------------------------------------------------
// Brain context mock — provides authInfo.extra.brainId to tool handlers
// ---------------------------------------------------------------------------

export const TEST_BRAIN_ID = "test-brain-00000000";

export function mockCtx(brainId = TEST_BRAIN_ID): any {
  return { authInfo: { extra: { brainId } } };
}

// ---------------------------------------------------------------------------
// Recording mock chain — captures method calls for assertion
// ---------------------------------------------------------------------------

export interface CallRecord { method: string; args: unknown[]; }

export function mockChainRecording(
  result: Record<string, unknown>,
  calls: CallRecord[] = [],
): any {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: any) => void) => res(result);
      if (typeof prop === "symbol") return undefined;
      return (...a: unknown[]) => {
        calls.push({ method: String(prop), args: a });
        return mockChainRecording(result, calls);
      };
    },
  });
}
