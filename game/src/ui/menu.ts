// 시작 메뉴: 출발지·도착지를 넣어 경로를 찾고(전국 고속도로망 지도), 차량과 주행 환경을 고른다.

import type { Network, Place, Leg } from "../road/route";
import { buildPlaces, findRoute, searchPlaces } from "../road/route";
import type { RealTraffic } from "../sim/config";
import { specFor } from "../sim/vehicleSpec";
import { paletteFor, type VehicleCatalog, type VehicleType } from "../render/vehicleModels";
import { NetMap } from "./netMap";
import { VehiclePreview } from "./vehiclePreview";
import { controlsHtml, showControls } from "./help";

export type Preset = "자동" | "한산" | "보통" | "혼잡" | "정체" | "실제";
export type CameraMode = "cockpit" | "chase" | "hood";
export type Quality = "low" | "medium" | "high";

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
  camera: CameraMode;
  consent: boolean;
  sound: boolean;
  /** 내비 음성 안내 */
  voice: boolean;
  quality: Quality;
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

function hourLabel(h: number): string {
  const part = h < 5 ? "새벽" : h < 7 ? "이른 아침" : h < 10 ? "아침" : h < 16 ? "낮" : h < 19 ? "저녁" : "밤";
  return `${part} ${h}시`;
}

const KIND_LABEL: Record<Place["kind"], string> = { 도시: "도시", IC: "나들목", JC: "분기점", TG: "요금소", SA: "휴게소", 기타: "" };

