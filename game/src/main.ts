// 주행 화면 진입점: 데이터 불러오기 → 시작 메뉴 → 주행.
// 주소 뒤에 ?road=r1-1&km=20 처럼 붙이면 메뉴 없이 바로 시작한다 (검수용, 기록은 서버에 올리지 않음).
//   preset=한산|보통|혼잡|정체|자동, hour=0~23, cam=cockpit|hood|chase, auto=1(자동 운전), sound=0

import "./ui/style.css";
import { Sound } from "./audio/sound";
import { Game } from "./game";
import { loadSignFonts } from "./render/signs";
import { Road, type RoadIndex } from "./road/road";
import { loadConfig } from "./sim/config";
import { showMenu, type CameraMode, type DriveSettings, type Preset } from "./ui/menu";

const app = document.getElementById("app")!;

function loading(text: string) {
  const d = document.createElement("div");
  d.className = "loading";
  d.textContent = text;
  document.body.appendChild(d);
  return {
    set: (t: string) => (d.textContent = t),
    done: () => d.remove(),
  };
}

function fail(err: unknown) {
  console.error(err);
  const d = document.createElement("div");
  d.className = "loading";
  d.innerHTML = `<div style="max-width:520px;text-align:center">불러오지 못했습니다.<br><small>${String((err as Error)?.message ?? err)}</small><br><br><button class="btn" onclick="location.reload()">다시 시도</button></div>`;
  document.body.appendChild(d);
}

function fromParams(p: URLSearchParams, index: RoadIndex): DriveSettings | null {
  const id = p.get("road");
  if (!id) return null;
  const road = index.roads.find((r) => r.id === id);
  if (!road) return null;
  return {
    road,
    startKm: Number(p.get("km") ?? 10),
    preset: (p.get("preset") as Preset) ?? "보통",
    hour: Number(p.get("hour") ?? 14),
    weekend: p.get("weekend") === "1",
    camera: (p.get("cam") as CameraMode) ?? "cockpit",
    consent: false,
    sound: p.get("sound") !== "0",
    seed: Number(p.get("seed") ?? 12345),
  };
}

async function main() {
  const params = new URLSearchParams(location.search);
  const ld = loading("전국 고속도로 목록을 불러오는 중…");
  const [index, cfg] = await Promise.all([
    fetch("./roads/index.json").then((r) => {
      if (!r.ok) throw new Error(`노선 목록 (${r.status})`);
      return r.json() as Promise<RoadIndex>;
    }),
    loadConfig("./data/"),
  ]);
  ld.done();

  let settings = fromParams(params, index);
  const retry = sessionStorage.getItem("drip_retry");
  if (!settings && retry) {
    sessionStorage.removeItem("drip_retry");
    try {
      settings = JSON.parse(retry) as DriveSettings;
    } catch {
      settings = null;
    }
  }
  if (!settings) settings = await showMenu(index, !!cfg.real, cfg.catalog.types.length);

  // 소리는 사용자가 누른 직후에 켜야 한다
  const sound = new Sound();
  sound.enabled = settings.sound;
  sound.start();

  const ld2 = loading(`${settings.road.name} ${settings.road.from} → ${settings.road.to} 도로 데이터를 불러오는 중…`);
  const [road] = await Promise.all([Road.load(settings.road.id), loadSignFonts()]);
  ld2.set("도로와 주변 지형을 만드는 중…");
  await new Promise((r) => setTimeout(r, 30));
  const game = new Game(app, road, cfg, settings, sound);
  ld2.done();
  (window as unknown as { __drip: unknown }).__drip = game;
  if (params.get("auto") === "1") game.autopilot = true;
  if (params.get("go") === "1") {
    game.state = "run";
    sound.resume();
  } else game.ready();
}

main().catch(fail);
