-- 사람인 척 (whois-human) — 테이블 · 인덱스 · 트리거
-- SPEC §4, §17. 소유: A
--
-- 적용 순서 (SPEC §12.2 — 마이그레이션은 직결 포트 5432):
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/schema.sql
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/policies.sql
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/seed.sql
--   psql "$SUPABASE_DB_URL_DIRECT" -f supabase/functions/advance_phase.sql
--
-- 이 파일은 여러 번 돌려도 된다. 전부 if not exists / or replace다.
-- 다만 create table if not exists는 **이미 있는 테이블의 제약을 고치지 않는다.**
-- 옛 스키마를 이미 적용했다면 처음부터 다시 만드는 게 빠르다.

create extension if not exists pgcrypto;

------------------------------------------------------------------------------
-- rooms
------------------------------------------------------------------------------
create table if not exists rooms (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,
  phase         text not null default 'lobby'
                check (phase in ('lobby','question','target','chat','vote','reveal','replay')),
  -- 전환마다 +1. 중복 전환을 막는 낙관적 잠금 키다 (I6). 라운드 번호가 아니다.
  phase_seq     int  not null default 0,
  phase_ends_at timestamptz,
  round         int  not null default 0 check (round between 0 and 2),
  host_id       uuid,
  -- SPEC §17.3 — 참가자 명단이 바뀌었다는 신호. 클라이언트는 이미 걸어둔 rooms 구독에서
  -- 이 값의 변화를 보고 public_players를 다시 읽는다.
  -- phase_seq와 헷갈리지 않는다. 이건 잠금 키가 아니라 그냥 신호다.
  roster_seq    int  not null default 0,
  created_at    timestamptz not null default now()
);

-- 이미 옛 rooms가 있는 DB를 위한 보정
alter table rooms add column if not exists roster_seq int not null default 0;

------------------------------------------------------------------------------
-- players
------------------------------------------------------------------------------
create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  nickname   text not null,
  mask_id    text not null,
  seat       int  not null check (seat between 1 and 5),
  -- ★ 클라이언트에 절대 내려가지 않는다 (I1). public_players 뷰를 거친다.
  is_bot     boolean not null default false,
  connected  boolean not null default true,
  -- SPEC §17.4 — 입장 시 발급하는 본인 확인용 토큰. httpOnly 쿠키로만 오간다.
  -- is_bot과 같은 급으로 다룬다. 뷰에 절대 넣지 않는다.
  token      text not null default encode(gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now(),
  unique (room_id, seat),
  unique (room_id, nickname),
  unique (token)
);

alter table players add column if not exists token text not null
  default encode(gen_random_bytes(32), 'hex');

-- 절대 클라이언트에 노출되지 않는다 (SPEC §7.2 — 정책을 만들지 않는다)
create table if not exists player_roles (
  player_id uuid primary key references players(id) on delete cascade,
  room_id   uuid not null references rooms(id) on delete cascade,
  role      text not null check (role in ('citizen','spy','ai'))
);

------------------------------------------------------------------------------
-- 질문 · 답변 · 채팅 · 투표
------------------------------------------------------------------------------
create table if not exists questions (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references rooms(id) on delete cascade,
  round     int  not null,
  kind      text not null check (kind in ('common','target')),
  text      text not null,
  asked_by  uuid references players(id),   -- target일 때만
  target_id uuid references players(id)    -- target일 때만
);

create table if not exists answers (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  room_id     uuid not null references rooms(id) on delete cascade,
  player_id   uuid not null references players(id) on delete cascade,
  text        text not null,
  -- 이 시각 이후에만 보인다 (RLS가 막는다). created_at이 아니다 — 미래일 수 있다.
  visible_at  timestamptz not null,
  unique (question_id, player_id)
);

create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  text       text not null,
  visible_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- visible_at에 default now()를 두지 않는다. 넣는 걸 깜빡하면 사람 답변이 제출 즉시
