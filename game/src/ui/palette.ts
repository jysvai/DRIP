// 캔버스(메뉴 지도·미니맵)에서 쓰는 색. style.css :root 토큰의 OKLCH 값을 sRGB로 옮긴 것 (캔버스는 CSS 변수를 못 읽는다).
// 토큰을 바꾸면 여기도 같이 바꾼다.

export const PAL = {
  /** --c-paper oklch(15% 0.012 250) */
  paper: "#080c10",
  /** --c-paper-2 oklch(19% 0.013 250) */
  paper2: "#0f1419",
  /** --c-rule oklch(33% 0.014 250) */
  rule: "#30363c",
  /** --c-muted oklch(72% 0.014 250) */
  muted: "#9ea5ad",
  /** --c-ink oklch(95.5% 0.006 250) */
  ink: "#edf0f4",
  /** --c-route oklch(76% 0.17 152): 내 경로 */
  route: "#47cf79",
  /** --c-sign-deep oklch(38% 0.085 158): 경로 테두리 */
  routeCasing: "#075030",
  /** --c-danger oklch(63% 0.21 27): 도착 */
  danger: "#ed413b",
  /** --c-warn oklch(84% 0.155 85): 분기점 */
  warn: "#f9c13b",
  /** 지도 바탕·도로 (map-* 토큰) */
  land: "#04080b",
  road: "#4e5a62",
  roadDim: "#313940",
  label: "#b7bfc5",
  labelDim: "#7f878e",
  /** 지명 글자 테두리 (바탕 위에서 읽히게) */
  halo: "rgba(4, 8, 11, 0.92)",
  grid: "rgba(110, 117, 126, 0.08)",
} as const;

export const FONT_UI = "'Pretendard Variable', Pretendard, 'Malgun Gothic', sans-serif";
export const FONT_NUM = "'Barlow Semi Condensed', 'Pretendard Variable', sans-serif";
