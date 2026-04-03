# Security Audit

Comprehensive security analysis of Open Brain Server. Covers the authentication
model, tenant isolation, database security, pipeline safety, export process,
and known gaps. Last audited: 2026-04-03.

## Threat Model

Open Brain is a self-hostable MCP server. The primary threat surface is:

- **External attackers** probing the Edge Function endpoints
- **Cross-tenant access** between brains in a multi-tenant deployment
- **Secret leakage** through code, logs, error messages, or git history
- **Supply chain compromise** through dependencies
- **LLM-augmented scanning** — automated analysis of every code path

The system assumes the Supabase service role key is trusted. All untrusted
access goes through Edge Functions with API key authentication.

---

## Authentication

### How it works

```
Request
  |
  v
extractKeyFromRequest()       x-brain-key header, ?key= param, or /path/<key>
  |
  v
resolveAuth()
  |-- Admin key?  ------>  Compare against ADMIN_KEY env var
  |                        Return { brainId: "admin", isAdmin: true }
  |
  |-- Brain key?  ------>  SHA-256 hash the key
  |                        Lookup key_hash in brain_api_keys table
  |                        Check revoked_at IS NULL
  |                        Return { brainId: <from DB>, isAdmin: false }
  |
  |-- Neither?    ------>  Return 401 Unauthorized
```

**Key file:** `supabase/functions/_shared/auth.ts`

### Design decisions

- **Keys are SHA-256 hashed** before storage. Plaintext keys are never persisted
  in the database. The `key_prefix` column allows users to identify keys without
  exposing the full value.
- **Path-based auth** is supported because Claude Code strips custom headers in
  some configurations. The key can be passed via header, query param, or URL path.
- **Admin key** is a separate env var (`ADMIN_KEY`) used only for brain
  provisioning and management. It is not stored in the database.
- **Key revocation** via `revoked_at` timestamp enables graceful rotation —
  old keys can be revoked without deleting the record.

### Comparison method

API key comparison uses JavaScript strict equality (`===`). In a serverless
Edge Function environment, network jitter dominates any timing signal from
string comparison, making timing attacks impractical. The admin key check
occurs before the database lookup, so invalid admin keys don't hit the DB.

---

## Tenant Isolation

### Architecture

Every piece of data in Open Brain is scoped to a `brain_id`:

1. **Database layer:** All tables have a `brain_id` column. All RPC functions
   accept `p_brain_id` and filter with `WHERE brain_id = p_brain_id`.
2. **Application layer:** The auth middleware resolves the API key to a
   `brain_id` from the database. This value is set in the request context
   and passed to every tool handler. The brain_id comes from the DB lookup,
   not from user input.
3. **Database enforcement:** Row Level Security on all 9 tables restricts
   direct access to `service_role` only. The anon key cannot read or write
   any table.

### What this means

- A valid API key can only access data belonging to its assigned brain
- There is no parameter a caller can set to access another brain's data
- Even if an attacker obtains the anon key, RLS blocks all direct DB access
- The service role key (which bypasses RLS) is only used server-side in
  Edge Functions, never exposed to clients

### Verified by integration tests

The multi-tenant integration test (`tests/integration/multi-tenant_test.ts`)
runs 16 verification steps:

1. Provision a test brain, verify API key format
2. Confirm empty brain baseline (0 thoughts)
3. Capture a thought in the test brain
4. **Search isolation:** Test brain finds its own thought
5. **Search isolation:** Owner brain cannot find test brain's thought
6. **Cross-brain delete protection:** Owner key cannot delete test brain's thought
7. **Cross-brain update protection:** Owner key cannot update test brain's thought
8. Owner brain stats unchanged after test brain operations
9. Cleanup and verify deleted brain's key returns 401

A second test provisions two brains, captures identical content in both,
and verifies neither triggers cross-brain dedup — each brain is fully isolated.

---

## Row Level Security

**Migration:** `supabase/migrations/20260403000001_row_level_security.sql`

All 9 tables have RLS enabled and forced:

| Table | Policy |
|-------|--------|
| thoughts | service_role_only |
| thought_connections | service_role_only |
| entities | service_role_only |
| thought_entities | service_role_only |
| brains | service_role_only |
| brain_api_keys | service_role_only |
| merge_audit_log | service_role_only |
| pipeline_runs | service_role_only |
| pipeline_processed | service_role_only |

