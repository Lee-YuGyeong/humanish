'use client';

/**
 * 라운드테이블 무대 — 판의 3D 연출. 소유: 원상 (/world)
 *
 * 네 조각뿐이다:
 *   RoundTable      좌석 스폰 원(spawnFor) 한가운데의 원형 테이블 (배치·시각)
 *   TopicProjection **인트로 영상이 나오던 대형 영사막**에 주제·단계 문구를 겹친다
 *   PlayerSpotlight defense 에서 지목된 한 사람만 위에서 비추는 스포트라이트
 *   StageMood       단계마다 공간 전체의 색을 바꾸는 무대등 (조명 한 개)
 *
 * ┌─ 상태와 분리돼 있다 ───────────────────────────────────────────────────────┐
 * │ "무슨 단계인지 · 누구를 비출지"는 roundtable-store 가 쥐고, 여기는 그걸 읽어  │
 * │ 그릴 뿐이다. 워커가 아직 아무 것도 안 보냈으면(phase='idle') 씬은 그대로 돈다 │
 * │ — 조명은 꺼진 채, 스크린은 대기 문구로.                                      │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ★ I1 — 이 파일에는 "누가 봇인가"를 아는 코드가 없다. 스포트라이트도 스크린도
 *   store 가 준 players.id 하나만 보고 그 자리를 가리킨다. 사람이든 봇이든 **같은
 *   경로로** 조명되고, 같은 문구가 뜨고, 같은 시간을 채운다. 정체가 화면에 나타나는
 *   유일한 지점은 판이 끝난 뒤의 reveal 이다.
 *
 * ★ 스크린 텍스처는 **단계가 바뀔 때만** 다시 굽는다. 카운트다운처럼 매초 변하는 값을
 *   여기 넣지 마라 — 1초마다 1024×576 캔버스를 GPU 로 올리게 된다. 남은 시간은
 *   HUD(page.tsx)가 DOM 으로 그린다.
 *
 * 테이블 **충돌**은 여기 있지 않다 — lib/mp/collide.ts 의 COLLIDERS 마지막 항목이다
 * (워커의 봇도 같은 테이블을 피해야 하므로 거긴 three 를 못 읽는다). 좌표를 옮기면
 * 이 파일의 CENTER/TABLE_R 과 collide.ts 를 **같이** 고친다.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { EYE_HEIGHT } from '@/lib/mp/constants';
import { SPAWN_CENTER } from '@/lib/mp/spawn';
import type { RoundPhase } from '@/lib/mp/protocol';
import type { RevealResult } from './net/connection';
import { useWorldStore } from './store';
import { useRoundtableStore } from './roundtable-store';
// 주제는 배경의 영사막에 뜬다. 배치를 아는 건 그 파일뿐이므로 좌표·크기를 읽어 온다
// (단방향 import — warehouse 는 이 파일을 모른다).
import { SCREEN_FOCUS, SCREEN_FRONT_Z, SCREEN_SIZE } from './warehouse';

/**
 * 테이블 중심 = 좌석 스폰 원의 중심.
 *
 * ★ 식을 베껴 두지 않는다 — lib/mp/spawn.ts 의 SPAWN_CENTER 를 그대로 읽는다.
 *   전에는 같은 계산이 두 파일에 적혀 있었고, 워커의 봇 목적지(BOT_GATHER_RADIUS)까지
 *   합치면 세 벌이 된다. 한 벌만 어긋나도 아바타가 테이블을 등지고 둘러선다.
 */
const CENTER = SPAWN_CENTER;

/** 테이블 상판 반지름(m). collide.ts 의 hw(0.95)는 이 원의 내접 정사각형 근사다. */
const TABLE_R = 1.35;
/** 상판 윗면 높이. collide.ts 의 top(0.74)과 같아야 한다 — 여기가 발이 닿는 높이다. */
const TABLE_TOP = 0.74;

const WOOD_DARK = '#241a13';
const STEEL = '#1e1b17';

/* ─────────────────────────────── 테이블 ─────────────────────────────── */

