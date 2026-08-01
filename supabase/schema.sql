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
  -- 방 정원. 만들 때 3~8에서 고른다 (SPEC §17.6). players.seat 제약(1~8)과 짝이다.
  -- 하한 3: 정원 2면 사람 1 + 봇 1이라 스파이가 배정되지 않는다 (SPEC §8).
  -- 상한 8: 좌석 그리드가 8칸 기준이다. 기술적 한계가 아니다.
  -- 만든 뒤에는 바뀌지 않는다. 좌석·역할이 이미 이 수를 전제로 배정돼 있다.
  capacity      int  not null default 5 check (capacity between 3 and 8),
  -- 방 제목. 만들 때만 정하고 이후 바뀌지 않는다 (정원과 같은 취급).
  --
  -- ★ null 과 '' 을 구분하지 않는다 — 제약이 빈 문자열을 아예 막는다. "이름 없음"은
  --   null 하나뿐이고, 화면은 그때 방 코드로 대신 부른다. 두 가지 빈 값이 있으면
  --   "이름이 있는데 안 보이는" 상태가 생긴다.
  -- ★ 20자는 lib/server/room.ts 의 MAX_ROOM_NAME_LEN 과 같은 값이어야 한다.
  --   서버가 먼저 400으로 막으므로 이 제약은 우회 경로를 위한 두 번째 겹이다.
  name          text check (name is null or char_length(name) between 1 and 20),
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

-- 정원은 나중에 들어왔다. create table if not exists는 이미 있는 테이블의 컬럼도 제약도
-- 고치지 않으므로(파일 상단 참고) 컬럼과 제약을 따로 붙인다.
-- drop constraint를 먼저 하는 이유: 이 파일을 다시 돌릴 때 같은 이름이 이미 있으면
-- add constraint가 42710으로 죽는다. if not exists 형태가 제약에는 없다.
alter table rooms add column if not exists capacity int not null default 5;
alter table rooms drop constraint if exists rooms_capacity_check;
alter table rooms add constraint rooms_capacity_check check (capacity between 3 and 8);

-- 방 제목도 나중에 들어왔다. 정원과 같은 이유로 컬럼과 제약을 따로 붙인다.
-- 이미 있던 방은 null(이름 없음)이 되고, 화면이 코드로 대신 부른다.
alter table rooms add column if not exists name text;
alter table rooms drop constraint if exists rooms_name_check;
alter table rooms add constraint rooms_name_check
  check (name is null or char_length(name) between 1 and 20);

------------------------------------------------------------------------------
-- players
------------------------------------------------------------------------------
create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references rooms(id) on delete cascade,
  nickname   text not null,
  mask_id    text not null,
  -- 1 ~ rooms.capacity. 제약은 방마다 다를 수 없으므로 상한만 정원 최댓값인 8로 잡는다.
  -- 방별 상한은 pick_free_seat()이 room_capacity(room_id)로 지킨다 (SPEC §17.6).
  seat       int  not null check (seat between 1 and 8),
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

-- 좌석 상한을 5에서 8로 넓혔다. 인라인 check의 자동 이름은 <테이블>_<컬럼>_check라
-- players_seat_check다. 옛 DB에는 1~5짜리가 남아 있으므로 갈아끼운다.
alter table players drop constraint if exists players_seat_check;
alter table players add constraint players_seat_check check (seat between 1 and 8);

-- ★ (room_id, seat) 유니크를 **지연 가능**으로 바꾼다 (SPEC §15-3-결정).
--
--   시작할 때 전원의 자리를 한 순열로 다시 배정하는데(shuffle_seats), 유니크가 즉시
--   검사되면 update 도중 두 사람이 잠깐 같은 자리를 갖는 순간에 걸려 죽는다.
--   "빈 자리에 잠깐 피신시킨다"는 방법도 못 쓴다 — 정원이 다 찼으면 빈 번호가 없고,
--   범위 밖(음수)으로 밀면 players_seat_check 에 걸린다. 실제로 그렇게 한 번 깨졌다.
--
--   initially immediate 라 평소 동작은 그대로다(진짜 중복은 즉시 거절).
--   shuffle_seats 만 자기 트랜잭션에서 deferred 로 바꿔 쓴다.
--   nickname 도 같이 미룬다. 닉네임은 '익명' || seat 이라 자리와 한 몸이라서,
--   seat 만 미루면 이번엔 (room_id, nickname) 쪽에서 똑같이 깨진다.
alter table players drop constraint if exists players_room_id_seat_key;
alter table players drop constraint if exists players_room_seat_key;
alter table players add constraint players_room_seat_key
  unique (room_id, seat) deferrable initially immediate;

alter table players drop constraint if exists players_room_id_nickname_key;
alter table players drop constraint if exists players_room_nickname_key;
alter table players add constraint players_room_nickname_key
  unique (room_id, nickname) deferrable initially immediate;

