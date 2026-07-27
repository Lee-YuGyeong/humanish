/**
 * 랜딩 — 방 만들기 / 입장. 소유: C (SPEC §2, §13-1)
 *
 * 쓰기는 전부 /api를 거친다. 클라이언트 anon 키는 읽기 전용이다 (I9).
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(path: string, body?: unknown) {
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '알 수 없는 오류');
      router.push(`/room/${data.room.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 p-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">사람인 척</h1>
        <p className="text-sm text-gray-500">
          5명 중 누가 AI인지 찾아낸다. 그중 한 명은 AI인 척하는 사람이다.
        </p>
      </header>

      <button
        type="button"
        disabled={busy !== null}
        onClick={() => {
          setBusy('create');
          void go('/api/room');
        }}
        className="rounded-lg bg-black px-4 py-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
      >
        {busy === 'create' ? '만드는 중…' : '방 만들기'}
      </button>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy('join');
          void go('/api/room/join', { code });
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
          placeholder="방 코드"
          maxLength={4}
          className="min-w-0 flex-1 rounded-lg border px-3 py-3 text-center font-mono text-lg tracking-[0.3em] uppercase"
        />
        <button
          type="submit"
          disabled={code.length !== 4 || busy !== null}
          className="rounded-lg border px-4 py-3 text-sm font-medium disabled:opacity-40"
        >
          {busy === 'join' ? '…' : '입장'}
        </button>
      </form>

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30">
          {error}
        </p>
      )}
    </main>
  );
}