/** 원형 테이블 — 상판 + 기둥 + 받침. 좌석 원 한가운데에 선다. */
export function RoundTable() {
  return (
    <group position={[CENTER.x, 0, CENTER.z]}>
      {/* 상판 */}
      <mesh position={[0, TABLE_TOP, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[TABLE_R, TABLE_R, 0.08, 48]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.6} metalness={0.05} />
      </mesh>
      {/* 상판 테두리 띠 — 밋밋함을 줄이고 스케일이 읽히게 */}
      <mesh position={[0, TABLE_TOP - 0.06, 0]}>
        <cylinderGeometry args={[TABLE_R, TABLE_R - 0.02, 0.06, 48]} />
        <meshStandardMaterial color="#160f0a" roughness={0.75} />
      </mesh>
      {/* 중앙 기둥 */}
      <mesh position={[0, TABLE_TOP / 2, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.22, TABLE_TOP, 20]} />
        <meshStandardMaterial color="#191310" roughness={0.8} metalness={0.15} />
      </mesh>
      {/* 받침 */}
      <mesh position={[0, 0.04, 0]} receiveShadow>
        <cylinderGeometry args={[0.62, 0.7, 0.08, 28]} />
        <meshStandardMaterial color={STEEL} roughness={0.7} metalness={0.35} />
      </mesh>
    </group>
  );
}

/* ─────────────────────────────── 주제 스크린 ─────────────────────────────── */

/**
 * 주제 캔버스 해상도. **영사막과 같은 16:9** 여야 글자가 안 늘어난다
 * (warehouse.tsx 의 SCREEN 이 10 × 5.625 = 16:9).
 */
const TOPIC_TEX_W = 1024;
const TOPIC_TEX_H = 576;

/** 원문자. 주제 라운드 표시(①②)에 쓴다. 범위를 넘으면 그냥 숫자로 떨어진다 */
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

/** 스크린에 그릴 알맹이. 단계마다 이 셋이 통째로 바뀐다 */
interface ScreenContent {
  /** 머리말 — 지금 무슨 단계인가 */
  head: string;
  /** 본문 — 주제 문장이거나, 그 단계에 무엇을 해야 하는가 */
  body: string;
  /** 단계 색. **스크린이 판의 나침반이 되는 게 이 색이다** */
  accent: string;
  /** 본문을 크게 쓸까(주제 문장) 작게 쓸까(안내 문구) */
  strong: boolean;
}

const ACCENT_WAIT = '#8c8478';
const ACCENT_TOPIC = '#d4a373';
const ACCENT_TALK = '#93b7c9';
const ACCENT_JUDGE = '#d4645a';
const ACCENT_RESULT = '#e8c86a';

/**
 * 단계 → 스크린 문구.
 *
 * ★ **모든 자리에 같은 것이 뜬다.** 지목된 사람에게만 다른 문구를 띄우고 싶어지는
 *   순간이 오는데(예: "당신의 변론이다"), 그건 HUD 가 할 일이다 — 스크린은 공간에
 *   하나뿐이라 남이 보는 화면이 나와 다르면 그 차이가 곧 정보가 된다.
 *
 * ★ 닉네임은 store 에서 **읽기만** 한다(getState). 여기는 단계가 바뀔 때만 도는
 *   경로라 구독할 필요가 없고, 구독하면 좌표 갱신마다 텍스처를 다시 굽게 된다.
 */
function screenContent(
  phase: RoundPhase,
  topic: string | null,
  round: number,
  totalRounds: number,
  nomineeId: string | null,
  reveal: RevealResult | null,
): ScreenContent {
  const mark = round >= 1 && round <= CIRCLED.length ? CIRCLED[round - 1] : String(round);
  const lap = totalRounds > 1 ? ` (${round}/${totalRounds})` : '';

  switch (phase) {
    /*
     * ★ 주제 단계에는 **주제를 안 쓴다.** 여기는 뜸 들이는 6초고, 주제는 그 시간이
     *   끝나야 나온다. 워커도 이 단계에는 topic 을 안 실어 보내므로(roundSnapshot)
     *   여기서 topic 을 쓰면 늘 null 이다 — 규칙이 두 군데서 같은 말을 한다.
     */
    case 'topic':
      return { head: `주제 ${mark}${lap}`, body: '곧 주제가 나온다', accent: ACCENT_TOPIC, strong: false };
    case 'speak':
      return {
        head: `주제 ${mark} · 다같이 말한다`,
        body: topic ?? '…',
        accent: ACCENT_TOPIC,
        strong: true,
      };
    case 'freechat':
      return {
        head: '자유 대화',
        body: '이제 서로에게 묻는다',
        accent: ACCENT_TALK,
        strong: false,
      };
    case 'vote':
      return {
        head: '지목 투표',
        body: 'AI 같은 한 사람을 고른다',
        accent: ACCENT_JUDGE,
        strong: false,
      };
    case 'defense': {
      const who = nicknameOf(nomineeId);
      return {
        head: '최후 변론',
        body: who ? `${who} 의 마지막 말` : '지목된 사람의 마지막 말',
        accent: ACCENT_RESULT,
        strong: false,
      };
    }
    case 'verdict':
      return {
        head: '생사 재투표',
        body: '찬성이 과반이면 처형된다',
        accent: ACCENT_JUDGE,
        strong: false,
      };
    case 'reveal': {
      // reveal 이 아직 안 왔을 수도 있다(round 가 먼저 온다). 그때는 뜸만 들인다.
      if (!reveal) return { head: '결과', body: '……', accent: ACCENT_RESULT, strong: false };
      const who = nicknameOf(reveal.nomineeId);
      return {
        head: `결과 · ${winnerLabel(reveal.winner)}`,
        body: reveal.executed
          ? `${who ?? '지목된 사람'} 은(는) 처형됐다`
          : '아무도 처형되지 않았다',
        accent: ACCENT_RESULT,
        strong: false,
      };
    }
    case 'ended':
      return { head: '판이 끝났다', body: '', accent: ACCENT_WAIT, strong: false };
    default:
      return { head: '라운드테이블', body: '잠시 후 시작합니다', accent: ACCENT_WAIT, strong: false };
  }
}

/** 승리 진영 이름. 'actor' 는 아직 워커가 내지 않지만 union 에 있으므로 같이 받는다 */
function winnerLabel(winner: RevealResult['winner']): string {
  return winner === 'citizen' ? '시민 승' : winner === 'actor' ? '연기자 승' : 'AI 승';
}

/**
 * players.id → 닉네임. 본인은 원격 Map 에 없으므로(store.ts) self 에서 따로 꺼낸다.
 * ★ 여기서 "찾았는가"로 봇을 가릴 수 없다 — 봇도 사람과 같이 players 에 들어 있다.
 */
function nicknameOf(id: string | null): string | null {
  if (!id) return null;
  const ws = useWorldStore.getState();
  if (id === ws.selfId) return ws.self?.nickname ?? '나';
  return ws.players.get(id)?.nickname ?? null;
}

/**
 * 주제 영사 — **인트로 영상이 나오던 그 대형 스크린에 그대로 뜬다.**
 *
 * ┌─ 왜 테이블 위가 아니라 영사막인가 ────────────────────────────────────────┐
 * │ 한동안 좌석 원 한가운데에 작은 판(3.6m)을 띄워 두고 천천히 돌렸다. 원형     │
 * │ 좌석 어디서도 읽히게 하려던 것인데, 정작 **사람들이 보고 있는 곳은 거기가   │
 * │ 아니었다.** 들어오면 스크린을 보고 시작하고(LocalRig 의 초기 시선),         │
 * │ 인트로 20초 카운트다운과 영상이 전부 그 막에서 흐른다 — 판이 시작되는 순간  │
 * │ 시선을 등 뒤 테이블로 옮기라고 요구하는 꼴이었다.                          │
 * │                                                                          │
 * │ 영사막은 크고(10m) 방 어디서나 보이며 이미 모두가 향하고 있다. 주제를 여기  │
 * │ 띄우면 "영상 → 주제 → 투표 → 결과"가 **한 화면에서 이어진다.**             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ★ z 는 warehouse 의 SCREEN_FRONT_Z 를 그대로 쓴다. 막에는 면이 넷 겹쳐 있어서
 *   (액자 · 흰 막 · 영상 · 카운트다운) 눈대중으로 "막 앞"을 잡으면 영상 뒤에 깔린다.
 * ★ **idle 에는 아무것도 그리지 않는다** — 그래야 인트로 영상이 가려지지 않는다.
 *   판이 열리는 순간부터 이 판이 영상 위를 덮는다(영상은 그때 이미 끝나 있다).
 *
 * 글자는 2D 캔버스에 그려 텍스처로 올린다 — 문장 한 줄에 3D 폰트 로더를 새로 들이지
 * 않는다 (warehouse.tsx 의 ScreenCountdown 과 같은 방식).
 */
export function TopicProjection() {
  const phase = useRoundtableStore((s) => s.phase);
  const topic = useRoundtableStore((s) => s.topic);
  const round = useRoundtableStore((s) => s.round);
  const totalRounds = useRoundtableStore((s) => s.totalRounds);
  const nomineeId = useRoundtableStore((s) => s.nomineeId);
  const reveal = useRoundtableStore((s) => s.reveal);

  // ★ deps 가 전부 "단계가 바뀔 때만 움직이는 값"이라 판 하나에 열 번 남짓 굽는다.
  const texture = useMemo(
    () => makeScreenTexture(screenContent(phase, topic, round, totalRounds, nomineeId, reveal), round, totalRounds),
    [phase, topic, round, totalRounds, nomineeId, reveal],
  );
  useEffect(() => () => texture.dispose(), [texture]);

  // 판이 열리기 전에는 영상의 자리다. 비켜 준다.
  if (phase === 'idle') return null;

  return (
    <mesh position={[SCREEN_FOCUS.x, SCREEN_FOCUS.y, SCREEN_FRONT_Z]}>
      <planeGeometry args={[SCREEN_SIZE.w, SCREEN_SIZE.h]} />
      {/*
        스스로 빛나는 면이다(toneMapped 끔) — 어두운 창고에서 standard 재질로 두면
        거의 안 보인다. 영상막(warehouse.tsx)과 같은 이유.
      */}
      <meshBasicMaterial map={texture} transparent toneMapped={false} />
    </mesh>
  );
}

/** 스크린 알맹이를 텍스처로 굽는다. 단계 색이 테두리·머리말·진행 점에 함께 쓰인다. */
function makeScreenTexture(c: ScreenContent, round: number, totalRounds: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TOPIC_TEX_W;
  canvas.height = TOPIC_TEX_H;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // 둥근 어두운 판
    roundRect(ctx, 8, 8, TOPIC_TEX_W - 16, TOPIC_TEX_H - 16, 28);
    ctx.fillStyle = 'rgba(12,9,6,0.92)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = c.accent;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 머리말 — 단계 이름
    ctx.fillStyle = c.accent;
    ctx.font = '600 40px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(c.head, TOPIC_TEX_W / 2, 96);

    /*
     * 본문. **영사막은 10m 라 글자를 키우면 오히려 못 읽는다** — 한 줄이 시야를
     * 가로질러 눈이 문장을 훑어야 한다. 판이 작던 시절(3.6m)의 58px 를 그대로 두면
     * 두세 단어에서 줄이 넘어가므로, 캔버스가 커진 만큼만 올리고 여백을 넓게 준다.
     */
    if (c.body) {
      if (c.strong) {
        ctx.fillStyle = '#f4ead6';
        ctx.font = '700 64px ui-sans-serif, system-ui, sans-serif';
        wrapText(ctx, c.body, TOPIC_TEX_W / 2, TOPIC_TEX_H / 2 + 24, TOPIC_TEX_W - 180, 82);
      } else {
        ctx.fillStyle = 'rgba(238,232,220,0.72)';
        ctx.font = '500 50px ui-sans-serif, system-ui, sans-serif';
        wrapText(ctx, c.body, TOPIC_TEX_W / 2, TOPIC_TEX_H / 2 + 24, TOPIC_TEX_W - 200, 66);
      }
    }

    // 주제 라운드 진행 점 — 지금이 몇 번째 주제인가. 주제 단계가 아니면 안 그린다.
    if (round >= 1 && totalRounds >= 2) {
      const gap = 34;
      const left = TOPIC_TEX_W / 2 - ((totalRounds - 1) * gap) / 2;
      for (let i = 0; i < totalRounds; i += 1) {
        ctx.beginPath();
        ctx.arc(left + i * gap, TOPIC_TEX_H - 70, 9, 0, Math.PI * 2);
        ctx.fillStyle = c.accent;
        ctx.globalAlpha = i < round ? 0.95 : 0.22;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 최대 폭에 맞춰 줄바꿈해 가운데 정렬로 그린다. 한국어라 어절(공백) 우선으로 끊는다. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const top = cy - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lineHeight));
}

/* ─────────────────────────────── 스포트라이트 ─────────────────────────────── */

/** 스포트라이트가 내려오는 높이(처마 아래). 위에서 곧게 내리꽂는다. */
const SPOT_HEIGHT = 6;
/** 밝을 때 세기. 0 ↔ 이 값 사이를 부드럽게 오간다. */
const SPOT_INTENSITY = 300;
/** 조준점을 몸통 높이로 살짝 올린다 — 발끝을 겨누면 얼굴이 어둡다. */
const SPOT_AIM_UP = 1.0;
/** 자리 추적·세기 변화의 감쇠 계수. 클수록 빠르게 따라붙는다. */
const FOLLOW_K = 6;

/** 발밑 빛 웅덩이의 반지름(m)·최대 불투명도. 조명이 어디를 겨누는지 바닥에서도 읽히게 */
const POOL_R = 0.95;
const POOL_ALPHA = 0.22;

/**
 * 지금 지목된 한 사람만 위에서 비춘다. store 의 spotlightId 가 가리키는 자리를 따라간다.
 *
 * ★ **켜지는 단계는 defense 하나뿐이다.** 서버가 그때만 spotlightId 를 채우기 때문이고,
 *   그게 이 파일이 지켜야 할 계약이다 (protocol.ts · roundtable-store.ts 머리말).
 *   nomineeId 는 defense **이전부터** 채워지는 값이라 조명 소스로 쓰면 안 된다 — 두
 *   값이 갈리는 순간 "조명받은 자리"가 단계와 무관한 신호가 된다. 여기는 끝까지
 *   spotlightId **하나만** 본다.
 *
 *  · spotlightId 가 null → 세기를 0으로 낮춰 꺼진 듯 둔다 (라이트는 살려 둔다 — 껐다
 *    켜면 그림자 맵을 다시 굽느라 프레임이 튄다).
 *  · 본인이 지목되면 카메라 위치를 자리로 쓴다 (내 좌표는 store 가 아니라 LocalRig 에 있다).
 *  · 남/봇이면 store.players 의 보간된 pose 를 쓴다 — 그 자리로 부드럽게 미끄러진다.
 *
 * 좌표는 매 프레임 getState()로 읽는다(구독하지 않는다). 10Hz 로 갱신되는 값을 구독하면
 * 이 컴포넌트가 초당 수십 번 리렌더된다 (store.ts 머리말과 같은 규칙).
 */
export function PlayerSpotlight() {
  const { camera } = useThree();
  const light = useRef<THREE.SpotLight>(null);
  const target = useRef<THREE.Object3D>(null);
  const pool = useRef<THREE.Mesh>(null);
  // 조준점을 프레임 사이에 이어서 미끄러뜨린다. 첫 프레임은 테이블 중앙에서 시작한다.
  const at = useRef({ x: CENTER.x, z: CENTER.z, y: SPOT_AIM_UP });

  useLayoutEffect(() => {
    if (light.current && target.current) light.current.target = target.current;
  }, []);

  useFrame((_, delta) => {
    const l = light.current;
    const t = target.current;
    if (!l || !t) return;

    const id = useRoundtableStore.getState().spotlightId;
    const ws = useWorldStore.getState();

    let tx: number | null = null;
    let tz = 0;
    let feet = 0;
    if (id) {
      if (id === ws.selfId) {
        tx = camera.position.x;
        tz = camera.position.z;
        feet = camera.position.y - EYE_HEIGHT;
      } else {
        const p = ws.players.get(id);
        if (p) {
          tx = p.pose.x;
          tz = p.pose.z;
          feet = p.pose.y;
        }
      }
    }

    const k = Math.min(delta * FOLLOW_K, 1);
    const active = tx !== null;

    // 세기 페이드 — 켜지고 꺼지는 게 툭 튀지 않게
    l.intensity += ((active ? SPOT_INTENSITY : 0) - l.intensity) * k;

    if (active) {
      at.current.x += (tx! - at.current.x) * k;
      at.current.z += (tz - at.current.z) * k;
      at.current.y += (feet + SPOT_AIM_UP - at.current.y) * k;
      l.position.set(at.current.x, SPOT_HEIGHT, at.current.z);
      t.position.set(at.current.x, at.current.y, at.current.z);
    }

    /*
     * 바닥의 빛 웅덩이. Canvas 는 shadows={false} 라(world-scene.tsx) 스포트라이트만
     * 켜서는 "누구를 겨누는지"가 발밑에서 안 읽힌다 — 옆에서 보면 그냥 몸이 밝을 뿐이다.
     * 세기에 비례해 같이 밝아지므로 켜고 끄는 코드가 따로 필요 없다.
     */
    const p = pool.current;
    if (p) {
      const mat = p.material as THREE.MeshBasicMaterial;
      mat.opacity = (l.intensity / SPOT_INTENSITY) * POOL_ALPHA;
      p.visible = mat.opacity > 0.005;
      // 조준점은 몸통 높이라 SPOT_AIM_UP 을 도로 빼야 발밑에 깔린다
      p.position.set(at.current.x, at.current.y - SPOT_AIM_UP + 0.03, at.current.z);
    }
  });

  return (
    <>
      <object3D ref={target} position={[CENTER.x, SPOT_AIM_UP, CENTER.z]} />
      <spotLight
        ref={light}
        position={[CENTER.x, SPOT_HEIGHT, CENTER.z]}
        angle={0.3}
        penumbra={0.75}
        intensity={0}
        distance={22}
        decay={1.3}
        color="#fff1d6"
      />
      <mesh ref={pool} rotation-x={-Math.PI / 2} position={[CENTER.x, 0.03, CENTER.z]} visible={false}>
        <circleGeometry args={[POOL_R, 32]} />
        <meshBasicMaterial
          color="#ffe9c4"
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}

/* ─────────────────────────────── 무대등 ─────────────────────────────── */

/** 무대등이 매달린 높이. 스크린(3.05)보다 위, 트러스(5.6)보다 아래 */
const MOOD_HEIGHT = 4.4;
/** 색·세기가 새 단계로 넘어가는 감쇠 계수. 스포트(6)보다 느려야 "분위기"로 읽힌다 */
const MOOD_K = 1.6;

/**
 * 단계별 공간 색. **연출이지 정보가 아니다** — 전 좌석이 같은 빛을 받는다.
 * defense 는 일부러 낮춘다: 그 단계의 빛은 스포트라이트가 맡아야 한 사람만 도드라진다.
 */
const MOOD: Record<RoundPhase, { color: number; intensity: number }> = {
  idle: { color: 0x2a2118, intensity: 0 },
  topic: { color: 0xd4a373, intensity: 26 },
  speak: { color: 0xd4a373, intensity: 16 },
  freechat: { color: 0x93b7c9, intensity: 14 },
  vote: { color: 0x5f7fbf, intensity: 30 },
  defense: { color: 0x2a3550, intensity: 8 },
  verdict: { color: 0xbf5a4a, intensity: 30 },
  reveal: { color: 0xff6a52, intensity: 55 },
  ended: { color: 0x6b6257, intensity: 10 },
};

/** 목표 색을 담아 두는 임시 그릇. useFrame 안에서 새로 만들지 않기 위한 것뿐이다 */
const MOOD_SCRATCH = new THREE.Color();

/**
 * 테이블 위 무대등 하나 — 단계가 바뀌면 공간 전체의 색이 바뀐다.
 *
 * 조명을 **하나만** 쓴다. 창고에는 이미 스포트가 여럿 있어서(warehouse.tsx Lights)
 * 단계마다 라이트를 더 켜면 8인 방에서 프레임이 떨어진다. 색과 세기만 바꿔도
 * "지금 분위기가 달라졌다"는 신호로는 충분하다.
 *
 * 처형이 확정된 reveal 에서만 맥박처럼 뛴다. 처형이 없었으면 같은 붉은색이 가만히
 * 있는다 — **뛰는지 아닌지가 결과를 말한다**(정체가 아니라 결과다. 이미 공개된 값이다).
 *
 * 구독하지 않는다. 매 프레임 getState() 로 읽고 값을 감쇠 보간할 뿐이라 리렌더가 0이다.
 */
export function StageMood() {
  const light = useRef<THREE.PointLight>(null);
  const now = useRef({ r: 0.16, g: 0.13, b: 0.09, i: 0 });
  const clock = useRef(0);

  useFrame((_, delta) => {
    const l = light.current;
    if (!l) return;

    const s = useRoundtableStore.getState();
    const m = MOOD[s.phase] ?? MOOD.idle;

    clock.current += delta;
    // 처형이 확정됐을 때만 맥박. reveal 이 아직 안 왔으면 executed 는 undefined 라 조용하다.
    const pulse =
      s.phase === 'reveal' && s.reveal?.executed ? 0.72 + 0.28 * Math.sin(clock.current * 5.5) : 1;

    // 매 프레임 new Color 를 만들면 초당 60개를 GC 에 던진다. 하나를 돌려 쓴다.
    const target = MOOD_SCRATCH.setHex(m.color);
    const k = Math.min(delta * MOOD_K, 1);
    now.current.r += (target.r - now.current.r) * k;
    now.current.g += (target.g - now.current.g) * k;
    now.current.b += (target.b - now.current.b) * k;
    now.current.i += (m.intensity * pulse - now.current.i) * k;

    l.color.setRGB(now.current.r, now.current.g, now.current.b);
    l.intensity = now.current.i;
  });

  return (
    <pointLight
      ref={light}
      position={[CENTER.x, MOOD_HEIGHT, CENTER.z]}
      intensity={0}
      distance={26}
      decay={1.45}
    />
  );
}