-- ── 대기방 프리셋 발화 · 준비 상태 (SPEC §15-3-결정) ──────────────────────────
--
-- 대기방은 자유 채팅을 열지 않는다. 정해진 문구만 누를 수 있고, 그 목록은
-- lib/server/lobby-lines.ts 하나에 있다. 여기 있는 건 "지금 무슨 말풍선이 떠 있나"
-- 뿐이다.
--
-- ★ 발화를 **기록으로 쌓지 않는다.** 사람마다 현재 한 줄만 들고 있다.
--   로그로 쌓으면 순서 자체가 메시지가 되어(ㅋㅋㅋ 두 번 = 약속) 프리셋으로 좁힌
--   의미가 사라진다. messages 테이블에 넣지 않는 이유이기도 하다 — 거기 player_id로
--   남으면 shuffle_seats 가 끊어놓은 "로비의 그 사람 ↔ 게임의 이 자리"가 되살아난다.
--
-- ★ 넷 다 시작할 때 shuffle_seats 가 비운다. 안 비우면 봇만 null 이라
--   그 자체로 봇 명단이 된다 (I1). public_players 도 lobby 일 때만 내려주지만,
--   두 겹으로 막는다 — 한쪽이 빠져도 정체가 새면 게임이 즉시 끝난다.
alter table players add column if not exists is_ready boolean not null default false;
alter table players add column if not exists lobby_line text;
alter table players add column if not exists lobby_line_at timestamptz;
alter table players add column if not exists lobby_line_count int not null default 0;

-- ★ 대기방에서 부를 이름 (SPEC §15-2-결정). 계정을 만들 때 본인이 지은 이름을
--   **앉는 순간 여기로 베껴 온다.**
--
--   왜 profiles 를 조인해서 보여주지 않는가: 조인이면 게임이 시작돼도 그 이름이
--   계정에 그대로 남아 있어서, 뷰의 `phase = 'lobby'` 조건 **한 겹만** 방어가 된다.
--   여기로 베껴 오면 shuffle_seats 가 다른 대기방 값들과 함께 지울 수 있다.
--   이 저장소는 정체가 새는 자리를 늘 두 겹으로 막는다 — 한쪽이 빠져도 게임이
--   끝나지 않도록. lobby_line 과 정확히 같은 취급이다.
--
--   베껴 오는 시점이 고정이라는 이점도 있다. 대기 중에 계정 이름을 바꿔도 이미
--   앉은 자리의 이름은 흔들리지 않는다.
--
-- ★ null 일 수 있다. 로그인하지 않은 사람은 이름이 없고, 화면은 그때 '익명N' 으로
--   부른다. 대기방에는 사람만 있으므로(봇은 시작할 때 앉는다) 이 값이 비어 있다고
--   해서 봇이 드러나지는 않는다 — 그 전제가 깨지면 아래 ☐ 를 볼 것.
alter table players add column if not exists lobby_name text;

-- ★ 한 방에 같은 이름이 둘이면 대기방에서 누가 누구인지 못 가린다.
--
--   **방 안에서만** 겹치지 않으면 된다. 계정 이름(profiles.display_name)은 전체
--   유니크지만, 로그인하지 않은 사람이 그때그때 치는 이름까지 전역으로 묶을
--   수는 없다 — 그러면 남이 쓰는 이름이라는 이유로 못 들어오는 방이 생긴다.
--
--   lower() 로 묶는 이유는 계정 이름과 같다. 'Chulsoo' 와 'chulsoo' 가 대기방에
--   나란히 서면 눈으로 구별이 안 된다.
--
-- ★ 부분 인덱스다(where lobby_name is not null). 이름이 없는 사람은 여럿이어도
--   되고, shuffle_seats 가 전원을 null 로 만들 때 서로 부딪히지 않아야 한다.
create unique index if not exists players_room_lobby_name_key
  on players (room_id, lower(lobby_name)) where lobby_name is not null;

-- ── 계정 (SPEC §15-2-결정) ───────────────────────────────────────────────────
--
-- ★ 계정 세계와 방 세계를 잇는 다리는 이 컬럼 **하나뿐**이고,
--   public_players 뷰에 절대 들어가지 않는다 (I1).
--
--   왜 위험한가: **봇에게는 계정이 없다.** user_id가 뷰에 새면
--       select seat from public_players where user_id is null;
--   한 줄로 봇 명단 전체가 나온다. is_bot · created_at · token과 같은 급이다.
--   supabase/checks.sh의 "public_players 컬럼이 정확히 9개다"가 이걸 잡는다 —
--   뷰에 컬럼을 하나라도 더하면 그 검사가 먼저 빨간불이 된다.
--
-- ★ nullable이다. 봇은 null이고, 익명 인증이 아직 안 붙은 브라우저도 null이다.
--   not null로 조이면 로그인이 실패한 사람이 방에 못 들어온다 — 게임이 인증에
--   묶이면 안 된다. 계정은 전적을 위한 것이지 입장 조건이 아니다.
--
-- ★ on delete set null — 계정을 지워도 진행 중인 방이 깨지지 않는다.
--   cascade로 두면 탈퇴 한 번에 남의 게임에서 자리가 사라진다.
alter table players add column if not exists user_id uuid
  references auth.users(id) on delete set null;