Each table has:
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON <table>
  FOR ALL USING (current_setting('role') = 'service_role');
```

`FORCE ROW LEVEL SECURITY` is critical — without it, the table owner role
bypasses RLS policies. With FORCE, even the postgres role is subject to RLS.

---

## Database Security

### Parameterized queries

All Supabase client queries use the builder pattern (`.eq()`, `.select()`,
`.insert()`, `.rpc()`). No raw SQL string concatenation exists in the
Edge Function layer.

In SQL migrations, the one case of dynamic SQL (`ts_stat()` in
`hybrid_search_thoughts`) uses PostgreSQL's `format()` with `%L`
(literal escaping) — the correct pattern for this function's requirements.

### RPC function scoping

All 21 RPC functions accept `p_brain_id` and scope queries accordingly:

- `match_thoughts` — `WHERE brain_id = p_brain_id`
- `hybrid_search_thoughts` — `WHERE brain_id = p_brain_id`
- `graph_expanded_search` — neighbor and expanded lookups both check brain_id
- `resolve_entities` — `WHERE brain_id = p_brain_id`
- `perform_merge` — `WHERE id = p_id AND brain_id = p_brain_id`
- `find_dedup_candidates` — `WHERE t.brain_id = p_brain_id`
- `get_thought_connections` — checks brain_id on both connections and thoughts
- `increment_access_count` — `WHERE id = ANY(thought_ids) AND brain_id = p_brain_id`
- All analysis functions — scoped by brain_id

No RPC function returns data across brain boundaries.

### Merge audit log

Irreversible merge operations are tracked in `merge_audit_log`:
- Full content of the deleted ("loser") thought is preserved
- Merge type recorded: `auto`, `llm_confirmed`, `ingest_dedup`
- Survivor ID uses `ON DELETE SET NULL` so audit survives even if survivor
  is later deleted

---

## Error Handling

### What's exposed to clients

- Auth failures: `{ error: "Unauthorized" }` (no details about why)
- Method errors: `{ error: "Method not allowed" }`
- Tool errors: Generic error messages from MCP tool handlers
- Admin routes: Database error messages are included in responses
  (`Failed to create brain: ${error.message}`). These are behind admin
  auth and not accessible to regular API key holders.

### What stays server-side

- Stack traces are logged to Supabase function logs, not returned to clients
- Database constraint names and column details stay in server logs
- API keys are never logged (hashed before any logging could occur)

---

## Pipeline Security

### Edge Function pipeline (`run-pipeline`)

- Triggered by GitHub Actions cron (schedule-only, no checkout trigger)
- Authenticated via `x-brain-key` header
- All captures go to `OWNER_BRAIN_ID` (hardcoded in env, not user-controlled)
- External API calls to public endpoints only (HuggingFace, Emergent Mind, RSS feeds)
- No user input controls fetched URLs (SSRF mitigated)

### Python pipeline (local)

- Runs locally, not exposed as a service
- Authenticates to Open Brain MCP via API key in `.env`
- Reddit fetching uses public `.json` endpoints (no auth, no API key)
- OpenRouter calls use API key from environment only
- Dedup state stored in local JSON files (`pipeline/data/`), not shipped

### Pipeline monitoring

`pipeline_runs` and `pipeline_processed` tables are system-level — they do
not filter by `brain_id`. This is by design: pipeline monitoring is an
operational concern. The `monitor-pipeline` Edge Function requires API key
auth but returns global pipeline metrics.

---

## Secret Management

### What requires secrets

| Secret | Used By | Storage |
|--------|---------|---------|
| `SUPABASE_URL` | All Edge Functions | Supabase env |
| `SUPABASE_SERVICE_ROLE_KEY` | All Edge Functions | Supabase env |
| `OPENROUTER_API_KEY` | Embedding + metadata extraction | Supabase env |
| `MCP_ACCESS_KEY` | Pipeline + monitoring auth | Supabase env |
| `ADMIN_KEY` | Brain provisioning | Supabase env |
| `TELEGRAM_BOT_TOKEN` | Telegram capture | Supabase env |
| `TELEGRAM_SECRET_TOKEN` | Webhook verification | Supabase env |
| `TELEGRAM_ALLOWED_CHAT_ID` | Telegram sender allowlist | Supabase env |

### How secrets are protected

- Never hardcoded in source code (parameterized across 8 files during extraction)
- Never committed to git (`.env.local` and `pipeline/.env` are gitignored)
- API keys hashed with SHA-256 before database storage
- Export script scans for 3 known secret patterns before completing
- `.env.example` files contain only placeholder values

---

## Export Process Security

The export script (`scripts/export-public.sh`) produces a clean public repo:

### What's included
- Edge Functions source code
- SQL migrations
- Pipeline Python code (with config templatized)
- GitHub Actions workflows (secrets via `${{ secrets.* }}`)
- Documentation, LICENSE, SECURITY.md
- Integration tests

### What's excluded
- `.env` / `.env.local` files (actual secrets)
- `pipeline/data/` (local dedup state)
- `pipeline/autoresearch/` (internal tooling)
- `pipeline/logs/` and `__pycache__/`
- Git history (export uses `cp`, not `git clone`)
- Private strategy docs (TRACKER.md, research/, discoveries/, .planning/)

### Secret scanning

The export script runs an automated scan before completing:

```bash
grep -rn '<supabase-project-ref>|<jwt-prefix>|<openrouter-key-prefix>' "$OUTPUT" \
  --include='*.ts' --include='*.py' --include='*.sh' \
  --include='*.ps1' --include='*.sql' --include='*.md' \
  --include='*.json'
