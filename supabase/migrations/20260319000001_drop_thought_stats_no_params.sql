-- Drop orphaned thought_stats() overload (zero params, from migration 004).
-- The parameterized version thought_stats(days_back integer DEFAULT NULL)
-- from migration 006 handles both all-time and windowed queries.
-- Having both overloads caused PostgREST ambiguity when called without args.

drop function if exists public.thought_stats();
