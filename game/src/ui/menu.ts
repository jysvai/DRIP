// 시작 메뉴: 출발지·도착지를 넣어 경로를 찾고(전국 고속도로망 지도), 차량과 주행 환경을 고른다.

import type { Network, Place, Leg } from "../road/route";
import { buildPlaces, findRoute, searchPlaces } from "../road/route";
import type { RealTraffic } from "../sim/config";
import { specFor } from "../sim/vehicleSpec";
import type { RealWeatherData, WeatherChoice } from "../sim/weather";
import { paletteFor, type VehicleCatalog, type VehicleType } from "../render/vehicleModels";
import { NetMap } from "./netMap";
import { VehiclePreview } from "./vehiclePreview";
import { controlsHtml, showControls } from "./help";
import { ICON, WORDMARK } from "./icons";
import { COLLECTING } from "../log/recorder";
import type { PedalMode } from "../sim/input";
import { digestForLegs, playDistance } from "../sim/pacing";
import { searchCityPlaces, type CityGraph, type CityPlace } from "../city/graph";
import type { CityNet } from "../city/net";
import { findCityRoute, type CityRoutePlan } from "../city/route";
import { loadCity } from "../city/load";

export type Preset = "자동" | "한산" | "보통" | "혼잡" | "정체" | "실제";
export type CameraMode = "cockpit" | "chase" | "hood";
export type Quality = "auto" | "low" | "medium" | "high" | "ultra";
/** 화면 흔들림 (노면 요철·신축이음·충돌) */
export type ShakeLevel = "on" | "low" | "off";
/** 주행 방식: digest는 1시간 경로를 5분쯤으로 (몇 구간만 실시간으로 달리고 사이는 건너뛴다), full은 처음부터 끝까지 */
export type Pace = "digest" | "full";

export interface RouteChoice {
  from: string;
  to: string;
  legs: Leg[];
  lengthM: number;
  timeS: number;
}

export interface DriveSettings {
  route: RouteChoice;
  /** 경로 시작점부터 출발 위치 (km) */
  startKm: number;
  vehicle: string;
  color: string;
  preset: Preset;
  hour: number;
  weekend: boolean;
  /** 날씨 (없으면 맑음). real이면 어제 같은 시각 출발 지점의 실제 날씨 */
  weather?: WeatherChoice;
  camera: CameraMode;
  consent: boolean;
  sound: boolean;
  /** 내비 음성 안내 */
  voice: boolean;
  quality: Quality;
  /** 화면 흔들림 정도. 멀미가 나면 줄인다 */
  shake: ShakeLevel;
  /** 주행 방식 (없으면 요약) */
  pace?: Pace;
  /** 차로 유지 보조 (없으면 켬) */
  lka?: boolean;
  /** 키보드 가속 페달 (없으면 누른 만큼 유지) */
  pedal?: PedalMode;
  /** 시내 주행: 지역(public/city/{region}.json)과 출발지·도착지 이름 (없으면 고속도로) */
  city?: { region: string; from: string; to: string } | null;
  seed: number;
}

const STORE = "drip_settings_v2";
const CATEGORY_ORDER = ["승용", "SUV", "전기차", "택시", "버스", "화물", "특수"];
const POPULAR: [string, string][] = [
  ["서울", "부산"],
  ["서울", "강릉"],
  ["서울", "목포"],
  ["인천공항", "대전"],
  ["광주", "대구"],
  ["수원", "속초"],
];

/** 시내 주행 자주 달리는 길 (서울) */
const CITY_POPULAR: [string, string][] = [
  ["강동역", "삼원타워"],
  ["강남역", "잠실역"],
  ["서울역", "경복궁"],
  ["여의도역", "홍대입구역"],
  ["건대입구역", "왕십리역"],
  ["시청역", "이태원역"],
];
const CITY_KIND: Record<string, string> = { 역: "지하철역", 건물: "건물", 명소: "명소" };

function load(): Partial<DriveSettings> & { fromName?: string; toName?: string } {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}");
  } catch {
    return {};
  }
}

