# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Open Brain, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) to submit your report.

We will acknowledge receipt within 48 hours and provide a detailed response within 7 days.

## Scope

This policy covers:
- The MCP server (Edge Functions)
- Database schema and RPC functions
- Authentication and authorization logic
- Pipeline ingestion functions

## Security Architecture

- **Authentication:** API keys are SHA-256 hashed and stored in `brain_api_keys`. Keys are never stored in plaintext.
- **Tenant isolation:** All queries are scoped by `brain_id` at both the application layer (every tool handler) and the database layer (RLS policies).
- **Row Level Security:** All tables enforce RLS with `service_role` only access. Direct database access via anon key is blocked.