```

Three patterns are checked (actual patterns defined in the export script):
- Supabase project reference substring
- JWT token prefix (base64-encoded `{"alg":` header)
- OpenRouter API key prefix

The script exits with error code 1 if any pattern matches, preventing
accidental publication.

### Verified clean

Post-export verification confirms:
- No `.git` directory in output
- No `.env` files in output
- No `.pyc`, `__pycache__`, `.log`, `.sqlite`, `.db` files
- No matches for: JWT tokens, API key patterns (`sk-`, `AKIA`), Supabase
  project ref, IP addresses, email addresses, Telegram chat IDs, private
  keys, long base64 blobs, personal names
- GitHub Actions workflows use only `${{ secrets.* }}` references
- Test fixtures use obviously fake values (`"test-key"`, `"12345"`)

---

## Supply Chain

### Deno Edge Functions (low risk)

- 5 dependencies via `npm:` specifiers
- `deno.lock` provides integrity hashes
- Deno ignores npm install scripts (no arbitrary code execution on install)
- No `postinstall` or lifecycle script attack surface

### Python Pipeline (medium risk)

- 3 dependencies: `requests`, `feedparser`, `python-dotenv`
- Currently using `>=` version specifiers
- **Recommendation:** Pin exact versions with `uv pip compile` for
  reproducible, hash-verified installs

### GitHub Actions (low risk)

- Schedule-only triggers (no `pull_request_target` or checkout-based triggers)
- No third-party actions beyond standard `curl`
- Secrets managed via GitHub repository secrets

---

## Known Gaps

| Gap | Severity | Status | Mitigation |
|-----|----------|--------|------------|
| Python deps not pinned to exact versions | Medium | Open | Use `uv pip compile` for hashed lock file |
| Admin route error messages include DB details | Low | Accepted | Admin routes require separate ADMIN_KEY |
| No automated key rotation | Low | Backlog | Manual quarterly rotation; revocation supported |
| No rate limiting on API endpoints | Medium | Backlog | Supabase Edge Functions have platform-level limits |
| No request logging/audit trail | Low | Backlog | `last_used_at` on API keys provides basic tracking |
| `===` for admin key comparison (not constant-time) | Very Low | Accepted | Network jitter in serverless makes timing attacks impractical |

---

## Security Checklist for Self-Hosters

Before deploying Open Brain:

- [ ] Generate strong, random API keys (minimum 32 characters)
- [ ] Set all environment variables via `supabase secrets set`
- [ ] Apply all SQL migrations (`supabase db push --linked`)
- [ ] Verify RLS is active: query `pg_tables` for `rowsecurity = true`
- [ ] Use separate `ADMIN_KEY` from regular API keys
- [ ] Keep `SUPABASE_SERVICE_ROLE_KEY` secret — never expose to clients
- [ ] For Telegram: set `TELEGRAM_SECRET_TOKEN` and `TELEGRAM_ALLOWED_CHAT_ID`
- [ ] Review GitHub Actions secrets if using pipeline scheduling
- [ ] Consider pinning Python dependencies for pipeline scripts
- [ ] Rotate API keys periodically (revoke old, create new)