function save(s: DriveSettings) {
  try {
    const { route, ...rest } = s;
    localStorage.setItem(STORE, JSON.stringify({ ...rest, fromName: route.from, toName: route.to }));
  } catch {
    // 저장이 안 돼도 게임은 된다
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 걸리는 시간을 숫자는 크게, 단위는 작게 */
function durationHtml(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}<small>분</small>`;
  return `${Math.floor(m / 60)}<small>시간</small>${String(m % 60).padStart(2, "0")}<small>분</small>`;
}

function hourPart(h: number): string {
  return h < 5 ? "새벽" : h < 7 ? "이른 아침" : h < 10 ? "아침" : h < 16 ? "낮" : h < 19 ? "저녁" : "밤";
}

const KIND_LABEL: Record<Place["kind"], string> = { 도시: "도시", IC: "나들목", JC: "분기점", TG: "요금소", SA: "휴게소", 기타: "" };

/** 날씨 칸: 아이콘, 이름, 법정 감속 (도로교통법 시행규칙 제19조) */
const WEATHER_OPTS: [WeatherChoice, string, string, string][] = [
  ["clear", "맑음", "", ICON.sun],
  ["cloudy", "흐림", "", ICON.cloud],
  ["rain", "비", "감속 20%", ICON.rain],
  ["heavy_rain", "폭우", "감속 50%", ICON.storm],
  ["fog", "짙은 안개", "감속 50%", ICON.fog],
  ["snow", "눈", "감속 20%", ICON.snow],
  ["heavy_snow", "폭설", "감속 50%", ICON.blizzard],
  ["black_ice", "새벽 결빙", "다리 위·터널 출구", ICON.ice],
];

/** 교통량 칸 그림: 막대 네 개 중 채운 수 */
function density(n: number): string {
  const bars = [0, 1, 2, 3].map((i) => `<rect x="${3 + i * 5}" y="${16 - i * 3.5}" width="3" height="${5 + i * 3.5}" rx="1"${i < n ? ' fill="currentColor"' : ""}/>`).join("");
  return `<svg class="ic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">${bars}</svg>`;
}

export function showMenu(net: Network, catalog: VehicleCatalog, real: RealTraffic | null, realWeather: RealWeatherData | null = null): Promise<DriveSettings> {
  return new Promise((resolve) => {
    const places = buildPlaces(net);
    const saved = load();
    const now = new Date();
    const byName = (n?: string) => (n ? places.find((p) => p.name === n) ?? null : null);
    let from: Place | null = byName(saved.fromName) ?? byName("서울");
    let to: Place | null = byName(saved.toName) ?? byName("부산");
    let plan: ReturnType<typeof findRoute> = null;
    let startKm = 0;
    const types = [...catalog.types].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
    let vehicle: VehicleType = types.find((t) => t.id === saved.vehicle) ?? types.find((t) => t.id === "sedan_mid") ?? types[0];
    let color = saved.color && paletteFor(vehicle, catalog).includes(saved.color) ? saved.color : paletteFor(vehicle, catalog)[0];
    let category = vehicle.category;
    let preset: Preset = saved.preset ?? "자동";
    let hour = now.getHours();
    let weekend = now.getDay() === 0 || now.getDay() === 6;
    let weather: WeatherChoice = saved.weather === "real" && !realWeather ? "clear" : (saved.weather ?? "clear");
    let camera: CameraMode = saved.camera ?? "cockpit";
    let sound = saved.sound ?? true;
    let voice = saved.voice ?? true;
    let quality: Quality = saved.quality ?? "auto";
    let shake: ShakeLevel = saved.shake ?? "on";
    let pace: Pace = saved.pace ?? "digest";
    let lka = saved.lka ?? true;
    let pedal: PedalMode = saved.pedal ?? "hold";
    let consent = saved.consent ?? true;
    let tab: "route" | "car" | "env" = "route";
    // 시내 주행 (서울): 도로망은 시내를 고를 때 불러온다
    let mode: "highway" | "city" = saved.city ? "city" : "highway";
    let city: { graph: CityGraph; net: CityNet } | null = null;
    let cityState: "" | "loading" | "error" = "";
    let cityError = "";
    let cFrom: CityPlace | null = null;
    let cTo: CityPlace | null = null;
    let cPlan: CityRoutePlan | null = null;
    const cityByName = (n: string) => (city ? (searchCityPlaces(city.graph.places, n, 5).find((p) => p.name === n) ?? null) : null);

    const root = el("div", "menu2");
    const mapWrap = el("div", "map-wrap");
    root.appendChild(mapWrap);
    const panel = el("section", "panel");
    panel.setAttribute("aria-label", "주행 설정");
    root.appendChild(panel);
    document.body.appendChild(root);

    const map = new NetMap(mapWrap, net, places);
    const zoomBox = el(
      "div",
      "map-zoom",
      `<button data-z="0.7" aria-label="확대" title="확대">${ICON.plus}</button><button data-z="1.4" aria-label="축소" title="축소">${ICON.minus}</button><button data-z="all" aria-label="전국 보기" title="전국 보기">${ICON.fit}</button>`,
    );
    mapWrap.appendChild(zoomBox);
    zoomBox.onclick = (e) => {
      const z = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.z;
      if (z === "all") map.fitAll();
      else if (z) map.zoom(Number(z));
    };
    mapWrap.appendChild(el("div", "map-legend", `<span><i></i>내 경로</span><span><i class="net"></i>고속도로</span><span><i class="jc"></i>분기점</span>`));
    const summary = el("div", "route-card");
    mapWrap.appendChild(summary);

    panel.innerHTML = `
      <header class="mast">
        ${WORDMARK}
        <p class="mast-sub">실제 한국 도로를 달리는 운전 시뮬레이터</p>
        <p class="mast-meta"><span>고속도로 주행선 ${net.roads.length}개</span><span>서울 시내</span><span>배속 없는 실시간</span></p>
      </header>
      <nav class="steps" role="tablist" aria-label="설정 단계">
        <button data-tab="route" role="tab"><b>1</b>경로</button>
        <button data-tab="car" role="tab"><b>2</b>차량</button>
        <button data-tab="env" role="tab"><b>3</b>주행 환경</button>
      </nav>
      <div class="tab-body" role="tabpanel"></div>
      <footer class="panel-foot">
        <button class="btn ghost" data-help>${ICON.keyboard}조작법</button>
        <button class="btn primary go" data-start></button>
      </footer>`;
    const body = panel.querySelector<HTMLDivElement>(".tab-body")!;
    const startBtn = panel.querySelector<HTMLButtonElement>("[data-start]")!;
    panel.querySelector<HTMLButtonElement>("[data-help]")!.onclick = () => showControls();
    panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.tab as typeof tab;
        render();
      };
    });

    let preview: VehiclePreview | null = null;

    function ensureCity() {
      if (city || cityState === "loading") return;
      cityState = "loading";
      loadCity("seoul")
        .then((c) => {
          city = c;
          cityState = "";
          cFrom ??= cityByName(saved.city?.from ?? "강동역");
          cTo ??= cityByName(saved.city?.to ?? "삼원타워");
          map.setCityGraph(c.graph);
          if (mode === "city") {
            computeCity();
            render();
          }
        })
        .catch((e: unknown) => {
          cityState = "error";
          cityError = String((e as Error)?.message ?? e);
          renderSummary();
        });
    }

    function computeCity() {
      cPlan = city && cFrom && cTo && cFrom !== cTo ? findCityRoute(city.net, cFrom, cTo) : null;
      map.setCityRoute(city?.net ?? null, cPlan?.links ?? null, cFrom, cTo);
      renderSummary();
      renderStart();
    }

    function setMode(m: typeof mode) {
      mode = m;
      map.showCity = m === "city";
      if (m === "city") {
        ensureCity();
        if (city) computeCity();
        else {
          map.setCityRoute(null, null);
          renderSummary();
        }
      } else computeRoute();
    }

    function computeRoute() {
      if (mode === "city") return computeCity();
      plan = from && to && from !== to ? findRoute(net, from, to) : null;
      startKm = 0;
      map.setRoute(plan?.legs ?? null, from, to);
      renderSummary();
      renderStart();
    }

    // 왼쪽 패널이 덮지 않는 지도 안에서, 오른쪽 경로 요약 카드를 빼고 경로를 맞춘다
    const pads = () => {
      const wide = innerWidth > 900;
      map.padLeft = 0;
      map.padRight = wide ? Math.min(400, Math.max(0, innerWidth - 440 - 480)) : 0;
      map.padBottom = 0;
    };
    pads();
    addEventListener("resize", pads);
    map.onPick = (p) => {
      if (mode === "city") return;
      // 출발지가 비었거나 둘 다 차 있으면 출발지부터 다시
      if (!from || (from && to)) {
        from = p;
        to = null;
      } else to = p;
      computeRoute();
      tab = "route";
      render();
    };

    function roadOf(id: string) {
      return net.roads.find((r) => r.id === id)!;
    }

    function renderCitySummary() {
      const empty = (msg: string) => {
        summary.innerHTML = `${ICON.info}<p>${msg}</p>`;
        summary.classList.toggle("empty", true);
      };
      if (!city) return empty(cityState === "error" ? `서울 시내 도로망을 불러오지 못했습니다. ${esc(cityError)}` : "서울 시내 도로망을 불러오는 중…");
      if (!cPlan || !cFrom || !cTo) return empty(cFrom && cTo && cFrom === cTo ? "출발지와 도착지가 같습니다." : cFrom && cTo ? "두 곳을 잇는 길을 찾지 못했습니다." : "왼쪽에 역·건물·명소 이름을 넣어 출발지와 도착지를 고르세요.");
      summary.classList.toggle("empty", false);
      const n = city.net;
      // 지나는 길: 이름이 같은 링크를 묶고, 그 길로 들어갈 때 도는 쪽
      const streets: { name: string; m: number; turn: string }[] = [];
      cPlan.links.forEach((id, k) => {
        const l = n.links[id];
        const name = l.name || "이름 없는 길";
        const last = streets[streets.length - 1];
        const mv = k > 0 ? n.movements[cPlan!.movements[k - 1]] : null;
        if (last && last.name === name) last.m += l.length;
        else streets.push({ name, m: l.length, turn: !mv ? "출발" : mv.turn === "L" ? "좌회전" : mv.turn === "R" ? "우회전" : "직진" });
      });
      const items = streets
        .filter((x) => x.m > 60 || x.turn === "출발")
        .map((x) => `<li><span class="turn">${x.turn}</span><div><b>${esc(x.name)}</b></div><span class="len">${(x.m / 1000).toFixed(1)}<small> km</small></span></li>`)
        .join("");
      summary.innerHTML = `
        <div class="rs-head">
          <div class="rs-od"><small>출발</small><b>${esc(cFrom.name)}</b></div>
          ${ICON.arrowRight}
          <div class="rs-od to"><small>도착</small><b>${esc(cTo.name)}</b></div>
        </div>
        <dl class="rs-stats">
          <div><dt>거리</dt><dd>${(cPlan.lengthM / 1000).toFixed(1)}<small>km</small></dd></div>
          <div><dt>예상 시간</dt><dd>${durationHtml(cPlan.timeS)}</dd></div>
          <div><dt>신호 교차로</dt><dd>${cPlan.signals}<small>곳</small></dd></div>
        </dl>
        <ol class="rs-legs">${items}</ol>
        <p class="rs-foot">실제 서울 도로(OpenStreetMap)를 신호 교차로에서 서고 가며 처음부터 끝까지 달립니다. 좌회전·우회전 ${cPlan.turns}번. 도로 데이터 © OpenStreetMap contributors (ODbL).</p>`;
    }

    function renderSummary() {
      if (mode === "city") return renderCitySummary();
      if (!plan || !from || !to) {
        const msg = from && to && from === to ? "출발지와 도착지가 같습니다." : from && to ? "두 곳을 잇는 고속도로 경로를 찾지 못했습니다." : "지도에서 도시·나들목을 눌러 출발지와 도착지를 고르거나, 왼쪽에 이름을 넣으세요.";
        summary.innerHTML = `${ICON.info}<p>${msg}</p>`;
        summary.classList.toggle("empty", true);
        return;
      }
      summary.classList.toggle("empty", false);
      const km = plan.lengthM / 1000;
      // 요약 주행 어림: 달리는 거리 ÷ 경로 평균 속도(제한속도로 쉬지 않고)
      const digest = (() => {
        if (pace !== "digest") return null;
        const wins = digestForLegs(
          plan.legs.map((l) => l.s1 - l.s0),
          startKm * 1000,
        );
        if (wins.length < 2) return null;
        const m = playDistance(wins);
        return { sec: (m / plan.lengthM) * plan.timeS, km: m / 1000, windows: wins.length, samples: wins.filter((w) => w.why === "sample").length };
      })();
      const legs = plan.legs
        .map((l) => {
          const r = roadOf(l.road);
          const len = (l.s1 - l.s0) / 1000;
          return `<li><span class="shield">${esc(r.ref)}</span><div><b>${esc(r.name)}</b><small>${l.via ? `${esc(l.via)} · ` : ""}${esc(r.to)} 방향</small></div><span class="len">${len.toFixed(0)}<small> km</small></span></li>`;
        })
        .join("");
      summary.innerHTML = `
        <div class="rs-head">
          <div class="rs-od"><small>출발</small><b>${esc(from.name)}</b></div>
          ${ICON.arrowRight}
          <div class="rs-od to"><small>도착</small><b>${esc(to.name)}</b></div>
        </div>
        <dl class="rs-stats">
          <div><dt>거리</dt><dd>${km.toFixed(0)}<small>km</small></dd></div>
          <div><dt>제한속도로 쉬지 않고</dt><dd>${durationHtml(plan.timeS)}</dd></div>
          ${digest ? `<div><dt>요약 주행</dt><dd>${durationHtml(digest.sec)}</dd></div>` : `<div><dt>갈아타는 노선</dt><dd>${plan.legs.length}<small>개</small></dd></div>`}
        </dl>
        <ol class="rs-legs">${legs}</ol>
        <p class="rs-foot">${
          digest
            ? `요약 주행: 출발·분기점·도착과 사이 ${digest.samples}구간, 모두 ${digest.windows}구간 ${digest.km.toFixed(0)}km만 달리고 나머지는 건너뜁니다. 달리는 동안은 배속 없이 실제 시간 그대로입니다.`
            : "배속 없이 실제 시간으로 처음부터 끝까지 달립니다."
        } Esc로 언제든 끝낼 수 있고, 달린 만큼 결과가 남습니다.</p>`;
    }

    function renderStart() {
      if (mode === "city") {
        startBtn.disabled = !cPlan;
        startBtn.innerHTML = cPlan && cFrom && cTo ? `<span>주행 시작<span class="go-sub">${esc(cFrom.name)} → ${esc(cTo.name)} · ${(cPlan.lengthM / 1000).toFixed(1)}km</span></span>${ICON.arrowRight}` : "경로를 먼저 고르세요";
        return;
      }
      startBtn.disabled = !plan;
      startBtn.innerHTML = plan && from && to ? `<span>주행 시작<span class="go-sub">${esc(from.name)} → ${esc(to.name)} · ${(plan.lengthM / 1000).toFixed(0)}km</span></span>${ICON.arrowRight}` : "경로를 먼저 고르세요";
    }

    function placeInput(label: string, get: () => Place | null, set: (p: Place | null) => void, cls: string) {
      const wrap = el("div", `place ${cls}`);
      const id = `place-${cls}`;
      wrap.appendChild(el("label", "", label)).setAttribute("for", id);
      const input = el("input");
      input.id = id;
      input.type = "search";
      input.placeholder = "도시·나들목·분기점 (예: 판교IC, 신갈JC)";
      input.value = get()?.name ?? "";
      input.autocomplete = "off";
      input.spellcheck = false;
      const list = el("ul", "suggest");
      list.setAttribute("role", "listbox");
      wrap.append(input, list);
      let items: Place[] = [];
      let active = 0;
      const show = () => {
        items = searchPlaces(places, input.value, 8);
        active = 0;
        list.innerHTML = items
          .map((p, i) => `<li role="option" data-i="${i}" class="${i === active ? "on" : ""}"><b>${esc(p.name)}</b><small>${KIND_LABEL[p.kind]} · ${esc(p.roads.slice(0, 2).join(", "))}</small></li>`)
          .join("");
        list.style.display = items.length ? "" : "none";
      };
      const pick = (p: Place) => {
        set(p);
        input.value = p.name;
        list.style.display = "none";
        computeRoute();
        render();
      };
      input.oninput = show;
      input.onfocus = () => {
        input.select();
        if (input.value) show();
      };
      input.onblur = () => setTimeout(() => (list.style.display = "none"), 150);
      input.onkeydown = (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(1, items.length);
          list.querySelectorAll("li").forEach((li, i) => li.classList.toggle("on", i === active));
        } else if (e.key === "Enter" && items[active]) {
          e.preventDefault();
          pick(items[active]);
        } else if (e.key === "Escape") list.style.display = "none";
      };
      list.onmousedown = (e) => {
        const li = (e.target as HTMLElement).closest("li");
        if (li) pick(items[Number(li.dataset.i)]);
      };
      list.style.display = "none";
      return wrap;
    }

    /** 시내 장소 (역·건물·명소) 찾기 */
    function cityPlaceInput(label: string, get: () => CityPlace | null, set: (p: CityPlace) => void, cls: string) {
      const wrap = el("div", `place ${cls}`);
      const id = `cplace-${cls}`;
      wrap.appendChild(el("label", "", label)).setAttribute("for", id);
      const input = el("input");
      input.id = id;
      input.type = "search";
      input.placeholder = city ? "역·건물·명소 (예: 강남역, 롯데월드타워)" : "도로망을 불러오는 중…";
      input.disabled = !city;
      input.value = get()?.name ?? "";
      input.autocomplete = "off";
      input.spellcheck = false;
      const list = el("ul", "suggest");
      list.setAttribute("role", "listbox");
      wrap.append(input, list);
      let items: CityPlace[] = [];
      let active = 0;
      const show = () => {
        items = city ? searchCityPlaces(city.graph.places, input.value, 8) : [];
        active = 0;
        list.innerHTML = items.map((p, i) => `<li role="option" data-i="${i}" class="${i === active ? "on" : ""}"><b>${esc(p.name)}</b><small>${CITY_KIND[p.kind] ?? p.kind}</small></li>`).join("");
        list.style.display = items.length ? "" : "none";
      };
      const pick = (p: CityPlace) => {
        set(p);
        input.value = p.name;
        list.style.display = "none";
        computeCity();
        render();
      };
      input.oninput = show;
      input.onfocus = () => {
        input.select();
        if (input.value) show();
      };
      input.onblur = () => setTimeout(() => (list.style.display = "none"), 150);
      input.onkeydown = (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(1, items.length);
          list.querySelectorAll("li").forEach((li, i) => li.classList.toggle("on", i === active));
        } else if (e.key === "Enter" && items[active]) {
          e.preventDefault();
          pick(items[active]);
        } else if (e.key === "Escape") list.style.display = "none";
      };
      list.onmousedown = (e) => {
        const li = (e.target as HTMLElement).closest("li");
        if (li) pick(items[Number(li.dataset.i)]);
      };
      list.style.display = "none";
      return wrap;
    }

    function renderCityRoute() {
      const box = el("div", "od");
      box.appendChild(cityPlaceInput("출발", () => cFrom, (p) => (cFrom = p), "from"));
      const swap = el("button", "swap", ICON.swap);
      swap.title = "출발·도착 바꾸기";
      swap.setAttribute("aria-label", "출발지와 도착지 바꾸기");
      swap.onclick = () => {
        [cFrom, cTo] = [cTo, cFrom];
        computeCity();
        render();
      };
      box.appendChild(swap);
      box.appendChild(cityPlaceInput("도착", () => cTo, (p) => (cTo = p), "to"));
      body.appendChild(box);
      if (city) {
        const chips = el("div", "chips");
        for (const [a, b] of CITY_POPULAR) {
          const pa = cityByName(a);
          const pb = cityByName(b);
          if (!pa || !pb) continue;
          const c = el("button", pa === cFrom && pb === cTo ? "on" : "", `${a} → ${b}`);
          c.onclick = () => {
            cFrom = pa;
            cTo = pb;
            computeCity();
            render();
          };
          chips.appendChild(c);
        }
        body.appendChild(field("자주 달리는 길", chips));
      }
      body.appendChild(
        el(
          "p",
          "note",
          "서울 시내 큰길(간선·보조간선도로)로 길을 찾습니다. 교차로마다 실제처럼 신호가 바뀌고(직진 → 좌회전 순서), 도는 곳은 내비가 300m 앞에서 알려 줍니다. 버스전용차로·보행자는 아직 없습니다.",
        ),
      );
    }

    /** 붙은 버튼 묶음 (선택지가 적을 때) */
    function seg<T extends string | number>(options: [T, string][], value: T, onPick: (v: T) => void, label = "") {
      const wrap = el("div", "seg");
      wrap.setAttribute("role", "radiogroup");
      if (label) wrap.setAttribute("aria-label", label);
      for (const [v, text] of options) {
        const b = el("button", v === value ? "on" : "", text);
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(v === value));
        b.onclick = () => {
          onPick(v);
          render();
        };
        wrap.appendChild(b);
      }
      return wrap;
    }

    /** 칸 격자 (아이콘·이름·설명, 선택지가 많을 때) */
    function opts<T extends string>(options: [T, string, string, string][], value: T, onPick: (v: T) => void, wide = false) {
      const wrap = el("div", `opts${wide ? " wide" : ""}`);
      wrap.setAttribute("role", "radiogroup");
      for (const [v, name, sub, icon] of options) {
        const b = el("button", v === value ? "on" : "", `${icon}<span>${name}</span>${sub ? `<small>${sub}</small>` : ""}`);
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(v === value));
        b.onclick = () => {
          onPick(v);
          render();
        };
        wrap.appendChild(b);
      }
      return wrap;
    }

    function field(label: string, content: HTMLElement, note = "", aside = "") {
      const f = el("div", "field");
      f.appendChild(el("div", "field-label", `<span>${label}</span>${aside ? `<span>${aside}</span>` : ""}`));
      f.appendChild(content);
      if (note) f.appendChild(el("p", "note", note));
      return f;
    }

    /** 밀대: 채운 부분을 색으로 */
    function slider(min: number, max: number, value: number, onInput: (v: number) => void) {
      const range = el("input");
      range.type = "range";
      range.min = String(min);
      range.max = String(max);
      range.step = "1";
      range.value = String(value);
      const fill = () => range.style.setProperty("--fill", `${((Number(range.value) - min) / Math.max(1, max - min)) * 100}%`);
      fill();
      range.oninput = () => {
        fill();
        onInput(Number(range.value));
      };
      return range;
    }

    /** 경로 위 km → 가까운 나들목 이름 */
    function placeAtKm(km: number): string {
      if (!plan) return "";
      let acc = 0;
      for (const l of plan.legs) {
        const len = (l.s1 - l.s0) / 1000;
        if (km <= acc + len) {
          const s = l.s0 + (km - acc) * 1000;
          const r = roadOf(l.road);
          let best = "";
          let bd = Infinity;
          for (const [js, name, kind] of r.j) {
            if (kind === "기타" || kind === "SA") continue;
            const d = Math.abs(js - s);
            if (d < bd) {
              bd = d;
              best = name;
            }
          }
          return `${r.name}${best ? ` · ${best} 부근` : ""}`;
        }
        acc += len + 0.9;
      }
      return "";
    }

    function renderRoute() {
      body.appendChild(el("h3", "", "어디로 달릴까요?"));
      body.appendChild(
        field(
          "도로",
          seg<typeof mode>(
            [
              ["highway", "고속도로 (전국)"],
              ["city", "시내 (서울)"],
            ],
            mode,
            (v) => setMode(v),
            "도로 종류",
          ),
        ),
      );
      if (mode === "city") return renderCityRoute();
      const box = el("div", "od");
      box.appendChild(placeInput("출발", () => from, (p) => (from = p), "from"));
      const swap = el("button", "swap", ICON.swap);
      swap.title = "출발·도착 바꾸기";
      swap.setAttribute("aria-label", "출발지와 도착지 바꾸기");
      swap.onclick = () => {
        [from, to] = [to, from];
        computeRoute();
        render();
      };
      box.appendChild(swap);
      box.appendChild(placeInput("도착", () => to, (p) => (to = p), "to"));
      body.appendChild(box);

      const chips = el("div", "chips");
      for (const [a, b] of POPULAR) {
        const pa = byName(a);
        const pb = byName(b);
        if (!pa || !pb) continue;
        const c = el("button", pa === from && pb === to ? "on" : "", `${a} → ${b}`);
        c.onclick = () => {
          from = pa;
          to = pb;
          computeRoute();
          render();
        };
        chips.appendChild(c);
      }
      body.appendChild(field("자주 달리는 길", chips));

      if (plan) {
        const lenKm = Math.floor(plan.lengthM / 1000);
        const max = Math.max(0, lenKm - 2);
        const km = el("div", "km");
        const out = el("output");
        const label = () => {
          out.innerHTML = startKm === 0 ? `<b>0<small> km</small></b><span>처음부터 · ${esc(from!.name)}</span>` : `<b>${startKm}<small> km</small></b><span>${esc(placeAtKm(startKm))}</span>`;
        };
        label();
        km.append(
          out,
          slider(0, max, startKm, (v) => {
            startKm = v;
            label();
            renderSummary();
          }),
          el("div", "range-scale", `<span>0</span><span>${Math.round(max / 2)}</span><span>${max} km</span>`),
        );
        body.appendChild(field("출발 위치", km, "긴 경로는 중간부터 시작할 수 있습니다. 도착지는 그대로입니다."));
        body.appendChild(
          field(
            "주행 방식",
            seg<Pace>(
              [
                ["digest", "요약 (1시간 → 5분)"],
                ["full", "처음부터 끝까지"],
              ],
              pace,
              (v) => {
                pace = v;
                renderSummary();
              },
              "주행 방식",
            ),
            "요약: 출발, 노선을 갈아타는 분기점, 도착과 사이 몇 구간만 달리고 나머지는 건너뜁니다. 달리는 동안은 배속이 없고, 게임 속 시계는 건너뛴 만큼 흐릅니다.",
          ),
        );
      }
      body.appendChild(el("p", "note", "지도는 끌어서 옮기고 휠로 확대합니다. 도시·나들목을 누르면 출발지, 한 번 더 누르면 도착지가 됩니다."));
    }

    function renderCar() {
      body.appendChild(el("h3", "", "무엇을 운전할까요?"));
      const stage = el("div", "stage");
      body.appendChild(stage);
      if (!preview) preview = new VehiclePreview(stage);
      else stage.appendChild(preview.canvas);
      const spec = specFor(vehicle);
      const info = el("div", "car-info");
      const notes: string[] = [];
      if (spec.vehicleClass === "truck") notes.push("화물차 제한속도와 지정차로(오른쪽 차로)를 따릅니다");
      if (spec.vehicleClass === "bus") notes.push("버스전용차로를 달릴 수 있습니다");
      if (Number.isFinite(spec.governor) && spec.governor * 3.6 < vehicle.maxSpeed) notes.push(`속도제한장치 ${Math.round(spec.governor * 3.6)}km/h`);
      const drive = { gasoline: "가솔린", diesel_light: "디젤", diesel_heavy: "대형 디젤", electric: "전기" }[spec.powertrain];
      info.innerHTML = `<b>${esc(vehicle.name)}</b>
        <dl class="specs">
          <div><dt>길이</dt><dd>${vehicle.length.toFixed(1)}<small>m</small></dd></div>
          <div><dt>무게</dt><dd>${(spec.mass / 1000).toFixed(1)}<small>t</small></dd></div>
          <div><dt>동력</dt><dd class="txt">${drive}</dd></div>
          <div><dt>최고 속도</dt><dd>${Math.round(Math.min(vehicle.maxSpeed, spec.governor * 3.6))}<small>km/h</small></dd></div>
        </dl>
        ${notes.length ? `<p class="rule-note">${ICON.info}<span>${notes.join(" · ")}</span></p>` : ""}`;
      body.appendChild(info);
      const swatches = el("div", "swatches");
      for (const c of [...new Set(paletteFor(vehicle, catalog))]) {
        const b = el("button", c === color ? "on" : "");
        b.style.background = c;
        b.title = c;
        b.setAttribute("aria-label", `색 ${c}`);
        b.onclick = () => {
          color = c;
          render();
        };
        swatches.appendChild(b);
      }
      body.appendChild(field("색", swatches));
      const cats = seg<string>(
        CATEGORY_ORDER.map((c) => [c, `${c}<small>${types.filter((t) => t.category === c).length}</small>`]),
        category,
        (v) => (category = v),
        "차종 분류",
      );
      cats.classList.add("cats");
      const list = el("div", "car-list");
      for (const t of types.filter((x) => x.category === category)) {
        const b = el("button", t === vehicle ? "on" : "", `<span>${esc(t.name)}</span><small>${t.length.toFixed(1)} m</small>`);
        b.onclick = () => {
          vehicle = t;
          const pal = paletteFor(t, catalog);
          if (!pal.includes(color)) color = pal[0];
          render();
        };
        list.appendChild(b);
      }
      const f = field(`차종`, cats, "", `${catalog.types.length}종`);
      f.appendChild(list);
      body.appendChild(f);
      body.appendChild(
        field(
          "차로 유지 보조",
          seg<string>(
            [
              ["on", "켜기"],
              ["off", "끄기"],
            ],
            lka ? "on" : "off",
            (v) => (lka = v === "on"),
            "차로 유지 보조",
          ),
          "시속 60km 넘게 달릴 때 방향지시등 없이 차선을 넘으려 하면 경고하고 운전대를 살짝 돌려 줍니다. 주행 중 L 키로 켜고 끕니다.",
        ),
      );
      body.appendChild(
        field(
          "키보드 가속 페달",
          seg<PedalMode>(
            [
              ["hold", "누른 만큼 유지"],
              ["momentary", "누르는 동안만"],
            ],
            pedal,
            (v) => (pedal = v),
            "키보드 가속 페달",
          ),
          "누른 만큼 유지: ↑를 누르는 동안 페달이 깊어지고, 떼면 그 깊이로 계속 밟고 달립니다 (속도·rpm이 그 자리에서 유지). ↓는 먼저 발을 떼고, 더 누르면 브레이크입니다.",
        ),
      );
      preview.show(vehicle, color);
    }

    function renderEnv() {
      body.appendChild(el("h3", "", "언제, 어떤 길을 달릴까요?"));
      const time = el("div", "km");
      const out = el("output");
      const label = () => (out.innerHTML = `<b>${String(hour).padStart(2, "0")}:00</b><span>${hourPart(hour)}${hour >= 19 || hour < 5 ? " · 전조등을 켭니다" : ""}</span>`);
      label();
      time.append(
        out,
        slider(0, 23, hour, (v) => {
          hour = v;
          label();
        }),
        el("div", "range-scale", "<span>0시</span><span>6</span><span>12</span><span>18</span><span>23시</span>"),
      );
      body.appendChild(field("출발 시각", time, "해 높이와 밝기, 버스전용차로 운영, 시간대별 교통량이 바뀝니다. 19시부터 5시까지는 밤입니다."));
      body.appendChild(field("요일", seg<string>([["weekday", "평일"], ["weekend", "주말·공휴일"]], weekend ? "weekend" : "weekday", (v) => (weekend = v === "weekend"), "요일")));
      const wOpts = [...WEATHER_OPTS];
      if (realWeather) wOpts.push(["real", "실제 날씨", `${realWeather.date.slice(4, 6)}/${realWeather.date.slice(6)} 같은 시각`, ICON.real]);
      body.appendChild(
        field(
          "날씨",
          opts<WeatherChoice>(wOpts, weather, (v) => (weather = v)),
          "비·눈으로 노면이 젖으면 제한속도의 20%, 폭우·폭설·안개로 앞이 100m도 안 보이면 50%를 줄여야 합니다(도로교통법 시행규칙 제19조). 젖은 노면은 제동거리가 약 1.8배입니다.",
        ),
      );
      const presets: [Preset, string, string, string][] = [
        ["자동", "시간대 반영", "요일·시각별 평균", ICON.real],
        ["한산", "한산", "", density(1)],
        ["보통", "보통", "", density(2)],
        ["혼잡", "혼잡", "", density(3)],
        ["정체", "정체", "", density(4)],
      ];
      const startRoad = plan?.legs[0]?.road;
      if (startRoad && real?.roads[startRoad]?.density) presets.push(["실제", "어제 실제 교통", `${real.date.slice(5).replace("-", "/")} 도로공사 측정`, ICON.map]);
      else if (preset === "실제") preset = "자동";
      body.appendChild(field("교통량", opts(presets, preset, (v) => (preset = v), true), "실제 교통은 한국도로공사 측정 지점이 있는 노선에서 전날 같은 시각의 교통량과 속도를 씁니다."));
      body.appendChild(field("시점", seg<CameraMode>([["cockpit", "운전석"], ["hood", "보닛"], ["chase", "차 뒤"]], camera, (v) => (camera = v), "시점"), "주행 중 C 키로 바꿀 수 있습니다."));
      body.appendChild(
        field("화면 흔들림", seg<ShakeLevel>([["on", "켜기"], ["low", "약하게"], ["off", "끄기"]], shake, (v) => (shake = v), "화면 흔들림"), "노면 요철·신축이음·충돌 때 화면이 흔들리는 정도. 멀미가 나면 줄이세요."),
      );
      body.appendChild(field("그래픽", seg<Quality>([["auto", "자동"], ["low", "낮음"], ["medium", "보통"], ["high", "높음"], ["ultra", "최고"]], quality, (v) => (quality = v), "그래픽 품질"), "자동: 기기 성능을 재서 고르고, 주행 중 끊기면 낮춥니다."));
      body.appendChild(field("소리", seg<string>([["on", "켜기"], ["off", "끄기"]], sound ? "on" : "off", (v) => (sound = v === "on"), "소리")));
      body.appendChild(
        field(
          "음성 안내",
          seg<string>([["on", "켜기"], ["off", "끄기"]], voice ? "on" : "off", (v) => (voice = v === "on"), "음성 안내"),
          "분기점(2km·1km 앞과 직전), 제한속도 변경, 과속 단속 카메라와 구간단속을 말로 알려 줍니다. 브라우저에 한국어 음성이 있어야 합니다.",
        ),
      );
      const consentBox = el("label", "consent");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = consent;
      cb.onchange = () => (consent = cb.checked);
      consentBox.append(
        cb,
        el(
          "span",
          "",
          "익명 주행 기록(위치·속도·조작·법규 판정)을 연구용 공개 데이터셋에 쓰는 데 동의합니다. 이름·연락처는 모으지 않습니다. 동의하지 않으면 기록은 이 브라우저에만 남습니다." +
            (COLLECTING ? "" : " <b>지금은 시험 운영 기간이라 동의해도 서버에 올리지 않습니다.</b>"),
        ),
      );
      body.appendChild(consentBox);
      body.appendChild(el("details", "keys-inline", `<summary>${ICON.keyboard}조작법</summary>${controlsHtml()}`));
      body.appendChild(el("div", "links", `<a href="./garage.html">차량 도감 ${catalog.types.length}종${ICON.external}</a><a href="../">DRIP 소개${ICON.external}</a>`));
    }

    function render() {
      panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
        b.classList.toggle("on", b.dataset.tab === tab);
        b.setAttribute("aria-selected", String(b.dataset.tab === tab));
      });
      body.innerHTML = "";
      body.scrollTop = 0;
      root.dataset.tab = tab;
      if (tab === "route") renderRoute();
      else if (tab === "car") renderCar();
      else renderEnv();
      renderStart();
    }

    startBtn.onclick = () => {
      const cityPick = mode === "city" && cPlan && cFrom && cTo ? { region: "seoul", from: cFrom.name, to: cTo.name } : null;
      if (!cityPick && (mode === "city" || !plan || !from || !to)) return;
      const route: RouteChoice = cityPick
        ? { from: cityPick.from, to: cityPick.to, legs: [], lengthM: cPlan!.lengthM, timeS: cPlan!.timeS }
        : { from: from!.name, to: to!.name, legs: plan!.legs, lengthM: plan!.lengthM, timeS: plan!.timeS };
      const s: DriveSettings = {
        route,
        startKm: cityPick ? 0 : startKm,
        vehicle: vehicle.id,
        color,
        preset,
        hour,
        weekend,
        weather,
        camera,
        consent,
        sound,
        voice,
        quality,
        shake,
        pace,
        lka,
        pedal,
        city: cityPick,
        seed: Math.floor(Math.random() * 2 ** 31),
      };
      save(s);
      preview?.dispose();
      map.dispose();
      root.remove();
      resolve(s);
    };

    map.showCity = mode === "city";
    if (mode === "city") setMode("city");
    else computeRoute();
    render();
  });
}
