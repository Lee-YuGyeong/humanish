'use client';

/**
 * 판 도중 나갔던 3D 월드 방이 있으면, 로비에서 **돌아갈지 물어본다**. 소유: 원상
 *
 * CEO 결정 2026-08-06: 뒤로가기·퇴장으로 월드 방을 나가도 중도포기·자동 패배는
 * 없다 (SPEC §18.6) — 자리는 그대로 남는다. 돌아갈 방 코드는
 * app/world/active-room.ts 가 localStorage 에 남겨 둔다.
 *
 * ┌─ 왜 자동으로 안 되돌리나 (2026-08-07) ────────────────────────────────────┐
 * │ 예전에는 로비에 들어오는 순간 그 방으로 router.replace 했다. 그러면 방을   │
 * │ 나온 사람이 **로비를 못 본다** — 나가자마자 같은 방으로 다시 튕겨 들어가고, │
 * │ 다른 방을 고르거나 기록을 보려면 또 나와야 했다. 되돌아갈지 말지는 사람이  │
 * │ 정할 일이라 물어보고, 고른 대로만 한다.                                    │
 * │                                                                            │
 * │ · 재입장 — /world?code=… 로 간다. 서버가 player_token 쿠키로 원래 자리를    │
 * │   돌려준다(/api/room/join 이 200). replace 라 히스토리에 /main 을 쌓지      │
 * │   않는다 (로비↔월드 뒤로가기 핑퐁 방지).                                    │
 * │ · 나가기 — 기록만 지우고 로비에 남는다. 자리는 서버에 그대로 있으므로       │
 * │   (SPEC §18.6) 방 목록이나 코드로 다시 들어오면 원래 자리로 돌아온다.       │
 * │                                                                            │
 * │ ★ 배경 클릭·ESC 로는 안 닫는다. 둘 중 하나를 고르는 물음이라, 흘려 닫으면   │
 * │   기록은 남아 다음 로비 방문마다 같은 물음이 다시 뜬다.                     │
 * │                                                                            │
 * │ 방이 이미 삭제됐으면? /world 의 enter 가 /api/room/join 에서 실패하고, 그   │
 * │ catch 가 기록을 지운다(page.tsx). 그래서 죽은 방을 골라도 한 번 튕겼다가    │
 * │ 다음 로비 방문부터는 안 물어본다 — 무한 루프가 없다.                        │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { getActiveRoom, clearActiveRoom } from '@/app/world/active-room';

import styles from './lobby.module.css';

export function WorldRejoin() {
  const router = useRouter();
  /** 물어볼 방 코드. null 이면 돌아갈 방이 없다 — 화면에 아무것도 안 그린다. */
  const [code, setCode] = useState<string | null>(null);

  // localStorage 는 서버에 없다. 마운트 뒤 한 번만 읽는다(SSR·hydration 불일치 방지).
  useEffect(() => {
    setCode(getActiveRoom());
  }, []);

  if (!code) return null;

  return (
    /*
      ★ styles.root 를 같이 건다. 팔레트 변수(--border2 · --muted …)가 거기 정의돼
        있고, 이 모달은 Lobby 바깥(page.tsx)에 붙으므로 안 걸면 변수가 안 풀린다.
        position · z-index · background 는 .overlay 가 파일에서 뒤에 있어 이긴다.
    */
    <div
      className={`${styles.root} ${styles.overlay}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="world-rejoin-title"
    >
      <div className={styles.modal}>
        <div className={`${styles.label} mb-2`}>진행 중인 방</div>
        <h3 id="world-rejoin-title" className="text-[1.1rem] font-bold tracking-tight">
          <span className={`${styles.mono} tracking-[0.22em]`}>{code}</span> 방으로 돌아갈까요?
        </h3>
        <p className="mt-2 text-[0.8rem] leading-relaxed" style={{ color: 'var(--dim)' }}>
          나간 사이에도 자리는 그대로 있습니다. 지금 돌아가면 원래 자리에서 이어서 하고,
          나가면 로비에 남습니다 — 나중에 방 목록에서 다시 들어와도 됩니다.
        </p>

        <div className="mt-6 flex gap-2">
          <button
            type="button"
            className={`${styles.btnAccent} flex-1`}
            autoFocus
            onClick={() => router.replace(`/world?code=${encodeURIComponent(code)}`)}
          >
            재입장하기
          </button>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => {
              // 기록만 지운다. 방은 서버에 그대로 둔다 (SPEC §18.6 — 이탈은 자리를 남긴다).
              clearActiveRoom();
              setCode(null);
            }}
          >
            나가기
          </button>
        </div>
      </div>
    </div>
  );
}
