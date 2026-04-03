-- Force PostgREST schema cache reload by notifying pgrst channel.
NOTIFY pgrst, 'reload schema';
