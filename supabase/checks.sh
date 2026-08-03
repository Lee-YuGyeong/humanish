#!/usr/bin/env bash
#
# 사람인 척 (whois-human) — 스키마가 제대로 올라갔는지 보는 검사 묶음. 소유: A
#
# ┌─ 왜 파일을 따로 뺐나 ────────────────────────────────────────────────────┐
# │ apply.sh(배포 DB)와 test.sh(일회용 로컬 PG)가 각자 검사를 들고 있었고,   │
# │ 그래서 **한쪽만 아는 사실**이 생겼다. 두 번 데였다.                      │
# │                                                                         │
# │  · apply.sh만 보던 것 — create_room 시그니처. 그런데 그 검사가 애초에    │
# │    통과할 수 없는 모양이었다(pg_get_function_identity_arguments는 인자   │
# │    이름까지 준다). test.sh는 시그니처를 안 봐서 로컬은 계속 초록불.      │
# │  · test.sh만 보던 것 — SQL 여섯 개 전부. apply.sh가 room.sql·chat.sql을  │
# │    안 올리고 있어서 배포 DB에서만 방 만들기가 죽었다 (커밋 152f825).     │
# │                                                                         │
# │ 목록이 하나면 한쪽에서 고친 것이 반대쪽에도 그대로 걸린다.               │
# │ **검사를 새로 추가할 때는 여기에 넣는다.** 어느 한쪽에만 넣지 않는다.    │
# └─────────────────────────────────────────────────────────────────────────┘
#
# 호출 규약 — source 하기 전에 아래 둘을 정의해 둔다.
#   q "<sql>"                       한 줄짜리 결과를 표준출력으로
#   check "<이름>" "<기대>" "<실제>"  다르면 FAIL=1
#
# pg_cron 워치독 등록은 여기 없다. 로컬 Postgres에는 확장이 없어서 배포 DB에서만
# 의미가 있고, apply.sh가 따로 본다.

# 함수가 없으면 has_function_privilege는 **에러**다. set -o pipefail 아래서는 그 자리에서
# 스크립트가 죽는다. oid로 바꿔 물으면 없을 때 0행(빈 문자열)이 되어, check가
# "기대 f / 실제 (빈칸)"으로 잡아준다 — 죽지 않고 원인이 보인다.
anon_can() {
  q "select has_function_privilege('anon', oid, 'execute') from pg_proc where oid = to_regprocedure('$1');"
}