export function showMenu(net: Network, catalog: VehicleCatalog, real: RealTraffic | null): Promise<DriveSettings> {
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
    let camera: CameraMode = saved.camera ?? "cockpit";
    let sound = saved.sound ?? true;
    let voice = saved.voice ?? true;
    let quality: Quality = saved.quality ?? (matchMedia("(pointer: coarse)").matches ? "low" : "high");
    let consent = saved.consent ?? true;
    let tab: "route" | "car" | "env" = "route";

    const root = el("div", "menu2");
    const mapWrap = el("div", "map-wrap");
    root.appendChild(mapWrap);
    const panel = el("section", "panel");
    root.appendChild(panel);
    document.body.appendChild(root);

    const map = new NetMap(mapWrap, net, places);
    const zoomBox = el("div", "map-zoom", `<button data-z="0.7">+</button><button data-z="1.4">−</button><button data-z="all" title="전국">⤢</button>`);
    mapWrap.appendChild(zoomBox);
    zoomBox.onclick = (e) => {
      const z = (e.target as HTMLElement).dataset.z;
      if (z === "all") map.fitAll();
      else if (z) map.zoom(Number(z));
    };
    const summary = el("div", "route-card");
    mapWrap.appendChild(summary);

    panel.innerHTML = `
      <header class="brand2">
        <div class="logo">DRIP</div>
        <div><b>한국 고속도로 드라이빙</b><small>전국 ${net.roads.length}개 주행선 · 실제 도로 모양 · 실시간 주행</small></div>
      </header>
      <nav class="tabs">
        <button data-tab="route"><i>1</i>경로</button>
        <button data-tab="car"><i>2</i>차량</button>
        <button data-tab="env"><i>3</i>주행 환경</button>
      </nav>
      <div class="tab-body"></div>
      <footer class="panel-foot">
        <button class="btn ghost" data-help>조작법</button>
        <button class="btn go" data-start>주행 시작 <span>▶</span></button>
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

    function computeRoute() {
      plan = from && to && from !== to ? findRoute(net, from, to) : null;
      startKm = 0;
      map.setRoute(plan?.legs ?? null, from, to);
      renderSummary();
      startBtn.disabled = !plan;
    }

    // 왼쪽 패널과 오른쪽 경로 카드가 덮는 부분을 빼고 경로를 맞춘다
    const pads = () => {
      const wide = innerWidth > 900;
      map.padLeft = wide ? 476 : 0;
      map.padRight = wide ? Math.min(420, Math.max(0, innerWidth - 476 - 520)) : 0;
      map.padBottom = wide ? 0 : 0;
    };
    pads();
    addEventListener("resize", pads);
    map.onPick = (p) => {
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

    function renderSummary() {
      if (!plan || !from || !to) {
        summary.innerHTML = from && to && from === to ? `<p class="muted">출발지와 도착지가 같습니다.</p>` : from && to ? `<p class="muted">이어지는 고속도로 경로를 찾지 못했습니다.</p>` : `<p class="muted">지도에서 출발지와 도착지를 누르거나, 왼쪽에 이름을 넣으세요.</p>`;
        summary.classList.toggle("empty", true);
        return;
      }
      summary.classList.toggle("empty", false);
      const km = plan.lengthM / 1000;
      const steps = plan.legs
        .map((l) => {
          const r = roadOf(l.road);
          const len = (l.s1 - l.s0) / 1000;
          return `<li><span class="shield">${esc(r.ref)}</span><div><b>${esc(r.name)}</b><small>${l.via ? `${esc(l.via)}에서 · ` : ""}${esc(r.to)} 방향 · ${len.toFixed(0)}km</small></div></li>`;
        })
        .join("");
      summary.innerHTML = `
        <div class="rc-head">
          <div><small>출발</small><b>${esc(from.name)}</b></div><span class="arrow">→</span><div><small>도착</small><b>${esc(to.name)}</b></div>
        </div>
        <div class="rc-stats"><div><b>${km.toFixed(0)}</b><small>km</small></div><div><b>${fmtDuration(plan.timeS)}</b><small>제한속도로 쉬지 않고</small></div><div><b>${plan.legs.length}</b><small>개 노선</small></div></div>
        <ol class="rc-steps">${steps}</ol>
        <p class="muted">배속 없이 실제 시간으로 달립니다. 언제든 Esc로 끝낼 수 있고, 달린 만큼 결과가 남습니다.</p>`;
    }

    function placeInput(label: string, get: () => Place | null, set: (p: Place | null) => void, cls: string) {
      const wrap = el("div", `place ${cls}`);
      wrap.appendChild(el("label", "", label));
      const input = el("input");
      input.type = "search";
      input.placeholder = "도시·나들목·분기점 (예: 서울, 판교IC, 신갈JC)";
      input.value = get()?.name ?? "";
      input.autocomplete = "off";
      const list = el("ul", "suggest");
      wrap.append(input, list);
      let items: Place[] = [];
      let active = 0;
      const show = () => {
        items = searchPlaces(places, input.value, 8);
        active = 0;
        list.innerHTML = items
          .map((p, i) => `<li data-i="${i}" class="${i === active ? "on" : ""}"><b>${esc(p.name)}</b><small>${KIND_LABEL[p.kind]} · ${esc(p.roads.slice(0, 3).join(", "))}</small></li>`)
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
        }
      };
      list.onmousedown = (e) => {
        const li = (e.target as HTMLElement).closest("li");
        if (li) pick(items[Number(li.dataset.i)]);
      };
      list.style.display = "none";
      return wrap;
    }

    function seg<T extends string | number>(options: [T, string][], value: T, onPick: (v: T) => void) {
      const wrap = el("div", "seg");
      for (const [v, label] of options) {
        const b = el("button", v === value ? "on" : "", label);
        b.onclick = () => {
          onPick(v);
          render();
        };
        wrap.appendChild(b);
      }
      return wrap;
    }

    function field(label: string, content: HTMLElement, note = "") {
      const f = el("div", "field");
      f.appendChild(el("label", "", label));
      f.appendChild(content);
      if (note) f.appendChild(el("p", "note", note));
      return f;
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
      const box = el("div", "od");
      box.appendChild(placeInput("출발", () => from, (p) => (from = p), "from"));
      const swap = el("button", "swap", "⇅");
      swap.title = "출발·도착 바꾸기";
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
        const km = el("div", "km");
        const range = el("input");
        range.type = "range";
        range.min = "0";
        range.max = String(Math.max(0, lenKm - 2));
        range.step = "1";
        range.value = String(startKm);
        const out = el("output");
        const label = () => (startKm === 0 ? `처음부터 · ${esc(from!.name)}` : `${startKm}km 지점 · ${esc(placeAtKm(startKm))}`);
        out.innerHTML = label();
        range.oninput = () => {
          startKm = Number(range.value);
          out.innerHTML = label();
        };
        km.append(range, out);
        body.appendChild(field("출발 위치", km, "긴 경로는 중간부터 시작할 수 있습니다. 도착지는 그대로입니다."));
      }
      body.appendChild(el("p", "note", "지도를 끌어 옮기고, 휠로 확대하고, 도시·나들목을 눌러 출발지와 도착지를 고를 수 있습니다."));
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
      if (spec.vehicleClass === "truck") notes.push("화물차: 제한속도(화물)·지정차로(오른쪽 차로)를 따릅니다");
      if (spec.vehicleClass === "bus") notes.push("버스: 버스전용차로를 달릴 수 있습니다");
      if (Number.isFinite(spec.governor) && spec.governor * 3.6 < vehicle.maxSpeed) notes.push(`속도제한장치 ${Math.round(spec.governor * 3.6)}km/h`);
      const drive = { gasoline: "가솔린", diesel_light: "디젤", diesel_heavy: "대형 디젤", electric: "전기" }[spec.powertrain];
      info.innerHTML = `<b>${esc(vehicle.name)}</b>
        <div class="specs"><span>${vehicle.length.toFixed(1)}m</span><span>${(spec.mass / 1000).toFixed(1)}t</span><span>${drive}</span><span>최고 ${Math.round(Math.min(vehicle.maxSpeed, spec.governor * 3.6))}km/h</span></div>
        ${notes.length ? `<small>${notes.join(" · ")}</small>` : ""}`;
      body.appendChild(info);
      const swatches = el("div", "swatches");
      for (const c of [...new Set(paletteFor(vehicle, catalog))]) {
        const b = el("button", c === color ? "on" : "");
        b.style.background = c;
        b.title = c;
        b.onclick = () => {
          color = c;
          render();
        };
        swatches.appendChild(b);
      }
      body.appendChild(field("색", swatches));
      const cats = el("div", "seg cats");
      for (const c of CATEGORY_ORDER) {
        const b = el("button", c === category ? "on" : "", `${c}<small>${types.filter((t) => t.category === c).length}</small>`);
        b.onclick = () => {
          category = c;
          render();
        };
        cats.appendChild(b);
      }
      body.appendChild(cats);
      const list = el("div", "car-list");
      for (const t of types.filter((x) => x.category === category)) {
        const b = el("button", t === vehicle ? "on" : "", `<span>${esc(t.name)}</span><small>${t.length.toFixed(1)}m</small>`);
        b.onclick = () => {
          vehicle = t;
          const pal = paletteFor(t, catalog);
          if (!pal.includes(color)) color = pal[0];
          render();
        };
        list.appendChild(b);
      }
      body.appendChild(list);
      preview.show(vehicle, color);
    }

    function renderEnv() {
      body.appendChild(el("h3", "", "언제, 어떤 길을 달릴까요?"));
      const time = el("div", "km");
      const range = el("input");
      range.type = "range";
      range.min = "0";
      range.max = "23";
      range.value = String(hour);
      const out = el("output");
      out.textContent = hourLabel(hour);
      range.oninput = () => {
        hour = Number(range.value);
        out.textContent = hourLabel(hour);
      };
      time.append(range, out);
      body.appendChild(field("시각", time, "해 높이·밝기, 버스전용차로 운영, 시간대별 교통량이 바뀝니다. 19시~5시는 밤입니다."));
      body.appendChild(field("요일", seg<string>([["weekday", "평일"], ["weekend", "주말·공휴일"]], weekend ? "weekend" : "weekday", (v) => (weekend = v === "weekend"))));
      const presets: [Preset, string][] = [
        ["자동", "시간대 반영"],
        ["한산", "한산"],
        ["보통", "보통"],
        ["혼잡", "혼잡"],
        ["정체", "정체"],
      ];
      const startRoad = plan?.legs[0]?.road;
      if (startRoad && real?.roads[startRoad]?.density) presets.push(["실제", `어제 실제 교통 (${real.date.slice(5).replace("-", "/")})`]);
      else if (preset === "실제") preset = "자동";
      body.appendChild(field("교통량", seg(presets, preset, (v) => (preset = v)), "실제 교통은 한국도로공사 측정 지점이 있는 노선에서 전날 같은 시각의 교통량·속도를 씁니다."));
      body.appendChild(field("시점", seg<CameraMode>([["cockpit", "운전석"], ["hood", "보닛"], ["chase", "차 뒤"]], camera, (v) => (camera = v))));
      body.appendChild(field("그래픽", seg<Quality>([["low", "낮음"], ["medium", "보통"], ["high", "높음"]], quality, (v) => (quality = v)), "끊기면 낮춰 보세요."));
      body.appendChild(field("소리", seg<string>([["on", "켜기"], ["off", "끄기"]], sound ? "on" : "off", (v) => (sound = v === "on"))));
      body.appendChild(
        field(
          "음성 안내",
          seg<string>([["on", "켜기"], ["off", "끄기"]], voice ? "on" : "off", (v) => (voice = v === "on")),
          "분기점(2km·1km 앞과 직전), 제한속도 변경, 과속 단속 카메라와 구간단속을 말로 알려 줍니다. 브라우저에 한국어 음성이 있어야 합니다.",
        ),
      );
      const consentBox = el("label", "consent");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = consent;
      cb.onchange = () => (consent = cb.checked);
      consentBox.append(cb, el("span", "", "익명 주행 기록(위치·속도·조작·법규 판정)을 연구용 공개 데이터셋에 쓰는 데 동의합니다. 이름·연락처는 모으지 않습니다. 동의하지 않으면 기록은 이 브라우저에만 남습니다."));
      body.appendChild(consentBox);
      body.appendChild(el("details", "keys-inline", `<summary>조작법</summary>${controlsHtml()}`));
      body.appendChild(el("div", "links", `<a href="./garage.html">차량 도감 (${catalog.types.length}종)</a><a href="../">DRIP 소개</a>`));
    }

    function render() {
      panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
      // 입력칸에 글을 쓰는 중이면 다시 그리지 않는다
      body.innerHTML = "";
      root.dataset.tab = tab;
      if (tab === "route") renderRoute();
      else if (tab === "car") renderCar();
      else renderEnv();
      startBtn.disabled = !plan;
      startBtn.innerHTML = plan ? `주행 시작 <span>▶</span>` : "경로를 먼저 고르세요";
    }

    startBtn.onclick = () => {
      if (!plan || !from || !to) return;
      const s: DriveSettings = {
        route: { from: from.name, to: to.name, legs: plan.legs, lengthM: plan.lengthM, timeS: plan.timeS },
        startKm,
        vehicle: vehicle.id,
        color,
        preset,
        hour,
        weekend,
        camera,
        consent,
        sound,
        voice,
        quality,
        seed: Math.floor(Math.random() * 2 ** 31),
      };
      save(s);
      preview?.dispose();
      map.dispose();
      root.remove();
      resolve(s);
    };

    computeRoute();
    render();
  });
}
