/**
 * 방으로 넘어가는 동안 덮는 화면. 소유: C
 *
 * ★ 이 파일이 없으면 Next 는 새 라우트가 준비될 때까지 **직전 페이지를 그대로
 *   띄워둔다.** 방에서 방으로 옮길 때 다 끝난 판의 결과표가 몇 백 ms 동안 남아
 *   있었고, 그게 "들어가면 옛 화면이 번쩍인다"의 정체다.
 *   loading.tsx 가 있으면 그 자리를 이 판이 즉시 가져간다.
 *
 * 색은 components/room-lobby.module.css 의 --bg2 · --muted 와 같은 값이다.
 * 모듈을 import 하려면 클라이언트 컴포넌트가 되어야 해서, 여기서는 값만 맞춘다
 * (이 화면은 글자 한 줄이라 굳이 번들을 늘릴 이유가 없다).
 */
export default function RoomLoading() {
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1,
        display: "grid",
        placeItems: "center",
        background: "#050505",
        color: "#666",
      }}
    >
      <p
        style={{
          fontSize: "0.52rem",
          letterSpacing: "0.3em",
          textTransform: "uppercase",
        }}
      >
        방을 여는 중…
      </p>
    </main>
  );
}
