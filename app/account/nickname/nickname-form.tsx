/**
 * 이름 짓기 — 구글을 처음 연결한 뒤 한 번. 소유: A (SPEC §15-2-결정)
 *
 * /account/nickname?next=/room/ABCD
 *
 * ┌─ 이 이름이 어디까지 가는가 ────────────────────────────────────────────────┐
 * │ 대기방 · (나중에) 랭킹 · 친구. **게임이 시작되면 사라진다.**                │
 * │ 그래서 화면에도 한 줄 적는다 — 본명을 넣었다가 게임 중에 뜨는 줄 알고      │
 * │ 놀라는 일이 없어야 한다. 실제 보장은 두 겹이다:                            │
 * │   1. shuffle_seats 가 players.lobby_name 을 지운다                         │
 * │   2. public_players 뷰가 phase='lobby' 일 때만 내려준다                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ **한 번 짓고 끝이다** (SPEC §15-2-결정). 이미 이름이 있으면 이 화면은 아예
 *   그리지 않고 돌려보낸다 — 익명 계정을 돌려보내는 것과 같은 자리다. 못 바꾸는데
 *   입력칸을 보여주면, 고쳐 놓고 눌렀을 때 409 를 보게 된다.
 *   진짜 자물쇠는 여기가 아니라 서버와 트리거다 (app/api/profile, schema.sql).
 *
 * ★ 화면은 로그인(components/login-screen.tsx)과 같은 뼈대다 — 같은 머리말 높이,
 *   같은 판, 같은 초록. 로그인 → 이름 → 로비가 한 흐름이라 중간에서 화면 언어가
 *   바뀌면 안 된다. 설명은 최소로 둔다: 여기서 물어보는 건 이름 하나뿐이다.
 *   **다만 "못 바꾼다"는 뺄 수 없다** — 되돌릴 수 없는 문 앞에서는 그게 필요한 말이다.
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { saveDisplayName } from '@/lib/api/profile';
import { useInvalidateAuthUser, useAuthUser, useProfile } from '@/lib/queries/auth';
import styles from './nickname.module.css';

/** app/api/profile 의 MIN_NAME_LEN · MAX_NAME_LEN · profiles 체크 제약과 같은 값이어야 한다. */
const MIN_LEN = 1;
const MAX_LEN = 20;

