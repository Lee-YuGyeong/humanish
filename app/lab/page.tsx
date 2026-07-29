'use client';

/**
 * 에이전트 실험실. 소유: B (SPEC §2)
 *
 * 같은 상황을 페르소나 전원에게 주고 답을 나란히 본다 — "사람처럼 보이는가"의
 * 눈검증 단계다. 모델 교체(NVIDIA_NIM_MODEL) 실험도 여기서 한다.
 *
 * LLM 호출은 /api/agent 경유만 (SPEC I4). 페르소나 프롬프트는 여기로 가져오지
 * 않는다 — 컨텍스트 조립은 서버(route의 lab 모드)가 한다.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AgentOutput } from '@/lib/agent/generate';

interface AgentConfig {
  provider: string;
  configured: boolean;
  model: string | null;
}

interface LabResult {
  player_id: string;
  persona?: { id: string; traits: string[] };
  output: AgentOutput;
  took_ms?: number;
  fallback: boolean;
}

const PHASES = ['question', 'target', 'chat', 'vote'] as const;

/** "닉네임: 내용" 한 줄 = 발화 하나. 콜론이 없으면 익명 발화로 취급한다. */
function parseHistory(text: string): { speaker: string; text: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx > 0 && idx < 20) {
        return { speaker: line.slice(0, idx).trim(), text: line.slice(idx + 1).trim() };
      }
      return { speaker: '익명?', text: line };
    });
}

export default function LabPage() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [question, setQuestion] = useState('요즘 제일 자주 시켜 먹는 야식이 뭐야?');
  const [phase, setPhase] = useState<(typeof PHASES)[number]>('question');
  const [historyText, setHistoryText] = useState('익명2: 나는 무조건 엽떡\n익명4: 헐 나도 ㅋㅋ 로제로');
  const [model, setModel] = useState('');
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const [results, setResults] = useState<LabResult[] | null>(null);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/agent')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  async function run() {
    setLoading(true);
    setError(null);
    setResults(null);
    const t0 = Date.now();
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lab: true,
          question: question.trim() || undefined,
          phase,
          history: parseHistory(historyText),
          model: model.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResults(data.results as LabResult[]);
      setUsedModel(data.model ?? null);
      setTookMs(Date.now() - t0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-4xl px-6 py-20">
        <Link href="/" className="stencil text-[10px] text-grime transition-colors hover:text-tung">
          ← manifest
        </Link>

        <h1 className="engraved mt-6 text-3xl font-black">에이전트 실험실</h1>
        <p className="mt-2 text-sm text-grime">
          같은 상황을 페르소나 전원에게 주고, 누가 제일 사람 같은지 눈으로 비교한다.
        </p>

        {/* NIM 설정 상태 — 키가 없어도 폴백 경로(§12.3)는 돌아간다 */}
        <div className="cut mt-6 px-5 py-3 text-xs">
          {config === null ? (
            <span className="text-ash">/api/agent 상태 확인 중…</span>
          ) : config.configured ? (
            <span className="text-grime">
              <span className="stencil mr-2 text-[10px] text-tung">nim ok</span>
              모델: {config.model}
            </span>
          ) : (
            <span className="text-grime">
              <span className="stencil mr-2 text-[10px] text-ash">키 미설정</span>
              NVIDIA_NIM_API_KEY가 없어 전원 폴백(&quot;ㅇㅇ&quot;, &quot;나도 몰루&quot;)으로 답한다.
              .env.local에 키를 넣으면 진짜 응답이 나온다.
            </span>
          )}
        </div>

        {/* 입력 */}
        <div className="mt-8 space-y-4">
          <label className="block">
            <span className="stencil text-[10px] text-ash">질문</span>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="cut mt-1 w-full bg-transparent px-4 py-2 text-sm outline-none"
              placeholder="봇들에게 던질 질문"
            />
          </label>

          <label className="block">
            <span className="stencil text-[10px] text-ash">페이즈</span>
            <select
              value={phase}
              onChange={(e) => setPhase(e.target.value as (typeof PHASES)[number])}
              className="cut mt-1 block bg-transparent px-4 py-2 text-sm outline-none"
            >
              {PHASES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="stencil text-[10px] text-ash">
              모델 (비우면 .env.local의 NVIDIA_NIM_MODEL) — 예: meta/llama-3.1-70b-instruct
            </span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="cut mt-1 w-full bg-transparent px-4 py-2 text-sm outline-none"
              placeholder={config?.model ?? ''}
            />
          </label>

          <label className="block">
            <span className="stencil text-[10px] text-ash">
              앞선 대화 (한 줄에 하나, &quot;닉네임: 내용&quot;) — 봇이 이 말투를 관측해서 따라간다
            </span>
            <textarea
              value={historyText}
              onChange={(e) => setHistoryText(e.target.value)}
              rows={4}
              className="cut mt-1 w-full bg-transparent px-4 py-2 text-sm outline-none"
            />
          </label>

          <button
            onClick={run}
            disabled={loading}
            className="cut stencil px-6 py-3 text-xs text-tung transition-opacity disabled:opacity-40"
          >
            {loading ? '생성 중… (봇 전원 병렬 호출)' : '실행 →'}
          </button>
        </div>

        {error && (
          <p className="cut mt-6 px-5 py-3 text-sm text-tung">에러: {error}</p>
        )}

        {/* 결과 — 페르소나별 카드 */}
        {results && (
          <div className="mt-10">
            <p className="stencil text-[10px] text-ash">
              결과 · {usedModel ?? ''} · {tookMs !== null ? `${tookMs}ms` : ''} · 병렬 {results.length}명
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {results.map((r) => (
                <div key={r.player_id} className="cut px-5 py-4">
                  <div className="flex items-baseline justify-between">
                    <span className="stencil text-[10px] text-tung">
                      {r.persona?.id ?? r.player_id}
                    </span>
                    <span className="stencil text-[10px] text-ash">
                      {r.fallback ? 'fallback · ' : ''}
                      {r.took_ms !== undefined ? `${(r.took_ms / 1000).toFixed(1)}s` : ''}
                    </span>
                  </div>
                  {r.persona && (
                    <p className="mt-1 text-[11px] text-ash">{r.persona.traits.join(' · ')}</p>
                  )}

                  <div className="mt-3 space-y-2">
                    {r.output.messages.map((m, i) => (
                      <p key={i} className="text-sm leading-relaxed">
                        {m}
                        <span className="ml-2 text-[10px] text-ash">
                          +{((r.output.delaysMs[i] ?? 0) / 1000).toFixed(1)}s
                        </span>
                      </p>
                    ))}
                  </div>

                  <p className="mt-3 text-[11px] leading-relaxed text-grime">
                    {r.output.action} · 의심 {r.output.suspicionOnMe.toFixed(2)} —{' '}
                    {r.output.reasoning}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
