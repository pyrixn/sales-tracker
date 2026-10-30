-- Staff accounts and roles (phase 2). Sign-in is Supabase Auth. The Edge Function verifies the login token and reads the role
-- from the token claim app_role, which the Custom Access Token hook below copies from this table.

-- One row per person who may use the panel. Owner, staff and viewer as in src/core/permissions.js.
create table if not exists staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '',
  role text not null check (role in ('owner', 'staff', 'viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table staff enable row level security;
-- No policies, like every table here. The Edge Function uses the service role; the hook below runs as the function owner.

-- Who made each change. '' is system work, 'secret' is the panel password, otherwise the Supabase user id of a staff login.
alter table change_log add column if not exists actor text not null default '';

-- Custom Access Token hook. The owner turns it on once in the Supabase dashboard:
--   Authentication > Hooks > Custom Access Token > public.custom_access_token_hook
-- It adds app_role to the login token for an active staff row. Inactive or unknown users get no claim and the Edge Function refuses them.
-- security definer runs it as this migration's owner, so it reads staff without a policy.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  r text;
begin
  select s.role into r
    from public.staff s
    where s.user_id = (event->>'user_id')::uuid and s.active;
  if r is not null then
    claims := jsonb_set(claims, '{app_role}', to_jsonb(r));
  end if;
  return jsonb_build_object('claims', claims);
end;
$$;

revoke execute on function public.custom_access_token_hook from public, anon, authenticated;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;

-- Owner bootstrap: NOT run by this file. After you create your login, run once in the SQL editor with your auth user id:
--   insert into staff (user_id, email, role) values ('<your auth user id>', 'you@example.com', 'owner');
