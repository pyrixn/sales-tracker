-- Closes the Supabase security advisor warning "Public Can Execute SECURITY DEFINER Function"
-- for public.rls_auto_enable().
--
-- That function is not created by this repository's migrations; it exists on the live project
-- (it looks like a project-level helper that turns on row level security for new tables).
-- Because it is SECURITY DEFINER and lives in the public schema, the anon and authenticated roles
-- could call it through /rest/v1/rpc/rls_auto_enable. This project has no public anon-key path
-- (all traffic goes through the Edge Function with the service role), so nobody but the
-- database owner should be able to run it.
--
-- Revoking EXECUTE does not affect an event trigger that calls the function: event triggers run
-- with the owner's rights. The block is guarded so the migration is a no-op on a database
-- where the function does not exist, and it is safe to run more than once.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0
  ) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;
