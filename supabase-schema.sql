create table if not exists public.flowtree_user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.flowtree_user_state enable row level security;

drop policy if exists "Users can read their FlowTree state" on public.flowtree_user_state;
create policy "Users can read their FlowTree state"
on public.flowtree_user_state
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their FlowTree state" on public.flowtree_user_state;
create policy "Users can create their FlowTree state"
on public.flowtree_user_state
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their FlowTree state" on public.flowtree_user_state;
create policy "Users can update their FlowTree state"
on public.flowtree_user_state
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'flowtree-task-images',
  'flowtree-task-images',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their FlowTree images" on storage.objects;
create policy "Users can read their FlowTree images"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'flowtree-task-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can upload their FlowTree images" on storage.objects;
create policy "Users can upload their FlowTree images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'flowtree-task-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can delete their FlowTree images" on storage.objects;
create policy "Users can delete their FlowTree images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'flowtree-task-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