-- 남에게 보여서 SPEC §13-4가 깨진다. 조용히 새느니 insert가 실패하는 편이 낫다.
alter table answers  alter column visible_at drop default;
alter table messages alter column visible_at drop default;

create table if not exists votes (
  room_id   uuid not null references rooms(id) on delete cascade,
  voter_id  uuid not null references players(id) on delete cascade,
  target_id uuid not null references players(id) on delete cascade,
  reason    text not null default '',
  primary key (room_id, voter_id)
);

create table if not exists agent_logs (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references rooms(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  ref_id    uuid,
  reasoning text not null,
  suspicion real not null default 0,
  action    text not null
);
-- LLM을 붙일 때 created_at · tokens · fallback 컬럼을 더한다 (SPEC §12.6, §17.5).
-- 지금은 AI를 쓰지 않으므로 남길 게 없다.

------------------------------------------------------------------------------
-- 문구 풀 — SPEC §17.2. AI 없이 봇이 말하게 하는 재료다.
------------------------------------------------------------------------------
-- ★ 이 두 테이블은 클라이언트에게 절대 보이면 안 된다.
--   봇 문구 풀을 읽을 수 있으면 발언을 풀과 대조해 봇을 즉시 특정할 수 있다 (I1).
--   policies.sql에서 RLS만 켜고 정책을 만들지 않는다.
create table if not exists question_pool (
  id   uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('common','target')),
  text text not null,
  unique (kind, text)
);

create table if not exists bot_line_pool (
  id    uuid primary key default gen_random_uuid(),
  phase text not null check (phase in ('question','target','chat','vote')),
  text  text not null,
  unique (phase, text)
);

------------------------------------------------------------------------------
-- 인덱스
------------------------------------------------------------------------------
create index if not exists players_room_idx         on players      (room_id);
create index if not exists messages_room_vis_idx    on messages     (room_id, visible_at);
create index if not exists answers_room_q_idx       on answers      (room_id, question_id);
create index if not exists questions_room_round_idx on questions    (room_id, round);
create index if not exists agent_logs_room_idx      on agent_logs   (room_id);
create index if not exists player_roles_room_idx    on player_roles (room_id);

-- pg_cron 워치독이 15초마다 훑는다. 없으면 방이 쌓일수록 전체 스캔이 된다 (SPEC §16.3)
create index if not exists rooms_expiry_idx on rooms (phase_ends_at)
  where phase_ends_at is not null;
-- 끝난 방 정리용 (SPEC §16.4)
create index if not exists rooms_created_idx on rooms (created_at);

------------------------------------------------------------------------------
-- 명단 신호 트리거 — SPEC §17.3
------------------------------------------------------------------------------
-- 뷰(public_players)는 Postgres Changes로 구독할 수 없다. publication에는 테이블만
-- 들어가고 뷰는 WAL을 만들지 않기 때문이다. players 테이블을 구독하면 is_bot이 실려
-- 나간다(I1). 그래서 데이터는 안 보내고 "바뀌었다"는 신호만 rooms에 남긴다.
create or replace function bump_roster_seq() returns trigger
language plpgsql as $$
begin
  update rooms
     set roster_seq = roster_seq + 1
   where id = coalesce(new.room_id, old.room_id);
  return null;
end;
$$;

drop trigger if exists players_roster_bump on players;
create trigger players_roster_bump
  after insert or update or delete on players
  for each row execute function bump_roster_seq();

------------------------------------------------------------------------------
-- Realtime publication — SPEC §6
------------------------------------------------------------------------------
-- 이게 없으면 rooms 변경이 한 건도 배달되지 않는다. Postgres Changes는 publication을
-- 타고 나가기 때문이다. rooms만 넣는다 — 나머지는 Broadcast이거나 아예 안 보낸다.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table rooms;
  end if;
end $$;

-- replica identity는 default(PK)로 충분하다. 클라이언트 필터가 id=eq.<room_id>이고
-- 그건 PK라 payload에 항상 실린다 (SPEC §6.3).
