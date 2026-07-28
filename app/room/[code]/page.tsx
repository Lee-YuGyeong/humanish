/**
 * 게임 화면. 소유: C (SPEC §2)
 *
 * 껍데기만 서버 컴포넌트다 — 실시간 구독과 타이머가 필요해서 본체는 클라이언트다.
 * 페이즈 분기·구독·카운트다운은 components/room-view.tsx에 있다.
 */
import { RoomView } from '@/components/room-view';

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <RoomView code={code} />;
}