function safeNext(raw: string | null): string {
  // 콜백 라우트와 같은 규칙이다. 열린 리다이렉트를 막는다 (app/api/auth/callback).
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export function NicknameForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));

  const { data: user, isLoading: userLoading } = useAuthUser();
  const { data: profileData, isLoading: profileLoading } = useProfile();
  const invalidate = useInvalidateAuthUser();

  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /*
   * 방금 저장했다. 아래 「이미 이름이 있다」 효과가 이걸 보고 비켜선다.
   *
   * ★ 없으면 이렇게 된다: 저장 → invalidate → 프로필이 생긴 걸 보고 그 효과가
   *   먼저 replace(next) 를 부른다 → ?auth=linked 가 사라진다. 도착 화면이
   *   "이었다"는 표시를 못 받는다. state 가 아니라 ref 인 이유는 이 값이 화면을
   *   다시 그릴 이유가 없어서다.
   */
  const saved = useRef(false);

  // 구글이 준 이름을 미리 채운다. **제안일 뿐이라 지우고 새로 쓸 수 있다.**
  // 사용자가 한 글자라도 건드린 뒤에는 덮어쓰지 않는다.
  // 이미 이름이 있는 경우는 여기 없다 — 아래에서 화면째 돌려보낸다.
  useEffect(() => {
    if (touched || !profileData) return;
    setName(profileData.suggested ?? '');
  }, [profileData, touched]);

  const loading = userLoading || profileLoading;
  const trimmed = name.trim();

  /*
   * 돌려보내는 자리 둘. 어느 쪽이든 이 화면에 볼일이 없는 사람이다.
   *
   *   · 익명 계정 — 이름을 달지 않는다 (라우트가 409로 막는다).
   *   · 이미 이름이 있다 — **한 번 짓고 끝이다** (SPEC §15-2-결정).
   *     로비에서 이름을 눌러 들어오는 옛 링크가 여기로 온다.
   *
   * 둘 다 대개 주소를 직접 쳤거나 오래된 링크를 밟은 경우다. 설명하지 않고 조용히
   * 돌려보낸다 — 여기서 할 수 있는 일이 없는 화면을 보여줄 이유가 없다.
   */
  useEffect(() => {
    if (loading || saved.current) return;
    if (user?.isAnonymous || profileData?.profile) router.replace(next);
  }, [loading, user, profileData, router, next]);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await saveDisplayName(trimmed);
      saved.current = true;
      invalidate();
      router.replace(`${next}${next.includes('?') ? '&' : '?'}auth=linked`);
    } catch (e) {
      setBusy(false);
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={`${styles.root} flex min-h-dvh flex-col`}>
      <div aria-hidden className={styles.backdrop} />
      <div aria-hidden className={styles.noise} />
      <div aria-hidden className={styles.scanlines} />

      {/* 로그인·로비와 같은 높이·같은 테두리. 세 화면이 이어져 보여야 한다 */}
      <header
        className="flex h-12 shrink-0 items-center justify-between border-b px-4 sm:px-8"
        style={{ borderColor: 'var(--border)' }}
      >
        {/* 제목은 아래 h1 하나다. 여기에는 상태등만 둔다 */}
        <span />
        <span className="flex items-center gap-2">
          <span className={styles.dot} />
          <span className="text-[0.55rem] uppercase tracking-[0.2em]" style={{ color: 'var(--accent)' }}>
            online
          </span>
        </span>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-[26rem]">
          {/* 눈썹줄은 account 다. 제목이 '닉네임'이라 여기도 name 이면 같은 말이 두 번이다 */}
          <p className={styles.label}>account</p>
          <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.1] tracking-[0.02em]">닉네임</h1>

          <div className={`${styles.panel} mt-7 flex flex-col gap-3 p-6`}>
            <input
              id="nickname"
              className={styles.field}
              value={name}
              maxLength={MAX_LEN}
              disabled={loading || busy}
              placeholder={loading ? '불러오는 중…' : `${MIN_LEN}~${MAX_LEN}자`}
              aria-label="닉네임"
              autoFocus
              onChange={(e) => {
                setTouched(true);
                setName(e.target.value);
                setFailed(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && trimmed && !busy) void submit();
              }}
            />
            <p className={`${styles.count} text-right`}>
              {trimmed.length}/{MAX_LEN}
            </p>

            {failed && (
              <p role="alert" className={styles.alert}>
                {failed}
              </p>
            )}

            <button
              type="button"
              className={`${styles.btn} mt-1`}
              disabled={!trimmed || busy || loading}
              onClick={() => void submit()}
            >
              {busy ? '저장 중…' : '이 이름으로 정하기'} <ArrowIcon />
            </button>
          </div>

          {/*
            남긴 두 문장. 둘 다 **되돌릴 수 없는 사실**이라 누르기 전에 말해야 한다.
            나머지 설명(중복 불가 등)은 뺐다 — 중복은 눌렀을 때 .alert 로 말한다.
            앞 문장만 밝게 둔다. 뒤 문장은 안심시키는 말이라 같은 무게로 읽히면 안 된다.
          */}
          <p className="mt-4 text-[0.72rem] leading-relaxed" style={{ color: 'var(--dim)' }}>
            <span className="font-semibold" style={{ color: 'var(--text)' }}>
              한 번 정하면 바꿀 수 없다.
            </span>{' '}
            게임이 시작되면 익명으로 바뀐다.
          </p>
        </div>
      </main>
    </div>
  );
}

/** 로비의 입장 버튼과 같은 화살표. CDN 을 쓰지 않는다 — 배포본은 외부 요청 없이 떠야 한다. */
function ArrowIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden>
      <path
        d="M0 4.5h9.5M6.5 1l3.2 3.5L6.5 8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
