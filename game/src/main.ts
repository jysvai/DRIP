// 주행 화면 진입점: 데이터 불러오기 → 시작 메뉴(출발지·도착지·차량) → 경로 만들기 → 주행.
// 검수용 주소 (메뉴 없이 바로 시작, 기록은 서버에 올리지 않음):
//   ?road=r1-1&km=20              한 주행선을 20km 지점부터
//   ?from=서울&to=강릉&km=0        출발지·도착지 경로
//   preset=한산|보통|혼잡|정체|자동|실제, hour=0~23, weekend=1, weather=clear|cloudy|rain|heavy_rain|fog|real(어제 실제),
//   cam=cockpit|hood|chase, auto=1(자동 운전), sound=0, voice=0(음성 안내 끄기),
//   car=차종 id, color=#rrggbb, quality=auto|low|medium|high|ultra, shake=on|low|off(화면 흔들림), go=1(출발 안내 없이),
//   pace=full(요약 없이 처음부터 끝까지, 기본은 요약 주행), lka=0(차로 유지 보조 끄기)

import "./ui/style.css";
import { Sound } from "./audio/sound";
import { Game, type DriveSetup } from "./game";
import { loadSignFonts } from "./render/signs";
import { paletteFor } from "./render/vehicleModels";
import { Road } from "./road/road";
import { buildPlaces, findRoute, loadRoute, searchPlaces, type Network } from "./road/route";
import { loadConfig, type GameConfig } from "./sim/config";
import { weatherOf } from "./sim/weather";
import { ICON, WORDMARK } from "./ui/icons";
import { showMenu, type CameraMode, type DriveSettings, type Preset, type Quality, type ShakeLevel } from "./ui/menu";

const app = document.getElementById("app")!;

function loading(text: string) {
  const d = document.createElement("div");
  d.className = "loading";
  d.setAttribute("role", "status");
  d.innerHTML = `<div class="loading-box">${WORDMARK}<p class="loading-text" aria-live="polite"></p><div class="loading-road" aria-hidden="true"><i></i></div><small class="loading-note">실제 고속도로 선형 · 배속 없는 실시간 주행</small></div>`;
  const p = d.querySelector("p")!;
  p.textContent = text;
  document.body.appendChild(d);
  return {
    set: (t: string) => (p.textContent = t),
    done: () => d.remove(),
  };
}

function fail(err: unknown) {
  console.error(err);
  const d = document.createElement("div");
  d.className = "loading";
  d.innerHTML = `<div class="loading-box loading-error">${WORDMARK}<h1>불러오지 못했습니다</h1><p>도로 데이터를 받는 중에 문제가 생겼습니다. 인터넷 연결을 확인하고 다시 시도하세요.</p><code></code><button class="btn primary">${ICON.retry}다시 시도</button></div>`;
  d.querySelector("code")!.textContent = String((err as Error)?.message ?? err);
  d.querySelector("button")!.addEventListener("click", () => location.reload());
  document.body.appendChild(d);
}

