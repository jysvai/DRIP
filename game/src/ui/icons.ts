// 화면 전체에서 같이 쓰는 아이콘과 워드마크. 선 아이콘은 24 격자, 1.75 굵기, 둥근 끝으로 통일한다.
// 내비 화살표·차로 화살표는 도로 표지처럼 굵은 선과 면으로 그린다.

const line = (d: string, size = 18) =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const ICON = {
  arrowRight: line(`<path d="M5 12h14M13 6l6 6-6 6"/>`),
  swap: line(`<path d="M8 4v16M8 4 4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/>`),
  plus: line(`<path d="M12 5v14M5 12h14"/>`),
  minus: line(`<path d="M5 12h14"/>`),
  fit: line(`<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`),
  external: line(`<path d="M9 5H5v14h14v-4M13 5h6v6M19 5l-8 8"/>`, 14),
  close: line(`<path d="M6 6l12 12M18 6 6 18"/>`),
  check: line(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`),
  info: line(`<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>`),
  warn: line(`<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.1"/>`),
  alert: line(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/>`),
  download: line(`<path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/>`),
  retry: line(`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2"/>`),
  map: line(`<path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>`),
  keyboard: line(`<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>`),
  // 날씨
  sun: line(`<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>`, 22),
  cloud: line(`<path d="M7 18.5h10a4 4 0 0 0 .6-8 5.5 5.5 0 0 0-10.7 1.3A3.4 3.4 0 0 0 7 18.5z"/>`, 22),
  rain: line(`<path d="M7 14.5h10a3.6 3.6 0 0 0 .5-7.2 5 5 0 0 0-9.6 1.2A3 3 0 0 0 7 14.5z"/><path d="M9 17.5l-1 2.5M13 17.5l-1 2.5M17 17.5l-1 2.5"/>`, 22),
  storm: line(`<path d="M7 13.5h10a3.6 3.6 0 0 0 .5-7.2 5 5 0 0 0-9.6 1.2A3 3 0 0 0 7 13.5z"/><path d="M7.5 16l-1.5 4M11 16l-1.5 4M14.5 16 13 20M18 16l-1.5 4"/>`, 22),
  fog: line(`<path d="M4 8.5h16M3 12h13M6 15.5h15M4 19h12"/>`, 22),
  snow: line(`<path d="M12 3.5v17M4.6 7.75l14.8 8.5M4.6 16.25l14.8-8.5M9.5 4.8 12 6.6l2.5-1.8M9.5 19.2l2.5-1.8 2.5 1.8"/>`, 22),
  blizzard: line(`<path d="M8 4v9M4.1 6.25l7.8 4.5M4.1 10.75l7.8-4.5"/><path d="M16.5 11v9M12.6 13.25l7.8 4.5M12.6 17.75l7.8-4.5"/>`, 22),
  ice: line(`<path d="M3 17.5h18M5 20.5h14"/><path d="M12 3.5v9M8.1 5.75l7.8 4.5M8.1 10.25l7.8-4.5"/>`, 22),
  real: line(`<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4M8 13.5h3M8 16.5h6"/>`, 22),
  // 내비 알림
  camera: line(`<rect x="3" y="7" width="13" height="8" rx="1.5"/><path d="M16 9.5l4.5-2v7l-4.5-2"/><circle cx="8" cy="11" r="2"/><path d="M7 15v5"/>`),
  cone: line(`<path d="M9.8 4h4.4l4.3 14H5.5z"/><path d="M8.3 9.5h7.4M7 14h10M3.5 18h17"/>`),
  flake: line(`<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>`),
  // 조작
  gamepad: line(`<path d="M7 8h10a4 4 0 0 1 3.9 3.1l1 4.6a2.4 2.4 0 0 1-4.2 2L16 16H8l-1.7 1.7a2.4 2.4 0 0 1-4.2-2l1-4.6A4 4 0 0 1 7 8z"/><path d="M7.5 11v3M6 12.5h3M15.5 11.5h.01M17.5 13.5h.01"/>`, 22),
  pedal: line(`<rect x="7" y="3.5" width="10" height="17" rx="2"/><path d="M9.5 8h5M9.5 12h5M9.5 16h5"/>`),
};

/** 내비 방향 화살표 (도로 표지처럼 굵게). 갈라지는 쪽은 밝게, 그대로 가는 본선은 흐리게 */
const navSvg = (d: string) => `<svg viewBox="0 0 48 48" aria-hidden="true">${d}</svg>`;
const stem = (d: string, dim = false) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round"${dim ? ' opacity="0.3"' : ""}/>`;
export const NAV_ARROW = {
  up: navSvg(`${stem("M24 44V17")}<path fill="currentColor" d="M24 4 36 18H12z"/>`),
  right: navSvg(`${stem("M19 30V6", true)}${stem("M19 44V29l11-11")}<path fill="currentColor" d="M38 10 36.2 25.6 22.4 11.8z"/>`),
  left: navSvg(`${stem("M29 30V6", true)}${stem("M29 44V29L18 18")}<path fill="currentColor" d="M10 10l1.8 15.6 13.8-13.8z"/>`),
  flag: navSvg(`<path fill="currentColor" d="M12 5h4v38h-4z"/><path fill="currentColor" d="M18 7h20l-5 8 5 8H18z"/>`),
};

/** 차로 안내 칸 안의 작은 화살표 */
const laneSvg = (d: string) => `<svg viewBox="0 0 20 28" aria-hidden="true">${d}</svg>`;
const laneStem = (d: string) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round"/>`;
export const LANE_ARROW = {
  up: laneSvg(`${laneStem("M10 26V10")}<path fill="currentColor" d="M10 2.5 16 11H4z"/>`),
  right: laneSvg(`${laneStem("M7.5 26V15.5l5-5")}<path fill="currentColor" d="M17 5.5 15.4 14 8.6 7.2z"/>`),
  left: laneSvg(`${laneStem("M12.5 26V15.5l-5-5")}<path fill="currentColor" d="M3 5.5 4.6 14l6.8-6.8z"/>`),
  closed: laneSvg(`<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M5 9l10 10M15 9 5 19"/>`),
};

/** DRIP 워드마크: 초록 고속도로 표지판 칸 안에 소실점으로 모이는 길 */
export const WORDMARK = `<span class="wordmark"><svg class="wm-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" class="wm-plate"/><path d="M5 29 14.6 7M27 29 17.4 7" class="wm-edge"/><path d="M16 27.5v-4.2M16 19.6v-3.1M16 13.3v-2.2M16 8.8V7.4" class="wm-dash"/></svg><span class="wm-text">DRIP</span></span>`;
