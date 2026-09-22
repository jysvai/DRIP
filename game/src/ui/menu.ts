// 시작 메뉴: 전국 고속도로 주행선 고르기, 출발 위치·교통·시간대·시점, 연구 참여 동의.

import type { RoadIndex, RoadIndexEntry } from "../road/road";
import type { RealTraffic } from "../sim/config";

export type Preset = "자동" | "한산" | "보통" | "혼잡" | "정체" | "실제";
export type CameraMode = "cockpit" | "chase" | "hood";

export interface DriveSettings {
  road: RoadIndexEntry;
  startKm: number;
  preset: Preset;
  hour: number;
  weekend: boolean;
  camera: CameraMode;
  consent: boolean;
  sound: boolean;
  seed: number;
}

const STORE = "drip_settings";

function load(): Partial<DriveSettings> & { roadId?: string } {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}");
  } catch {
    return {};
  }
}

function save(s: DriveSettings) {
  try {
    const { road, ...rest } = s;
    localStorage.setItem(STORE, JSON.stringify({ ...rest, roadId: road.id }));
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

export function showMenu(index: RoadIndex, real: RealTraffic | null, carTypes: number): Promise<DriveSettings> {
  return new Promise((resolve) => {
    const saved = load();
    const now = new Date();
    const day = now.getDay();
    let road = index.roads.find((r) => r.id === saved.roadId) ?? index.roads.find((r) => r.id === "r1-1") ?? index.roads[0];
    let startKm = saved.startKm !== undefined && saved.roadId === road.id ? Math.min(saved.startKm, road.lengthKm - 1) : Math.min(20, road.lengthKm / 3);
    let preset: Preset = saved.preset ?? "자동";
    let hour = now.getHours();
    let weekend = day === 0 || day === 6;
    let camera: CameraMode = saved.camera ?? "cockpit";
    let sound = saved.sound ?? true;
    let consent = saved.consent ?? true;

    const root = el("div", "menu");
    const routes = el("section", "routes");
    routes.innerHTML = `
      <div class="brand"><h1><span>DRIP</span> 한국 고속도로</h1>
      <p>전국 고속도로 ${index.roads.length}개 주행선 · ${Math.round(index.roads.reduce((a, r) => a + r.lengthKm, 0)).toLocaleString()}km</p></div>`;
    const search = el("input");
    search.type = "search";
    search.placeholder = "노선 이름이나 번호 (예: 경부, 50, 서해안)";
    const list = el("div", "list");
    routes.append(search, list);

    const setup = el("section", "setup");
    root.append(routes, setup);
    document.body.appendChild(root);

    // 노선번호+이름으로 묶기
    const groups = new Map<string, RoadIndexEntry[]>();
    for (const r of index.roads) {
      const key = `${r.ref}|${r.name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    function renderList() {
      const q = search.value.trim();
      list.innerHTML = "";
      for (const [key, rs] of groups) {
        const [ref, name] = key.split("|");
        if (q && !name.includes(q) && ref !== q && !rs.some((r) => r.from.includes(q) || r.to.includes(q))) continue;
        const box = el("div", "route");
        box.appendChild(el("div", "name", `<span class="shield">${ref}</span>${name}`));
        const dirs = el("div", "dirs");
        for (const r of rs) {
          const b = el("button", r.id === road.id ? "on" : "", `${r.from} → ${r.to}<small>${r.lengthKm}km${real?.roads[r.id]?.density ? " · 실측" : ""}</small>`);
          b.onclick = () => {
            road = r;
            startKm = Math.min(startKm, Math.max(0, r.lengthKm - 1));
            renderList();
            renderSetup();
          };
          dirs.appendChild(b);
        }
        box.appendChild(dirs);
        list.appendChild(box);
      }
    }
    search.oninput = renderList;

    function seg<T extends string | number>(options: [T, string][], value: T, onPick: (v: T) => void) {
      const wrap = el("div", "seg");
      for (const [v, label] of options) {
        const b = el("button", v === value ? "on" : "", label);
        b.onclick = () => {
          onPick(v);
          renderSetup();
        };
        wrap.appendChild(b);
      }
      return wrap;
    }

    function field(label: string, content: HTMLElement) {
      const f = el("div", "field");
      f.appendChild(el("label", "", label));
      f.appendChild(content);
      return f;
    }

    function renderSetup() {
      setup.innerHTML = "";
      setup.appendChild(el("h2", "", `${road.name} <span style="color:var(--muted);font-weight:500">${road.from} → ${road.to}</span>`));
      setup.appendChild(
        el(
          "p",
          "sub",
          `${road.lengthKm}km · 주로 편도 ${road.lanes}차로 · IC·JC ${road.junctions}곳 · 터널 ${road.tunnels}곳 · 교량 ${road.bridges}곳` +
            (real?.roads[road.id]?.sites?.length ? ` · 전날 실측 교통 (측정 지점 ${real.roads[road.id].sites!.length}곳)` : ""),
        ),
      );

      const km = el("div", "km");
      const range = el("input");
      range.type = "range";
      range.min = "0";
      range.max = String(Math.max(0, Math.floor(road.lengthKm - 1)));
      range.step = "0.5";
      range.value = String(startKm);
      const out = el("output");
      out.textContent = `${startKm.toFixed(1)} km 지점`;
      range.oninput = () => {
        startKm = Number(range.value);
        out.textContent = `${startKm.toFixed(1)} km 지점`;
      };
      km.append(range, out);
      setup.appendChild(field("출발 위치 (주행선 시작점부터)", km));

      const presets: [Preset, string][] = [
        ["자동", `시간대 반영`],
        ["한산", "한산"],
        ["보통", "보통"],
        ["혼잡", "혼잡"],
        ["정체", "정체"],
      ];
      // 전날 실제 교통은 도로공사 측정 지점이 있는 주행선에만 있다
      if (real?.roads[road.id]?.density) presets.push(["실제", `실제 교통 (${real.date.slice(5).replace("-", "/")})`]);
      else if (preset === "실제") preset = "자동";
      setup.appendChild(field("교통량", seg(presets, preset, (v) => (preset = v))));
      setup.appendChild(
        field(
          "시간대 (밝기·버스전용차로·교통량에 반영, 19시~5시는 밤)",
          seg(
            [6, 8, 12, 15, 18, 21, 2].map((h) => [h, `${h}시`] as [number, string]).concat([[hour, `지금 ${hour}시`]]).filter((v, i, a) => a.findIndex((x) => x[0] === v[0]) === i),
            hour,
            (v) => (hour = v),
          ),
        ),
      );
      setup.appendChild(field("요일", seg<string>([["weekday", "평일"], ["weekend", "주말·공휴일"]], weekend ? "weekend" : "weekday", (v) => (weekend = v === "weekend"))));
      setup.appendChild(
        field("시점", seg<CameraMode>([["cockpit", "운전석"], ["hood", "보닛"], ["chase", "차 뒤"]], camera, (v) => (camera = v))),
      );
      setup.appendChild(field("소리", seg<string>([["on", "켜기"], ["off", "끄기"]], sound ? "on" : "off", (v) => (sound = v === "on"))));

      const consentBox = el("label", "consent");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = consent;
      cb.onchange = () => (consent = cb.checked);
      consentBox.append(cb, el("span", "", "익명 주행 기록(위치·속도·조작·법규 판정)을 연구용 공개 데이터셋에 쓰는 데 동의합니다. 이름·연락처는 모으지 않습니다. 동의하지 않으면 기록은 이 브라우저에만 남습니다."));
      setup.appendChild(consentBox);

      setup.appendChild(
        el(
          "div",
          "keys",
          `<span><kbd>↑</kbd> <kbd>W</kbd></span><span>가속</span>
           <span><kbd>↓</kbd> <kbd>S</kbd></span><span>브레이크</span>
           <span><kbd>←</kbd><kbd>→</kbd> <kbd>A</kbd><kbd>D</kbd></span><span>조향 (M: 마우스 조향 켜기/끄기)</span>
           <span><kbd>Q</kbd> <kbd>E</kbd></span><span>왼쪽·오른쪽 방향지시등</span>
           <span><kbd>X</kbd></span><span>비상등</span>
           <span><kbd>C</kbd></span><span>시점 바꾸기 · <kbd>V</kbd> 거울 켜기/끄기 · <kbd>H</kbd> 경적</span>
           <span><kbd>Esc</kbd></span><span>일시정지 · 주행 끝내기</span>
           <span>게임패드·레이싱 휠</span><span>연결하면 자동으로 씁니다 (LB·RB 방향지시등)</span>`,
        ),
      );

      const start = el("button", "btn primary", "주행 시작");
      start.style.fontSize = "17px";
      start.style.padding = "12px 26px";
      start.onclick = () => {
        const s: DriveSettings = {
          road,
          startKm,
          preset,
          hour,
          weekend,
          camera,
          consent,
          sound,
          seed: Math.floor(Math.random() * 2 ** 31),
        };
        save(s);
        root.remove();
        resolve(s);
      };
      setup.appendChild(start);
      setup.appendChild(el("div", "links", `<a href="./garage.html">차량 도감 (${carTypes}종)</a><a href="../">DRIP 소개</a>`));
    }

    renderList();
    renderSetup();
  });
}