function fromParams(p: URLSearchParams, net: Network, cfg: GameConfig): DriveSettings | null {
  let route: DriveSettings["route"] | null = null;
  const id = p.get("road");
  if (id) {
    const r = net.roads.find((x) => x.id === id);
    if (!r) return null;
    route = { from: r.from, to: r.to, legs: [{ road: r.id, s0: 0, s1: r.length, via: "" }], lengthM: r.length, timeS: 0 };
  } else if (p.get("from") && p.get("to")) {
    const places = buildPlaces(net);
    const a = searchPlaces(places, p.get("from")!)[0];
    const b = searchPlaces(places, p.get("to")!)[0];
    const plan = a && b ? findRoute(net, a, b) : null;
    if (!plan) return null;
    route = { from: a.name, to: b.name, legs: plan.legs, lengthM: plan.lengthM, timeS: plan.timeS };
  }
  if (!route) return null;
  const vehicle = cfg.catalog.types.find((t) => t.id === p.get("car")) ?? cfg.catalog.types.find((t) => t.id === "sedan_mid")!;
  return {
    route,
    startKm: Number(p.get("km") ?? (id ? 10 : 0)),
    vehicle: vehicle.id,
    color: p.get("color") ?? paletteFor(vehicle, cfg.catalog)[0],
    preset: (p.get("preset") as Preset) ?? "보통",
    hour: Number(p.get("hour") ?? 14),
    weekend: p.get("weekend") === "1",
    weather: p.get("weather") === "real" ? "real" : weatherOf(p.get("weather")).kind,
    camera: (p.get("cam") as CameraMode) ?? "cockpit",
    consent: false,
    sound: p.get("sound") !== "0",
    voice: p.get("voice") !== "0",
    quality: (p.get("quality") as Quality) ?? "auto",
    shake: (["on", "low", "off"].includes(p.get("shake") ?? "") ? p.get("shake") : "on") as ShakeLevel,
    pace: p.get("pace") === "full" ? "full" : "digest",
    lka: p.get("lka") !== "0",
    seed: Number(p.get("seed") ?? 12345),
  };
}

/** 고른 경로의 도로를 만든다. 한 주행선이면 원래 주행선을 그대로 쓴다 (s가 원래 위치라 기록 분석이 쉽다) */
async function buildDrive(settings: DriveSettings, net: Network, cfg: GameConfig): Promise<DriveSetup> {
  const legs = settings.route.legs;
  const vehicle = cfg.catalog.types.find((t) => t.id === settings.vehicle) ?? cfg.catalog.types[0];
  if (legs.length === 1) {
    const road = await Road.load(legs[0].road);
    return {
      road,
      sources: null,
      net,
      startS: legs[0].s0 + settings.startKm * 1000,
      finishS: Math.min(road.length, legs[0].s1),
      destName: settings.route.to,
      originName: settings.route.from,
      vehicle,
    };
  }
  const { file, sources } = await loadRoute({ legs, from: { name: settings.route.from }, to: { name: settings.route.to } });
  const road = new Road(file);
  return { road, sources, net, startS: settings.startKm * 1000, finishS: road.length, destName: settings.route.to, originName: settings.route.from, vehicle };
}

async function main() {
  const params = new URLSearchParams(location.search);
  const ld = loading("전국 고속도로망을 불러오는 중…");
  const [net, cfg] = await Promise.all([
    fetch("./roads/network.json").then((r) => {
      if (!r.ok) throw new Error(`도로망 (${r.status})`);
      return r.json() as Promise<Network>;
    }),
    loadConfig("./data/"),
  ]);
  ld.done();

  let settings = fromParams(params, net, cfg);
  const retry = sessionStorage.getItem("drip_retry");
  if (!settings && retry) {
    sessionStorage.removeItem("drip_retry");
    try {
      const s = JSON.parse(retry) as DriveSettings;
      settings = s.route?.legs?.length ? { ...s, shake: s.shake ?? "on" } : null;
    } catch {
      settings = null;
    }
  }
  if (!settings) settings = await showMenu(net, cfg.catalog, cfg.real, cfg.realWeather);

  // 소리는 사용자가 누른 직후에 켜야 한다
  const sound = new Sound();
  sound.enabled = settings.sound;
  sound.start();

  const ld2 = loading(`${settings.route.from} → ${settings.route.to} 경로의 도로 데이터를 불러오는 중…`);
  const [setup] = await Promise.all([buildDrive(settings, net, cfg), loadSignFonts()]);
  ld2.set("도로와 주변 지형을 만드는 중…");
  await new Promise((r) => setTimeout(r, 30));
  const game = new Game(app, setup, cfg, settings, sound);
  ld2.done();
  (window as unknown as { __drip: unknown }).__drip = game;
  if (params.get("auto") === "1") game.autopilot = true;
  if (params.get("go") === "1") {
    game.state = "run";
    sound.resume();
  } else game.ready();
}

main().catch(fail);
