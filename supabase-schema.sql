-- FuelLog schema — run this in Supabase → SQL Editor → New query → Run.
-- Password-less, shared "friend group" model: the anon key has full access.
-- (Non-sensitive data only. The intervals.icu API key is NOT stored here — it
--  stays in each device's local storage.)

-- ---------- profiles ----------
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sex text not null check (sex in ('male','female')),
  birth_date date,
  height_cm numeric,
  weight_kg numeric,
  body_fat_pct numeric,
  goal_type text default 'maintain',
  goal_rate_kg_per_week numeric,
  races jsonb default '[]'::jsonb,
  intervals_athlete_id text,
  notes text,
  created_at timestamptz default now()
);

-- ---------- water logs (one row per profile per day) ----------
create table if not exists water_logs (
  profile_id uuid references profiles(id) on delete cascade,
  log_date date not null,
  glasses int not null default 0,
  primary key (profile_id, log_date)
);

-- ---------- open, password-less access for the anon key ----------
alter table profiles enable row level security;
alter table water_logs enable row level security;

create policy "anon full access profiles" on profiles
  for all to anon using (true) with check (true);
create policy "anon full access water" on water_logs
  for all to anon using (true) with check (true);

-- Food tables (food_logs, foods cache) are added in the next build,
-- once we start on food logging.