create index if not exists players_user_idx on players (user_id) where user_id is not null;

-- 프로필. auth.users와 1:1이고, **이름이 붙은 계정만** 행을 갖는다.
--
-- 익명 계정에는 행이 없다 — 아직 부를 이름이 없기 때문이다. 구글을 연결하는
-- 순간(app/api/auth/callback) 서버가 여기에 한 행을 넣는다.
--
-- ★ display_name은 랭킹·친구 화면에만 나온다. 방 안에서는 끝까지 '익명N'이다.
--   두 이름이 한 화면에서 만나면 그 순간 익명성이 끝난다.
create table if not exists profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 20),
  avatar_url   text,
  created_at   timestamptz not null default now()
);

-- ★ 이름은 겹치지 않는다. **대소문자를 구분하지 않는다** — 'Chulsoo' 와 'chulsoo' 가
--   랭킹에 나란히 서면 같은 사람으로 보인다.
--
--   지금 당장은 랭킹 표시용이지만, 친구 목록은 **이름으로 사람을 찾는 기능**이라
--   중복이 있으면 성립하지 않는다. 나중에 붙이면 이미 겹친 이름들을 어떻게 할지
--   곤란해진다 — 정원(§17.6)과 같은 이유로 처음부터 조인다.
--
--   유니크 "제약"이 아니라 표현식 인덱스인 이유: 제약에는 lower() 같은 식을 못 쓴다.
create unique index if not exists profiles_display_name_key
  on profiles (lower(display_name));

-- ★ 이름은 **한 번 짓고 끝이다** (SPEC §15-2-결정 「이름은 한 번만 짓는다」).
--
--   왜 정책이 아니라 트리거인가: 쓰기는 전부 service role 서버를 지나는데(I9),
--   service role 은 RLS 를 **통과한다.** 정책을 아무리 걸어도 서버가 부르면 그냥 된다.
--   트리거는 service role 도 못 비껴간다. 이 규칙을 아는 자리가 라우트 하나뿐이면
--   나중에 프로필을 건드리는 경로가 하나 더 생기는 순간 조용히 뚫린다.
--
--   ★ avatar_url 은 계속 갱신된다. 그건 사용자가 고른 값이 아니라 구글이 준 것이라
--     로그인할 때마다 최신으로 덮어도 된다. 얼리는 것은 display_name 하나다.
create or replace function freeze_display_name() returns trigger
language plpgsql as $$
begin
  if new.display_name is distinct from old.display_name then
    raise exception '이름은 한 번 지으면 바꿀 수 없다' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_name_frozen on profiles;
create trigger profiles_name_frozen
  before update on profiles
  for each row execute function freeze_display_name();

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

-- ★ question_text — 이 문구가 **어느 질문에 대한 답인가** (SPEC §17.2).
--
--   null이면 질문을 가리지 않는 일반 문구다. 특화 문구가 봇 수보다 모자랄 때 뒤를 채운다.
--
--   컬럼을 따로 둔 이유: 예전에는 phase만 보고 뽑아서 '지금 휴대폰 배터리 몇 퍼센트야?'에
--   '어제랑 비슷했던 것 같아'가 나왔다. 사람은 숫자를 대는데 봇만 딴소리를 하니
--   **첫 질문 한 번으로 봇이 전부 갈렸다** (I1). 문구 품질이 아니라 짝맞춤의 문제다.
create table if not exists bot_line_pool (
  id            uuid primary key default gen_random_uuid(),
  phase         text not null check (phase in ('question','target','chat','vote')),
  question_text text,
  text          text not null
);

alter table bot_line_pool add column if not exists question_text text;

-- 옛 unique (phase, text)는 같은 문구를 두 질문에 못 쓰게 막는다 ('음 글쎄'는 여러 질문에
-- 어울린다). 표현식 유니크 인덱스로 바꾼다 — null끼리도 같은 것으로 취급해야 하므로
-- coalesce로 빈 문자열을 씌운다 (unique 제약은 null을 서로 다른 값으로 본다).
alter table bot_line_pool drop constraint if exists bot_line_pool_phase_text_key;
create unique index if not exists bot_line_pool_uniq
  on bot_line_pool (phase, coalesce(question_text, ''), text);

-- 질문 텍스트로 문구를 찾는다. 질문 풀이 커지면 이게 없으면 매 전환마다 풀스캔이다.
create index if not exists bot_line_pool_lookup_idx on bot_line_pool (phase, question_text);

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
