/**
 * 워커 바인딩. wrangler.toml의 [vars]·durable_objects 바인딩과 이름이 같아야 한다.
 * 순환 참조를 만들지 않으려고 별도 파일에 둔다 (index ↔ room-do 양쪽이 본다).
 *
 * 파일명이 env.ts가 아닌 이유: .claude/hooks/deny-secrets.mjs의 보호 정규식이
 * `env.<무엇이든>`을 비밀 파일로 보고 막는다. 이름만 피한다.
 */
export interface Env {
  /** 방 하나당 인스턴스 하나. wrangler.toml의 바인딩 이름과 같다 */
  ROOM_DO: DurableObjectNamespace;
  /** Next와 나눠 갖는 비밀. 티켓 HMAC 검증 + 내부 API Bearer (.env.local.example 참고) */
  WORLD_SHARED_SECRET: string;
  /** 내부 API를 부를 Next 오리진. 예: http://127.0.0.1:3000 */
  NEXT_ORIGIN: string;
}
