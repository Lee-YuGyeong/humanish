/**
 * 로그인 화면. 소유: A (SPEC §15-2-결정)
 *
 * `/login` 이 그린다 (RequireLogin 이 보내는 곳). 페이지는 Suspense 만 씌운다 —
 * ?next= 를 읽으려면 그 경계가 있어야 한다 (Next 15).
 *
 * ┌─ 게임에 들어가려면 여기를 지난다 ──────────────────────────────────────────┐
 * │ 원래 §15-2-결정은 "첫 화면에 로그인 벽을 세우지 않는다" 였다. 익명으로     │
 * │ 놀게 하고 게임이 끝난 뒤에 계정을 권하는 흐름이었다. **뒤집었다** —        │
 * │ 들어오는 순간 로그인한다. 근거는 SPEC 의 그 절에 적어 두었다.              │
 * │                                                                            │
 * │ 그래서 익명 인증을 앱 진입에서 자동으로 걸지 않는다. 아무도 안 쓰는 계정이 │
 * │ 방문할 때마다 하나씩 쌓이기만 한다.                                        │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ 이미 로그인한 사람은 그냥 통과시킨다. 뒤로 가기로 여기 돌아왔을 때
 *   다시 로그인 버튼을 보여줄 이유가 없다.
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { signInWithGoogle } from '@/lib/auth';
import { useAuthUser } from '@/lib/queries/auth';
import styles from './login-screen.module.css';

/**
 * 콜백 라우트와 같은 규칙. 열린 리다이렉트를 막는다 (app/api/auth/callback).
 *
 * ★ raw 에는 쿼리가 붙어 올 수 있다 — `/world?code=ABCD` 처럼 (RequireLogin 이
 *   주소를 통째로 담아 보낸다). URLSearchParams 가 이미 풀어서 주므로 여기서
 *   다시 decode 하지 않는다.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/main';
  // 로그인 화면으로 되돌리지 않는다 — 여기서 여기로 보내면 고리가 된다.
  if (raw === '/login' || raw.startsWith('/login?')) return '/main';
  return raw;
}

export function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));

  const { data: user, isLoading } = useAuthUser();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // 이미 로그인해 있으면 통과시킨다.
  useEffect(() => {
    if (!isLoading && user && !user.isAnonymous) router.replace(next);
  }, [isLoading, user, router, next]);

  // 구글 화면에서 취소하고 돌아오면 ?auth=cancelled 가 붙어 있다.
  // 실패가 아니므로 붉은 글씨로 말하지 않는다.
  const cancelled = params.get('auth') === 'cancelled';

  const login = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await signInWithGoogle(next);
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

      {/* 로비와 같은 높이·같은 테두리의 머리말. 두 화면이 이어져 보여야 한다 */}
      <header
        className="flex h-12 shrink-0 items-center justify-between border-b px-4 sm:px-8"
        style={{ borderColor: 'var(--border)' }}
      >
        {/* 제목은 아래 h1 하나다. 여기에는 상태등만 둔다 */}
        <span />
        <span className="flex items-center gap-2">
          <span className={styles.dot} />
          <span
            className="text-[0.55rem] uppercase tracking-[0.2em]"
            style={{ color: 'var(--accent)' }}
          >
            online
          </span>
        </span>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-[26rem]">
          <p className={styles.label}>access</p>
          {/*
            ★ 제목은 여기 하나뿐이다. 머리말에서 같은 글자를 뺐다 — 한 화면에 같은
              말이 두 번 나오면 어느 쪽이 진짜 제목인지 흐려진다 (room-lobby.tsx 의
              방 이름과 같은 규칙).
          */}
          <h1 className="mt-3 text-[2.4rem] font-bold uppercase leading-[1.1] tracking-[0.02em]">
            Who is AI?
          </h1>
          <div className={`${styles.panel} mt-7 flex flex-col gap-4 p-6`}>
            <button
              type="button"
              className={styles.btn}
              disabled={busy || isLoading}
              onClick={() => void login()}
            >
              <GoogleIcon />
              {busy ? '여는 중…' : '구글로 계속하기'}
            </button>

            {cancelled && (
              <p className="text-[0.72rem] leading-relaxed" style={{ color: 'var(--dim)' }}>
                로그인을 취소했다. 다시 눌러도 된다.
              </p>
            )}
            {failed && <p className={styles.alert}>{failed}</p>}
          </div>
        </div>
      </main>
    </div>
  );
}

/** 구글 로고. CDN 을 쓰지 않는다 — 배포본은 외부 요청 없이 떠야 한다. */
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5A22 22 0 0 0 2 24c0 3.6.9 6.9 2.5 9.9l7.3-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.4 2 8.1 6.9 4.5 14.1l7.3 5.7c1.7-5.2 6.5-9 12.2-9z"
      />
    </svg>
  );
}
