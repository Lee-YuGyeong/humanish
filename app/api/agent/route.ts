/**
 * LLM 프록시. 껍데기는 A, 내용은 B (SPEC §2).
 *
 * 클라이언트에서 LLM API를 직접 부르면 키가 노출된다. 모든 봇 호출은 여기를 지난다 (SPEC I4).
 *
 * 공급자 미확정 (SPEC §15-1). 잠정으로 NVIDIA NIM 키를 본다.
 * 런타임도 함께 확정한다 — 공급자 SDK가 Edge를 지원하지 않으면 'nodejs'로 바꾼다.
 */

export const runtime = 'edge';

export async function POST(): Promise<Response> {
  if (!process.env.NVIDIA_NIM_API_KEY) {
    return Response.json(
      { error: 'NVIDIA_NIM_API_KEY 미설정' },
      { status: 500 },
    );
  }

  // TODO(B): lib/agent/generate.ts 연결.
  //   - AbortController로 8초 타임아웃 (SPEC §12.3)
  //   - 봇 여러 명은 Promise.allSettled로 병렬 호출
  //   - 실패분은 FALLBACK_POOL로 대체하고 agent_logs에 기록
  return Response.json({ error: 'not implemented' }, { status: 501 });
}
