-- 사람인 척 (whois-human) — 테이블 · 인덱스
-- SPEC §4. 소유: A
--
-- 적용:
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/schema.sql
--   (SPEC §12.2 — 마이그레이션은 직결 포트 5432, 런타임은 풀러 6543)

create table rooms (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,
  phase         text not null default 'lobby',
  phase_seq     int  not null default 0,
  phase_ends_at timestamptz,
  round         int  not null default 0,
  host_id       uuid,
  created_at    timestamptz not null default now()
);

create table players (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  nickname   text not null,
  mask_id    text not null,
  seat       int  not null,
  is_bot     boolean not null default false,
  connected  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (room_id, seat)
);

-- 절대 클라이언트에 노출되지 않는다
create table player_roles (
  player_id uuid primary key references players(id) on delete cascade,
  room_id   uuid not null references rooms(id) on delete cascade,
  role      text not null
);

create table questions (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references rooms(id) on delete cascade,
  round     int  not null,
  kind      text not null,
  text      text not null,
  asked_by  uuid references players(id),
  target_id uuid references players(id)
);

create table answers (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  room_id     uuid not null references rooms(id) on delete cascade,
  player_id   uuid not null references players(id) on delete cascade,
  text        text not null,
  visible_at  timestamptz not null default now(),
  unique (question_id, player_id)
);

create table messages (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  text       text not null,
  visible_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table votes (
  room_id   uuid not null references rooms(id) on delete cascade,
  voter_id  uuid not null references players(id) on delete cascade,
  target_id uuid not null references players(id) on delete cascade,
  reason    text not null default '',
  primary key (room_id, voter_id)
);

create table agent_logs (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references rooms(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  ref_id    uuid,
  reasoning text not null,
  suspicion real not null default 0,
  action    text not null
);

create index on players (room_id);
create index on messages (room_id, visible_at);
create index on answers  (room_id, question_id);
