'use client';

/**
 * 「게임 접속하기」 — 로그인이 걸린 진입 버튼. 소유: A (SPEC §15-2-결정)
 *
 * ┌─ 여기가 게임의 문이다 ─────────────────────────────────────────────────────┐
 * │ 누르면 로그인부터 한다. 이미 로그인해 있으면 곧장 로비로 넘어간다 —        │
 * │ 매번 로그인 화면을 한 번 거치게 하면 두 번째부터는 군더더기다.             │
 * │                                                                            │
 * │ `/` (작업 보드)와 `/intro` 는 로그인을 요구하지 않는다. 벽은 이 버튼 뒤에  │
 * │ 있고, /main · /room 은 RequireLogin 이 다시 지킨다 (직접 주소를 친 경우).  │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 이 컴포넌트는 app/intro/ 가 아니라 components/ 에 둔다. 그 폴더는 원상 소유라
 *   (CLAUDE.md) 남의 폴더에 파일을 늘리지 않는다 — 저쪽은 import 한 줄만 바뀐다.
 *
 * ★ 서버 컴포넌트인 /intro 안에서 쓸 수 있게 'use client' 는 여기에만 붙인다.
 *   page.tsx 를 통째로 클라이언트로 만들면 그 화면의 폰트·정적 렌더 이점을 잃는다.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { signInWithGoogle } from '@/lib/auth';
import { useAuthUser } from '@/lib/queries/auth';

export function PlayButton({
  className,
  style,
  /** 글자 뒤의 작은 점. 히어로 버튼에만 있다 — 아래쪽 큰 CTA 는 없이 쓴다 */
  dot = true,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  dot?: boolean;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const { data: user, isLoading } = useAuthUser();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const go = async () => {
    // 익명 계정은 로그인한 것으로 치지 않는다 (components/require-login.tsx 와 같은 규칙).
    if (user && !user.isAnonymous) {
      router.push('/main');
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      await signInWithGoogle('/main');
    } catch (e) {
      setBusy(false);
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <button
        type="button"
        className={className}
        style={style}
        disabled={busy || isLoading}
        onClick={() => void go()}
      >
        {busy ? '여는 중…' : children}
        {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#080808]" />}
      </button>
      {/*
        실패는 말해줘야 한다. 안 그러면 눌렀는데 아무 일도 안 일어난 것처럼 보인다 —
        대개 Supabase 대시보드에서 구글 제공자가 꺼져 있을 때다.
      */}
      {failed && (
        <p className="w-full text-center text-[0.72rem] leading-relaxed text-[#ef4444]">{failed}</p>
      )}
    </>
  );
}