schema_checks() {
  echo ""
  echo "── 스키마 · 뷰 (SPEC §4, §7.2) ──"

  # ★ 뷰가 아예 없으면 "그 컬럼이 없다"도 참이 된다. 먼저 뷰의 존재부터 확인한다.
  #   안 그러면 스키마를 안 올린 DB에서 I1 검사가 통째로 가짜 통과한다.
  check "public_players 뷰가 있다" "1" \
    "$(q "select count(*) from information_schema.views where table_name='public_players';")"

  # ★ 컬럼 목록을 통째로 비교한다. "is_bot이 없다"만 보면 다음에 추가된 컬럼은 못 잡는다.
  #   created_at은 봇이 한꺼번에 만들어져서, token은 본인 확인용이라 빠져야 한다 (§7.2).
  # is_ready·lobby_line·lobby_line_at 은 대기방 값이라 뷰가 phase='lobby' 일 때만
  # 내려준다 (policies.sql). 대기방엔 사람만 있으므로 게임까지 따라가면
  # **값이 있는 자리 = 사람**이 되어 봇 명단이 통째로 드러난다.
  check "public_players 컬럼이 정확히 10개다" \
    "id,room_id,nickname,mask_id,seat,connected,is_ready,lobby_line,lobby_line_at,lobby_name" \
    "$(q "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='public_players';")"

  # 같은 이유로 채팅 뷰도 본다. created_at이 있으면 봇의 타이핑 지연이 드러난다 (I1).
  check "public_messages 컬럼이 정확히 5개다" "id,room_id,player_id,text,visible_at" \
    "$(q "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='public_messages';")"

  check "rooms에 capacity 컬럼이 있다 (§17.6)" "1" \
    "$(q "select count(*) from information_schema.columns where table_name='rooms' and column_name='capacity';")"

  # 방 제목. 없으면 방 만들기가 42703(그런 컬럼 없음)으로 죽는다.
  check "rooms에 name 컬럼이 있다" "1" \
    "$(q "select count(*) from information_schema.columns where table_name='rooms' and column_name='name';")"

  # ★ 컬럼만 보면 부족하다. 제약이 빠지거나 하한이 빠지면 ''(빈 문자열)이 들어가고,
  #   화면은 "이름이 있는데 안 보이는" 방을 그린다 — null 로 접혀야 코드로 대신 부른다.
  #
  # ★ 여기서 시험 삼아 insert 하지 않는다. 이 파일은 apply.sh 를 통해 **배포 DB에서도**
  #   돈다. 대신 제약의 정의를 읽는다 — Postgres 가 between 을 >= / <= 로 펼쳐 두므로
  #   양쪽 경계가 살아 있는지까지 확인된다. 이름만 세는 검사로는 못 잡는 자리다.
  check "rooms.name 에 1~20자 제약이 걸려 있다" "t" \
    "$(q "select (d like '%char_length%' and d like '%>= 1%' and d like '%<= 20%')
            from (select pg_get_constraintdef(oid) d from pg_constraint
                   where conname = 'rooms_name_check') t;")"

  # 대기방 프리셋 발화 (§15-3-결정). 넷이 다 있어야 쿨다운·총량이 성립한다.
  check "players에 대기방 컬럼 5개가 있다" "5" \
    "$(q "select count(*) from information_schema.columns where table_name='players'
           and column_name in ('is_ready','lobby_line','lobby_line_at','lobby_line_count','lobby_name');")"

  # ★ 지우기가 shuffle_seats 안에 들어 있는가. 빠지면 게임이 시작된 뒤에도
  #   사람 자리에만 발화가 남아 봇 명단이 드러난다 (I1). 함수의 존재만 보는
  #   시그니처 검사로는 절대 못 잡는 자리다.
  # ★ lobby_name 은 본인이 지은 이름이다 (§15-2-결정). 안 지우면 대기방의 '철수'가
  #   게임의 그 자리로 이어져 자리를 섞은 의미가 사라지고, 사람만 이름이 있으므로
  #   **이름이 있는 자리 = 사람**이 된다. lobby_line 과 함께 본다 — 하나만 보면
  #   나머지가 빠져도 초록불이다.
  check "shuffle_seats가 대기방 흔적을 지운다 (I1)" "t" \
    "$(q "select (d like '%lobby_line%' and d like '%lobby_name%')
            from (select pg_get_functiondef(to_regprocedure('shuffle_seats(uuid)')) d) t;")"

  # ★ 대기방 이름은 겹치면 안 된다 (§15-2-결정). 같은 방에 '철수'가 둘이면 누가
  #   누구인지 못 가리고, 나중에 붙일 친구 찾기가 아예 성립하지 않는다.
  #   lower() 표현식이라 유니크 "제약"이 아니라 인덱스로만 존재한다.
  check "profiles.display_name 이 대소문자 무시 유니크다" "1" \
    "$(q "select count(*) from pg_indexes where tablename='profiles' and indexname='profiles_display_name_key';")"

  # ★ 이름은 한 번 짓고 끝이다 (§15-2-결정). **정책으로는 못 막는다** — 쓰기는 전부
  #   service role 서버를 지나고(I9), service role 은 RLS 를 통과한다. 트리거만이
  #   모든 쓰기 경로에 걸린다. 여기가 0이면 라우트의 검사 하나에만 기대는 상태다.
  #
  #   ★ 'profiles'::regclass 로 묻지 않는다. 테이블이 없으면 캐스팅이 **에러**라
  #     pipefail 아래서 스크립트가 그 자리에서 죽는다 (anon_can 과 같은 이유).
  check "이름을 바꾸지 못하게 막는 트리거가 있다" "1" \
    "$(q "select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relname = 'profiles' and t.tgname = 'profiles_name_frozen';")"

  # ── 전적 (§15-2-결정 「아직 안 한 것」) ─────────────────────────────────────
  check "match_results 테이블이 있다" "1" \
    "$(q "select count(*) from information_schema.tables where table_name='match_results';")"

  # ★ 같은 판을 두 번 적지 않는 유일한 장치다. 방의 사람 전원이 결과 화면을 열면
  #   /api/reveal 이 그만큼 불리는데, 기본키가 없으면 판수가 사람 수만큼 뻥튀기된다.
  check "match_results 기본키가 (room_id, user_id) 다" "room_id,user_id" \
    "$(q "select string_agg(a.attname, ',' order by k.ord)
            from pg_constraint c
            join lateral unnest(c.conkey) with ordinality k(att, ord) on true
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att
           where c.conrelid = to_regclass('match_results') and c.contype = 'p';")"

  # ★ room_id 에 외래키가 있으면 안 된다. cleanup_stale_rooms 가 24시간 지난 방을
  #   지우는데(§16.4), cascade 가 달려 있으면 **전적이 하루 만에 같이 사라진다.**
  #   이건 스키마를 봐야만 잡히는 종류다 — 화면은 그날 하루 멀쩡하게 돈다.
  check "match_results.room_id 에 외래키가 없다 (§16.4)" "0" \
    "$(q "select count(*) from pg_constraint c
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
           where c.conrelid = to_regclass('match_results')
             and c.contype = 'f' and a.attname = 'room_id';")"

  # ★ 제약은 **정의를 읽어서** 확인한다. 넣어 보지 않는다 — 이 파일은 apply.sh 가
  #   배포 DB에도 그대로 돌린다. 제약이 빠져 있으면 그 insert 가 성공해서 진짜
  #   전적에 가짜 한 줄이 남는다. 넣어 보는 쪽은 test.sh(일회용 로컬 PG)가 한다.
  #
  #   사람 2명 미만인 방은 애초에 못 들어온다 (§15-2-결정 부정 유인). 기록하는 쪽
  #   (lib/server/match.ts)과 두 겹이고, 한 겹만 남으면 조용히 뚫린다.
  check "match_results 가 혼자 판을 막는다 (humans >= 2)" "t" \
    "$(q "select coalesce(bool_or(pg_get_constraintdef(oid) like '%humans%>=%2%'), false)
            from pg_constraint
           where conrelid = to_regclass('match_results') and contype = 'c';")"

  # ★ role 에 'ai' 가 오면 계정과 봇 자리가 이어졌다는 뜻이다 (I1). 봇에게는 계정이
  #   없으므로 애초에 여기 올 수 없고, 온다면 그건 이미 무언가 깨진 것이다.
  check "match_results 가 role='ai' 를 막는다 (I1)" "t" \
    "$(q "select coalesce(bool_or(
                    pg_get_constraintdef(oid) like '%role%'
                and pg_get_constraintdef(oid) like '%citizen%'
                and pg_get_constraintdef(oid) not like '%ai%'), false)
            from pg_constraint
           where conrelid = to_regclass('match_results') and contype = 'c';")"

  # ★ 한 방에 같은 이름이 둘이면 대기방에서 누가 누구인지 못 가린다.
  #   **부분 인덱스**여야 한다 — 이름 없는 사람은 여럿이어도 되고, shuffle_seats 가
  #   전원을 null 로 만들 때 서로 부딪히면 게임 시작이 통째로 죽는다.
  check "대기방 이름이 방 안에서 유니크다" "t" \
    "$(q "select (indexdef like '%lower(lobby_name)%' and indexdef like '%WHERE%')
            from pg_indexes where indexname='players_room_lobby_name_key';")"

  # ★ 함수만 있고 제약이 옛날이면 검사는 전부 초록인데 방 시작만 죽는다.
  #   shuffle_seats(§15-3-결정)는 전원의 자리를 한 순열로 다시 배정하므로 update 도중
  #   두 사람이 잠깐 같은 자리를 갖는 순간이 **반드시** 생긴다. 유니크가 즉시 검사면
  #   거기서 걸려 죽는다. 시그니처 검사는 함수의 존재만 보므로 이걸 못 잡는다 —
  #   이 파일 맨 위에 적힌 "한쪽만 아는 사실"이 생기는 바로 그 자리다.
  #
  #   이름으로 비교하는 이유: 지연 가능이어야 하는 것은 seat·nickname **둘뿐**이다.
  #   token 유니크까지 지연되면 중복 토큰이 트랜잭션 끝까지 살아남는다.
  check "seat·nickname 유니크가 지연 가능하다 (§15-3-결정)" \
    "players_room_nickname_key,players_room_seat_key" \
    "$(q "select coalesce(string_agg(conname, ',' order by conname), '') from pg_constraint where conrelid='players'::regclass and contype='u' and condeferrable;")"

  # initially immediate 라야 평소에는 진짜 중복이 그 자리에서 거절된다.
  # deferred 로 바꾸는 것은 shuffle_seats가 자기 트랜잭션 안에서만 한다.
  check "평소에는 즉시 검사다 (initially immediate)" "f" \
    "$(q "select coalesce(bool_or(condeferred), false) from pg_constraint where conrelid='players'::regclass and contype='u';")"

  # publication에 갓 추가한 직후에는 Realtime이 몇 분간 이벤트를 안 보낼 수 있다.
  # 구독은 SUBSCRIBED로 뜨는데 이벤트만 안 오므로 코드를 의심하게 된다. 실제로 그랬다.
  # 화면이 안 갱신되면 이 표시를 먼저 떠올릴 것 — 조금 기다렸다 다시 해본다.
  check "rooms가 Realtime publication에 있다 (§6)" "1" \
    "$(q "select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='rooms';")"

  echo ""
  echo "── 계정 (SPEC §15-2-결정) ──"

  # ★ 이 컬럼이 뷰에 새면 게임이 끝난다 — **봇에게는 계정이 없기 때문이다.**
  #     select seat from public_players where user_id is null;
  #   한 줄이면 봇 명단 전체다. 뷰 쪽은 위의 "컬럼이 정확히 9개다"가 이미 잡는다.
  #   여기서는 **테이블에 컬럼이 있는가**를 본다 — 없으면 입장이 42703으로 죽는다.
  check "players에 user_id 컬럼이 있다" "1" \
    "$(q "select count(*) from information_schema.columns where table_name='players' and column_name='user_id';")"

  # 계정을 지워도 진행 중인 방이 깨지면 안 된다. cascade면 탈퇴 한 번에 남의
  # 게임에서 자리가 사라지고, 그 자리만 비어서 그게 또 신호가 된다 (I1).
  check "players.user_id는 on delete set null이다" "n" \
    "$(q "select confdeltype from pg_constraint
           where conrelid='players'::regclass and contype='f'
             and conkey = array[(select attnum from pg_attribute
                                  where attrelid='players'::regclass and attname='user_id')];")"

  check "profiles 테이블이 있다" "1" \
    "$(q "select count(*) from information_schema.tables where table_name='profiles';")"

  check "profiles에 RLS가 켜져 있다" "t" \
    "$(q "select relrowsecurity from pg_class where oid='profiles'::regclass;")"

  # ★ 정책이 있는 것과 정책이 **행을 가르는** 것은 다르다. using(true)로 두면
  #   검사는 전부 초록인데 남의 프로필이 통째로 보인다. 조건식을 직접 읽는다.
  check "profiles 정책이 auth.uid()로 본인을 가른다" "t" \
    "$(q "select coalesce(bool_or(qual like '%uid()%'), false) from pg_policies where tablename='profiles';")"

  check "anon은 profiles를 못 읽는다" "f" \
    "$(q "select has_table_privilege('anon','profiles','select');")"
  check "authenticated는 profiles를 읽는다 (행은 정책이 가른다)" "t" \
    "$(q "select has_table_privilege('authenticated','profiles','select');")"

  # 프로필을 만드는 곳은 구글 연결 콜백 하나뿐이고 service role로 쓴다 (I9).
  # 열어두면 남이 display_name을 마음대로 바꿔 랭킹을 어지럽힌다.
  for r in anon authenticated; do
    check "$r 는 profiles에 쓰기 권한이 없다 (I9)" "f" \
      "$(q "select has_table_privilege('$r','profiles','insert') or has_table_privilege('$r','profiles','update') or has_table_privilege('$r','profiles','delete');")"
  done

  # ★ profiles가 Realtime publication에 들어가면 이 정책이 **배달 시점에** 평가되기
  #   시작하고, §7.3의 함정(이벤트가 조용히 안 배달됨)이 여기까지 따라온다.
  check "profiles는 Realtime publication에 없다 (§7.3)" "0" \
    "$(q "select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='profiles';")"

  # ── 전적 권한 (§15-2-결정, I1·I9) ──────────────────────────────────────────
  #
  # ★ 여기가 새면 I1 이 깨진다. 한 행에 room_id 와 role 이 같이 있어서, 남의 행을
  #   읽을 수 있으면 "그 방에서 누가 스파이였나"가 나온다. 게다가 **한 방의 행 수를
  #   세면 사람이 몇이었는지**가 나오고, 정원에서 빼면 봇 수가 나온다.
  check "match_results에 RLS가 켜져 있다" "t" \
    "$(q "select relrowsecurity from pg_class where oid='match_results'::regclass;")"

  check "match_results 정책이 auth.uid()로 본인을 가른다" "t" \
    "$(q "select coalesce(bool_or(qual like '%uid()%'), false) from pg_policies where tablename='match_results';")"

  check "anon은 match_results를 못 읽는다 (I1)" "f" \
    "$(q "select has_table_privilege('anon','match_results','select');")"
  check "authenticated는 match_results를 읽는다 (행은 정책이 가른다)" "t" \
    "$(q "select has_table_privilege('authenticated','match_results','select');")"

  # 적는 곳은 /api/reveal 하나뿐이고 service role 로 쓴다 (I9).
  # 열어두면 자기 전적을 직접 적어 랭킹을 만들 수 있다.
  for r in anon authenticated; do
    check "$r 는 match_results에 쓰기 권한이 없다 (I9)" "f" \
      "$(q "select has_table_privilege('$r','match_results','insert') or has_table_privilege('$r','match_results','update') or has_table_privilege('$r','match_results','delete');")"
  done

  # ★ 집계 함수도 막는다. security invoker 라 RLS 를 타긴 하지만, 실행 권한이 열려
  #   있으면 남의 user_id 를 넣어 "그 사람이 몇 판 했나"를 물을 창구가 하나 생긴다.
  check "anon은 match_stats 를 못 부른다" "f" "$(anon_can "match_stats(uuid)")"
  check "authenticated도 match_stats 를 못 부른다" "f" \
    "$(q "select has_function_privilege('authenticated', oid, 'execute') from pg_proc where oid = to_regprocedure('match_stats(uuid)');")"

  # ★ 거꾸로도 본다. revoke 를 public 까지 넓히다가 service_role 것까지 걷으면
  #   /api/profile/stats 가 통째로 500이 된다 — **로비를 열어봐야 알게 된다.**
  check "service_role은 match_stats 를 부른다" "t" \
    "$(q "select has_function_privilege('service_role', oid, 'execute') from pg_proc where oid = to_regprocedure('match_stats(uuid)');")"

  check "match_results는 Realtime publication에 없다 (§7.3)" "0" \
    "$(q "select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='match_results';")"

  echo ""
  echo "── 문구 풀 (seed.sql) ──"
  check "질문 풀이 차 있다" "t" "$(q "select count(*) > 0 from question_pool;")"
  check "봇 문구 풀이 차 있다" "t" "$(q "select count(*) > 0 from bot_line_pool;")"

  # ★ 봇 답변이 질문과 짝이 맞는가 (SPEC §17.2).
  #
  #   예전에는 phase만 보고 뽑아서 '배터리 몇 퍼센트야?'에 '어제랑 비슷했던 것 같아'가
  #   나왔다. 사람은 숫자를 대는데 봇만 딴소리를 하니 **첫 질문 한 번으로 봇이 전부
  #   갈렸다** (I1). 컬럼만 있고 내용이 안 채워지면 증상이 똑같이 돌아온다.
  check "bot_line_pool에 question_text 컬럼이 있다 (§17.2)" "1" \
    "$(q "select count(*) from information_schema.columns where table_name='bot_line_pool' and column_name='question_text';")"

  check "질문마다 전용 봇 문구가 하나 이상 있다" "0" \
    "$(q "select count(*) from question_pool qp
           where not exists (select 1 from bot_line_pool bl where bl.question_text = qp.text);")"

  # 봇 최대치 = 정원 상한 8 − 시작 최소 인원 2 = 6.
  # 문구(전용 + 일반)가 이보다 적으면 답이 빈 봇이 생기고, 빈칸은 사람만 만들 수 있으므로
  # 그 자리가 그대로 드러난다 (I1). on_enter_phase가 그때 예외를 던져 전환이 통째로 죽는다.
  check "질문마다 쓸 수 있는 문구가 6개 이상이다" "0" \
    "$(q "select count(*) from question_pool qp
           where (select count(*) from bot_line_pool bl
                   where bl.phase = case qp.kind when 'common' then 'question' else 'target' end
                     and (bl.question_text is null or bl.question_text = qp.text)) < 6;")"

  check "투표 이유가 6개 이상이다" "t" \
    "$(q "select count(*) >= 6 from bot_line_pool where phase='vote' and question_text is null;")"

  # 같은 문구를 여러 질문에 붙일 수 있어야 한다('음 글쎄'는 어디에나 어울린다).
  # 옛 unique (phase, text)가 남아 있으면 seed가 조용히 절반만 들어간다.
  check "옛 unique (phase, text)가 남아 있지 않다" "0" \
    "$(q "select count(*) from pg_constraint where conname = 'bot_line_pool_phase_text_key';")"

  echo ""
  echo "── 월드 AI 발화 기록 ──"
  check "world_agent_logs 테이블이 있다" "1" \
    "$(q "select count(*) from information_schema.tables where table_name='world_agent_logs';")"

  # ★ 이 검사가 이 테이블의 존재 이유다. player_id가 players를 참조하면 월드 AI는
  #   행이 없어서 **모든 insert가 외래키로 죽는다** — 그런데 기록 실패는 발화를
  #   막지 않게 해놨으므로(route.ts) 화면에는 아무 일도 안 일어난 것처럼 보이고
  #   로그만 조용히 비어 있다. 그 상태를 여기서 잡는다.
  check "world_agent_logs.player_id에 외래키가 없다" "0" \
    "$(q "select count(*) from information_schema.key_column_usage k
            join information_schema.table_constraints c using (constraint_name)
           where k.table_name='world_agent_logs' and k.column_name='player_id'
             and c.constraint_type='FOREIGN KEY';")"

  # 발화 텍스트가 없으면 사람다움을 판단할 수 없다. agent_logs를 못 쓴 이유 중 하나다.
  check "world_agent_logs에 text·raw·dropped 컬럼이 있다" "3" \
    "$(q "select count(*) from information_schema.columns
           where table_name='world_agent_logs' and column_name in ('text','raw','dropped');")"

  echo ""
  echo "── 함수 시그니처 (SPEC §17.6) ──"
  # ★ 이름이 아니라 **시그니처**로 본다. 이름만 세면 옛 create_room(text)가 남아 있어도
  #   통과한다. 정원이 방마다 달라지면서 create_room(text) → create_room(text,int)로
  #   바뀌었고, 옛 함수만 있는 DB에서는 방 만들기가 PGRST202로 죽는데 화면에는 그냥
  #   "방 생성 실패"만 뜬다.
  #
  # ★ 판정은 to_regprocedure로 한다. 없으면 에러가 아니라 null이라 그대로 비교된다.
  #   원래는 pg_get_function_identity_arguments(oid)='text, integer'로 셌는데,
  #   **그 함수는 인자 이름까지 돌려준다** — 실제 값은 'p_code text, p_capacity integer'라
  #   스키마가 멀쩡해도 영원히 ✗가 떴다. 이 방식은 인자 이름을 바꿔도 안 깨진다.
  for sig in \
    "advance_phase(uuid,int,uuid)" \
    "advance_expired_rooms(int)" \
    "create_room(text,int,text,uuid)" \
    "join_room(text,uuid)" \
    "leave_room(uuid,uuid)" \
    "fill_with_bots(uuid)" \
    "shuffle_seats(uuid)" \
    "send_message(uuid,uuid,text,int)" \
    "say_lobby_line(uuid,uuid,text,int,int)" \
    "set_lobby_ready(uuid,uuid,boolean)" \
    "set_lobby_name(uuid,uuid,text)" \
    "room_capacity(uuid)" \
    "default_room_capacity()" \
    "server_now()"; do
    check "${sig} 가 있다" "t" "$(q "select (to_regprocedure('$sig') is not null);")"
  done
  # ★ 시그니처가 바뀔 때마다 **옛 것이 지워졌는지**를 같이 본다. 남아 있으면 인자
  #   개수가 다른 오버로드가 공존하고, PostgREST가 어느 쪽을 부를지 정하지 못해
  #   PGRST203으로 죽는다. 화면에는 "방 생성 실패"만 뜬다.
  for old in "create_room(text)" "create_room(text,int)" "create_room(text,int,text)" "join_room(text)"; do
    check "옛 ${old} 이 남아 있지 않다" "f" \
      "$(q "select (to_regprocedure('$old') is not null);")"
  done

  echo ""
  echo "── anon 권한 (I1, I9) ──"
  check "anon은 players를 못 읽는다 (I1)" "f" \
    "$(q "select has_table_privilege('anon','players','select');")"
  check "anon은 public_players를 읽는다" "t" \
    "$(q "select has_table_privilege('anon','public_players','select');")"
  check "anon은 messages 테이블을 못 읽는다 (I1)" "f" \
    "$(q "select has_table_privilege('anon','messages','select');")"

  # 쓰기는 전부 service role 서버를 거친다 (I9). anon에 쓰기 권한이 남아 있으면 안 된다.
  for t in rooms questions answers messages votes players; do
    check "anon은 $t 에 쓰기 권한이 없다" "f" \
      "$(q "select has_table_privilege('anon','$t','insert') or has_table_privilege('anon','$t','update') or has_table_privilege('anon','$t','delete');")"
  done

  # 이 함수들은 전부 security definer다. anon이 부를 수 있으면 RLS가 통째로 무의미해진다.
  for fn in \
    "advance_phase(uuid,int,uuid)" \
    "advance_expired_rooms(int)" \
    "on_enter_phase(uuid,text,int,timestamptz)" \
    "pick_bot_line(text)" \
    "cleanup_stale_rooms(interval)" \
    "bot_reply(uuid,int)" \
    "send_message(uuid,uuid,text,int)" \
    "create_room(text,int,text,uuid)" \
    "join_room(text,uuid)" \
    "leave_room(uuid,uuid)" \
    "fill_with_bots(uuid)" \
    "shuffle_seats(uuid)" \
    "say_lobby_line(uuid,uuid,text,int,int)" \
    "set_lobby_ready(uuid,uuid,boolean)" \
    "set_lobby_name(uuid,uuid,text)" \
    "server_now()" \
    "default_room_capacity()" \
    "room_capacity(uuid)" \
    "pick_free_seat(uuid)"; do
    check "anon은 ${fn%%(*} 를 못 부른다" "f" "$(anon_can "$fn")"
  done
}
