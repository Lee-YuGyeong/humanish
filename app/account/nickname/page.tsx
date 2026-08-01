/**
 * 이름 짓기 — 구글을 처음 연결한 뒤 한 번. 소유: A (SPEC §15-2-결정)
 *
 * /account/nickname?next=/room/ABCD
 *
 * ┌─ 이 이름이 어디까지 가는가 ────────────────────────────────────────────────┐
 * │ 대기방 · (나중에) 랭킹 · 친구. **게임이 시작되면 사라진다.**                │
 * │ 그래서 화면에도 그렇게 적는다 — 본명을 넣었다가 게임 중에 뜨는 줄 알고     │
 * │ 놀라는 일이 없어야 한다. 실제 보장은 두 겹이다:                            │
 * │   1. shuffle_seats 가 players.lobby_name 을 지운다                         │
 * │   2. public_players 뷰가 phase='lobby' 일 때만 내려준다                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 작업 보드(app/workspaces.ts)에 넣지 않는다. 거기는 개발용 진입 목록이고
 *   이 화면은 사용자 흐름의 일부다.
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { saveDisplayName } from '@/lib/api/profile';
import { useInvalidateAuthUser, useAuthUser, useProfile } from '@/lib/queries/auth';

/** app/api/profile 의 MIN_NAME_LEN · MAX_NAME_LEN · profiles 체크 제약과 같은 값이어야 한다. */
const MIN_LEN = 1;
const MAX_LEN = 20;

function safeNext(raw: string | null): string {
  // 콜백 라우트와 같은 규칙이다. 열린 리다이렉트를 막는다 (app/api/auth/callback).
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function NicknameForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));

  const { data: user, isLoading: userLoading } = useAuthUser();
  const { data: profileData, isLoading: profileLoading } = useProfile();
  const invalidate = useInvalidateAuthUser();

  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // 구글이 준 이름을 미리 채운다. **제안일 뿐이라 지우고 새로 쓸 수 있다.**
  // 사용자가 한 글자라도 건드린 뒤에는 덮어쓰지 않는다.
  useEffect(() => {
    if (touched || !profileData) return;
    setName(profileData.profile?.display_name ?? profileData.suggested ?? '');
  }, [profileData, touched]);

  const loading = userLoading || profileLoading;
  const trimmed = name.trim();

  // 익명 계정에는 이름을 달지 않는다 (라우트가 409로 막는다). 여기까지 왔다는 것은
  // 대개 주소를 직접 친 경우다 — 조용히 돌려보낸다.
  useEffect(() => {
    if (!loading && user && user.isAnonymous) router.replace(next);
  }, [loading, user, router, next]);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await saveDisplayName(trimmed);
      invalidate();
      router.replace(`${next}${next.includes('?') ? '&' : '?'}auth=linked`);
    } catch (e) {
      setBusy(false);
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <header className="flex flex-col gap-2">
        <p className="stencil text-[9px] text-grime">계정</p>
        <h1 className="engraved text-3xl font-black text-bone">이름을 정한다</h1>
        <p className="text-[13px] leading-relaxed text-grime">
          대기방에서 이 이름으로 부른다.
          <br />
          <span className="text-tung">게임이 시작되면 모두 익명으로 바뀐다.</span>
        </p>
      </header>

      <div className="case flex flex-col gap-3 px-6 py-5">
        <label className="stencil text-[9px] text-grime" htmlFor="nickname">
          이름
        </label>
        <input
          id="nickname"
          className="cut w-full px-4 py-3 text-[14px] text-bone placeholder:text-ash focus:border-tung/40 focus:outline-none"
          value={name}
          maxLength={MAX_LEN}
          disabled={loading || busy}
          placeholder={loading ? '불러오는 중…' : `${MIN_LEN}~${MAX_LEN}자`}
          onChange={(e) => {
            setTouched(true);
            setName(e.target.value);
            setFailed(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed && !busy) void submit();
          }}
        />
        <p className="readout text-right text-[10px] text-ash">
          {trimmed.length}/{MAX_LEN}
        </p>

        {failed && <p className="text-[12px] leading-relaxed text-signal">{failed}</p>}

        <button
          type="button"
          className="case case-live stencil px-6 py-3 text-[10px] text-flare disabled:cursor-not-allowed disabled:text-ash disabled:opacity-40"
          disabled={!trimmed || busy || loading}
          onClick={() => void submit()}
        >
          {busy ? '저장하는 중…' : '이 이름으로 하기'}
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-ash">
        나중에 바꿀 수 있다. 다른 사람이 쓰는 이름은 고를 수 없다.
      </p>
    </main>
  );
}

export default function NicknamePage() {
  // useSearchParams 는 Suspense 경계를 요구한다 (Next 15).
  return (
    <Suspense fallback={null}>
      <NicknameForm />
    </Suspense>
  );
}
