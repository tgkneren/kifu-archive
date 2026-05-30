create extension if not exists pgcrypto;

create table if not exists public.public_games (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  owner_token_hash text not null,
  owner_user_id uuid,
  owner_handle text not null default '',
  hidden_at timestamptz,
  hidden_by_user_id uuid,
  sgf_hash text not null unique,
  title text not null default 'Untitled SGF record',
  black_player_name text not null default '',
  white_player_name text not null default '',
  date text not null default '',
  board_size text not null default '19x19',
  komi text not null default '',
  result text not null default '',
  event text not null default '',
  opponent_visibility text not null default 'show',
  recorder_color text not null default '',
  recorder_nickname text not null default 'Anonymous recorder',
  notes text not null default '',
  sgf text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.public_games add column if not exists opponent_visibility text not null default 'show';
alter table public.public_games add column if not exists recorder_color text not null default '';
alter table public.public_games add column if not exists owner_user_id uuid;
alter table public.public_games add column if not exists owner_handle text not null default '';
alter table public.public_games add column if not exists hidden_at timestamptz;
alter table public.public_games add column if not exists hidden_by_user_id uuid;

create index if not exists public_games_created_at_idx on public.public_games (created_at desc);
create index if not exists public_games_event_idx on public.public_games (event);
create index if not exists public_games_result_idx on public.public_games (result);
create index if not exists public_games_owner_user_id_idx on public.public_games (owner_user_id);
create index if not exists public_games_visible_created_at_idx on public.public_games (created_at desc) where hidden_at is null;

alter table public.public_games enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on table public.public_games to service_role;

drop trigger if exists public_games_set_updated_at on public.public_games;
drop function if exists public.set_updated_at();

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger public_games_set_updated_at
before update on public.public_games
for each row execute function public.set_updated_at();

create table if not exists public.local_archive_backups (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique,
  records jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists local_archive_backups_owner_user_id_idx on public.local_archive_backups (owner_user_id);

alter table public.local_archive_backups enable row level security;

grant select, insert, update, delete on table public.local_archive_backups to service_role;

drop trigger if exists local_archive_backups_set_updated_at on public.local_archive_backups;

create trigger local_archive_backups_set_updated_at
before update on public.local_archive_backups
for each row execute function public.set_updated_at();
