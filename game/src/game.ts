// 한 번의 주행: 물리·교통·법규 판정·기록·화면을 한 루프로 돌린다.

import * as THREE from "three";
import type { Road, RoadFile } from "./road/road";
import { Structure } from "./road/road";
import { roughnessAt } from "./road/surface";
import type { Network } from "./road/route";
import { RoadChunks, type LaneOverride } from "./render/roadChunks";
import { CityScene } from "./render/city";
import type { CityNet } from "./city/net";
import type { CityStop } from "./city/route";
import type { Signals } from "./city/signals";
import { CITY_COMPOSITION, CityTraffic, type PlayerBody } from "./city/traffic";
import { PlayerView, CAMERA_LABELS, SHAKE_SCALE, blinkOn, type CameraMode } from "./render/playerView";
import { Sparks } from "./render/sparks";
import { expansionJoints, rumbleContact } from "./road/surface";
import { DriveFx } from "./ui/fx";
import { SprayView, type SpraySource } from "./render/spray";
import { ICE_GRIP, iceAt, planIce, type IcePatch } from "./sim/ice";
import { TrafficView } from "./render/trafficView";
import { GfxGovernor, gpuName, guessTier, loadAutoTier, saveAutoTier } from "./render/gfx";
import { QUALITY_LABELS, World, type Quality } from "./render/world";
import { WeatherView } from "./render/weather";
import { RuleEngine, type PlayerFrame } from "./rules/engine";
import { Recorder, SAMPLE_COLUMNS, type Sample, type UploadStatus } from "./log/recorder";
import { assessSession, loadParticipant, saveParticipant, updateParticipant, type QualityResult } from "./log/quality";
import { Sound, type NearbyCar } from "./audio/sound";
import { enforcementFor, type Enforcement } from "./sim/cameras";
import { coneLine, END_TAPER_M, planWorkZones, ZONE_KMH, type WorkZone } from "./sim/workzones";
import { gripAt, legalFactor, realWeatherAt, trafficResponse, weatherOf, type Weather } from "./sim/weather";
import { planIncidents, type Incident } from "./sim/incidents";
import { realEventsFor, realEventsStamp } from "./sim/realEvents";
import type { GameConfig } from "./sim/config";
import { routeBusZones, sunFor, trafficFor } from "./sim/scenario";
import { Input, type DeviceKind } from "./sim/input";
import { LKA, laneKeep, type LkaState } from "./sim/assist";
import { DIGEST_CITY, planDigest, type DriveWindow } from "./sim/pacing";
import { PlayerCar, type Controls } from "./sim/player";
import { specFor, type PlayerSpec } from "./sim/vehicleSpec";
import type { VehicleType } from "./render/vehicleModels";
import { Rng } from "./sim/rng";
import { Traffic, type Agent, type BusLaneZone, type PlayerState } from "./sim/traffic";
import { Hud } from "./ui/hud";
import type { DriveSettings } from "./ui/menu";
import { showDialog, showReport } from "./ui/report";
import { showControls } from "./ui/help";

const PHYS_DT = 1 / 120;
const SERIOUS_KMH = 15;
/** 국도 교통량: 시내 대비 (메뉴 교통 설정·시간대는 같이 따른다) */
const RURAL_TRAFFIC = 0.5;

/** 한 번의 주행에 필요한 도로·경로 정보 */
export interface DriveSetup {
  road: Road;
  /** 경로를 이룬 원래 주행선 파일들 (한 주행선이면 null) */
  sources: Map<string, RoadFile> | null;
  net: Network | null;
  startS: number;
  /** 여기에 닿으면 목적지 도착 */
  finishS: number;
  destName: string;
  originName: string;
  vehicle: VehicleType;
  /** 시내 주행: 도로망과 신호 (고속도로면 없음) */
  city?: { net: CityNet; signals: Signals } | null;
}

/** 마지막 한글 글자에 받침이 있으면 b, 없으면 a (예: 와/과) */
function josa(word: string, a: string, b: string): string {
  const m = word.match(/[가-힣](?=[^가-힣]*$)/);
  if (!m) return a;
  return (m[0].charCodeAt(0) - 0xac00) % 28 ? b : a;
}

const INPUT_LABELS: Record<DeviceKind, string> = { keyboard: "키보드", mouse: "마우스 조향", pad: "게임패드", wheel: "레이싱 휠" };

export class Game {
  readonly world: World;
  readonly player: PlayerCar;
  readonly traffic: Traffic;
  readonly view: PlayerView;
  readonly trafficView: TrafficView;
  /** 새벽 결빙: 언 곳 (날씨가 black_ice일 때만) */
  readonly ice: IcePatch[];
  /** 비 오는 날 차들이 튀기는 물보라 */
  readonly spray: SprayView;
  private spraySources: SpraySource[] = [];
  readonly chunks: RoadChunks | CityScene;
  /** 시내 주행이면 도로망과 신호 */
  readonly city: { net: CityNet; signals: Signals } | null;
  /** 시내: 경로의 교차로 (정지선 순) */
  private stops: CityStop[] = [];
  /** 시내: 경로가 모든 차로로 이어지지 않는 교차로·갈림길 (s: 교차로 곡선 시작, lanes: 경로로 가는 차로) */
  private laneTargets: { s: number; lanes: [number, number] }[] = [];
  /** 시내: 경로를 벗어나는 차와 교차로를 건너는 차 */
  readonly cityTraffic: CityTraffic | null = null;
  private tmpW = { e: 0, n: 0, z: 0, heading: 0 };
  /** 자동 운전이 적색 우회전을 위해 정지선에 선 시각 */
  private autoHoldAt = -1;
  readonly rules: RuleEngine;
  readonly recorder: Recorder;
  readonly input: Input;
  readonly hud: Hud;
  readonly busZones: BusLaneZone[];
  readonly enforcement: Enforcement;
  readonly workZones: WorkZone[];
  readonly incidents: Incident[];
  /** 실제 돌발상황을 쓰면 그 기준 시각 ("09/22 06:40 기준"), 아니면 "" */
  readonly realEvents: string;
  readonly weather: Weather;
  /** 실제 날씨를 쓰면 출발 안내 문구 */
  private realWeather = "";
  readonly weatherView: WeatherView;
  readonly road: Road;
  readonly spec: PlayerSpec;
  state: "ready" | "run" | "pause" | "crash" | "end" = "ready";
  t = 0;
  signal: -1 | 0 | 1 = 0;
  hazard = false;
  autopilot = false;
  /** 한 번이라도 자동 운전을 켰으면 연구 데이터에 넣지 않는다 */
  private autopilotUsed = false;
  fps = 0;
  private acc = 0;
  private last = performance.now();
  /** 그래픽 품질 자동 맞춤과 GPU를 기다려 잴 때 쓰는 1화소 */
  private gov: GfxGovernor;
  /** 요약 주행: 달릴 구간들 (null이면 처음부터 끝까지). winIdx는 지금 달리는 구간 */
  private digest: DriveWindow[] | null = null;
  private winIdx = 0;
  private startS = 0;
  /** 건너뛰는 중: 바깥이 다 어두워지면(at) to로 옮긴다. sec는 건너뛴 길을 달렸다면 걸렸을 시간 */
  private pendingJump: { to: number; at: number; sec: number } | null = null;
  /** 게임 속 시계가 주행 시간보다 앞선 만큼 (건너뛴 시간, 초) */
  private clockOffset = 0;
  /** 차로 유지 보조: 켜짐 여부, 지금 막고 있는 쪽(-1 왼쪽, 1 오른쪽), 경고 표시가 남은 시간과 그쪽 */
  lka = true;
  /** 키보드 핸들을 놓으면 길 방향·굽이를 따라가게 잡아 준다 (메뉴 "곡선에서 핸들 유지") */
  private steerHold = true;
  /** 지난 프레임의 조작 장치 (바뀌면 기록) */
  private device: DeviceKind = "keyboard";
  private lkaSide = 0;
  private lkaWarn = 0;
  private warnSide = 0;
  private signalOffAt = -99;
  /** 노면 거칠기 (0 매끈 ~ 1 공사 구간) */
  private rough = 0;
  /** 갑자기 끼어들기 사건: 다음까지 남은 달린 시간 (s) */
  private cutInTimer = 0;
  private eventRng: Rng;
  private gpu = "";
  private frameNo = 0;
  private pixel = new Uint8Array(4);
  private sampleTimer = 0;
  private signalCancelAt = -1;
  private laneForSignal = 0;
  private contactCooldown = 0;
  /** 시내: 지금 맞닿아 있는 경로 밖 차와 닿기 시작한 때 */
  private cityTouch: { a: Agent; since: number } | null = null;
  private baseDaylight = 1;
  private fpsFrames = 0;
  private fpsTime = 0;
  private autoLane = 0;
  /** 자동 운전: 옮기려는 차로와 방향지시등을 켠 곳 (도로교통법 시행령 별표2: 30m 앞부터) */
  private autoLcTo = 0;
  private autoLcS = 0;
  private assistWeight = 0;
  private controls: Controls = { throttle: 0, brake: 0, steer: 0, reverse: false };
  private legIndex = -1;
  // ---- 주행감 (소리·화면 흔들림·진동). 판정·기록에는 쓰지 않는다 ----
  /** 가드레일 불똥 */
  private sparks: Sparks;
  /** 속도감·충돌 번쩍임 */
  private fx: DriveFx;
  /** 교량 신축이음 위치와 앞·뒤 바퀴가 지난 s */
  private joints: { s: number; strength: number }[];
  private axleS: [number, number] = [NaN, NaN];
  /** 벽에 긁히는 정도 (0~1)와 쪽, 불똥 뿌릴 몫 */
  private scrape = 0;
  private scrapeSide = 0;
  private sparkDebt = 0;
  private lastGear = 1;
  private nearby: NearbyCar[] = [];
  /** 경적을 울렸거나 안 울리기로 한 차 (id → 시각) */
  private honked = new Map<number, number>();
  private hornCooldown = 0;
  private tmpDir = new THREE.Vector3();
  private tmpOut = new THREE.Vector3();

  constructor(
    app: HTMLElement,
    readonly setup: DriveSetup,
    readonly cfg: GameConfig,
    readonly settings: DriveSettings,
    private sound: Sound,
  ) {
    const road = setup.road;
    this.road = road;
    // 그래픽 품질: 자동이면 그래픽 카드로 짐작하고(지난번에 맞춘 값이 있으면 그것), 대기 화면에서 재서 고친다
    const auto = settings.quality === "auto";
    this.gpu = auto ? gpuName() : "";
    const nav = navigator as Navigator & { deviceMemory?: number };
    const tier: Quality = auto
      ? (loadAutoTier(this.gpu) ?? guessTier(this.gpu, { coarse: matchMedia("(pointer: coarse)").matches, memoryGb: nav.deviceMemory ?? 0, cores: nav.hardwareConcurrency ?? 0 }))
      : (settings.quality as Quality);
    this.world = new World(app, tier);
    this.gov = new GfxGovernor(auto, tier);
    this.world.renderer.shadowMap.autoUpdate = false;
    const sun = sunFor(settings.hour);
    // 밤에는 하늘을 그리지 않고, 빛 방향은 높이 뜬 달
    if (sun.night > 0.6) this.world.setSun(40, 200);
    else this.world.setSun(Math.max(2, sun.elevation), sun.azimuth);
    this.world.setNight(sun.night);
    // 날씨: 흐리면 어둡고, 비·안개는 가시거리만큼 안개를 당긴다. '실제'는 어제 같은 시각 출발 지점의 날씨
    const realW = settings.weather === "real" ? realWeatherAt(cfg.realWeather, road, Math.max(60, setup.startS), settings.hour) : null;
    const weather = realW ? realW.weather : weatherOf(settings.weather === "real" ? "clear" : settings.weather);
    this.realWeather = realW ? `실제 날씨(Open-Meteo, ${realW.stamp}, 출발 지점): ${weather.label}.` : "";
    this.weather = weather;
    this.weatherView = new WeatherView(this.world, weather);
    this.weatherView.apply(sun.night);
    this.baseDaylight = sun.daylight * (1 - 0.35 * weather.overcast);
    this.world.daylight = this.baseDaylight;

    const city = setup.city ?? null;
    this.city = city;
    this.stops = road.city?.stops ?? [];
    this.laneTargets = (road.city?.keep ?? []).map(([s, lo, hi]) => ({ s, lanes: [lo, hi] as [number, number] }));
    this.busZones = city ? [] : routeBusZones(road, setup.sources ?? new Map(), cfg.rules, settings.weekend, settings.hour);
    if (city) {
      // 시내는 건물이 가려 멀리 볼 일이 적어서 900m까지만 만든다. 국도는 먼 산까지 보인다
      this.chunks = new CityScene(city.net, city.signals, this.world, () => this.signalClock);
      this.world.setViewCap(this.rural ? 2600 : 900);
    } else {
      const chunks = new RoadChunks(road, this.world);
      chunks.overrides = this.busZones.map<LaneOverride>((z) => ({ s0: z.s0, s1: z.s1, boundary: z.lane, color: 0x2463d8 }));
      this.chunks = chunks;
    }
    this.enforcement = city ? { fixed: [], sections: [] } : enforcementFor(road, cfg.cameras);
    this.chunks.setEnforcement(this.enforcement);
    if (weather.wet) this.chunks.setWet(0.75 + 0.25 * Math.max(weather.rain, weather.snow * 0.5), this.weatherView.roadEnvironment());
    // 눈: 땅·나무·방호벽 윗면에 쌓인다
    if (weather.snow > 0) this.chunks.setSnow(0.7 + 0.3 * weather.snow);

    const type = setup.vehicle;
    this.spec = specFor(type);
    this.player = new PlayerCar(this.spec);
    // 젖은 노면은 미끄럽다 (터널 안은 마른 노면). 새벽 결빙이면 언 곳만 아주 미끄럽다
    const heavyGrip = this.spec.vehicleClass !== "car";
    // 시내는 출발지 길가에 서 있다가 출발한다
    const s0 = city ? Math.max(2, Math.min(setup.finishS - 50, setup.startS)) : Math.max(60, Math.min(setup.finishS - 400, setup.startS));
    this.ice = weather.ice && !city ? planIce(road, { seed: settings.seed, startS: s0, finishS: setup.finishS }) : [];
    this.player.grip = (kmh) => {
      const s = this.player.s;
      if (this.ice.length && iceAt(this.ice, s)) return heavyGrip ? ICE_GRIP.heavy : ICE_GRIP.car;
      return road.structureAt(s) === Structure.Tunnel ? 1 : gripAt(weather, kmh, heavyGrip);
    };
    const lanes = road.lanesAt(s0);
    // 화물·대형승합은 지정차로(오른쪽)에서 출발. 시내는 맨 오른쪽에서 나서되, 바로 앞에서 돌아야 하면 100m에 한 차로씩 옮길 수 있는 만큼 그쪽 차로에서
    const startLane = city ? this.cityLane(s0) : this.spec.vehicleClass !== "car" ? lanes : lanes >= 3 ? 2 : lanes;
    const heavySpeed = this.spec.vehicleClass === "truck" && !!type.heavy;
    const startKmh = city ? 0 : Math.min(road.speedAt(s0, heavySpeed) * 0.8 * legalFactor(weather, cfg.rules), 90, this.spec.governor * 3.6 - 5);
    this.player.place(road, s0, startLane, startKmh / 3.6);
    this.lastGear = this.player.gear;
    const night = sun.night > 0.5;
    // '실제' 교통을 고르고 실제 돌발상황(ITS)이 있으면 그 공사·선 차를 쓴다
    const real = settings.preset === "실제" && !city ? realEventsFor(road, cfg.events) : null;
    this.realEvents = real ? realEventsStamp(cfg.events!) : "";
    if (real) {
      const ahead = (s: number) => s > s0 + 300 && s < setup.finishS - 300;
      this.workZones = real.workZones.filter((z) => ahead(z.s0));
      this.incidents = real.incidents.filter((i) => ahead(i.s));
    } else if (city) {
      // 시내 공사·돌발상황은 아직 없다
      this.workZones = [];
      this.incidents = [];
    } else {
      // 공사 구간 (시드로 도로 전체에 놓고 출발 1.2km 뒤부터, 시간대·요일 빈도)
      this.workZones = planWorkZones(road, { seed: settings.seed, hour: settings.hour, weekend: settings.weekend, startS: s0, finishS: setup.finishS });
      // 돌발상황 (고장·사고로 선 차): 같은 시드면 어디서 출발하든 같은 자리라, 피할 공사 구간도 출발 위치로 거르기 전 전체를 쓴다
      const allZones = planWorkZones(road, { seed: settings.seed, hour: settings.hour, weekend: settings.weekend, startS: -Infinity, finishS: Infinity });
      this.incidents = planIncidents(road, { seed: settings.seed, night, startS: s0, finishS: setup.finishS, workZones: allZones });
    }
    this.chunks.setWorkZones(this.workZones);
    this.chunks.setIncidents(this.incidents, night);
    if (this.ice.length) this.chunks.setIce(this.ice, this.weatherView.roadEnvironment());

    // 실제 교통은 출발 위치의 원래 주행선·위치로 찾는다
    const tr = city ? this.cityTrafficLevel() : this.trafficAt(s0);
    this.legIndex = road.legs.indexOf(road.legAt(s0));
    this.traffic = new Traffic(road, cfg, settings.seed);
    this.eventRng = new Rng(settings.seed * 7 + 13);
    this.cutInTimer = CUT_IN.first[0] + this.eventRng.next() * (CUT_IN.first[1] - CUT_IN.first[0]);
    this.traffic.density = Math.max(city ? 0 : 1, tr.density);
    this.traffic.flowSpeed = tr.flowKmh ? tr.flowKmh / 3.6 : null;
    // 날씨 반응: 비에는 속도를 거의 줄이지 않고(실측), 폭우·안개에는 줄인다 (driver_profiles.json weather)
    const resp = trafficResponse(weather, cfg.profiles.weather);
    this.traffic.headwayScale = (1 + 0.1 * sun.night) * resp.headwayScale;
    this.traffic.weatherSpeed = resp.speedScale;
    this.traffic.setComposition(tr.composition);
    this.traffic.busZones = this.busZones;
    this.traffic.workZones = this.workZones;
    this.traffic.incidents = this.incidents;
    if (city) {
      // 시내: 신호·교차로를 알려 주고, 경로 밖으로 도는 차와 교차로를 건너는 차를 따로 움직인다
      this.cityTraffic = new CityTraffic(city.net, city.signals, road, this.traffic, () => this.signalClock, new Rng(settings.seed * 3 + 1));
      this.cityTraffic.scale = tr.density / 15;
      this.traffic.city = this.cityTraffic;
      this.traffic.setRegion(300, 900);
    }
    this.traffic.fill(this.playerState());
    // 출발 속도는 주변 차 흐름에 맞춘다 (막히는 길에서 바로 급제동하지 않게). 시내는 서 있다가 출발한다
    const near = this.traffic.agents.filter((a) => Math.abs(a.s - s0) < 400);
    if (near.length >= 3 && !city) {
      const flow = (near.reduce((sum, a) => sum + a.v, 0) / near.length) * 3.6;
      this.player.place(road, s0, startLane, Math.max(20, Math.min(startKmh, flow)) / 3.6);
    }

    this.trafficView = new TrafficView(this.world, road, cfg.catalog);
    this.spray = new SprayView(this.world);
    this.sparks = new Sparks(this.world);
    this.fx = new DriveFx();
    this.joints = expansionJoints(road);
    this.hud = new Hud(document.body, road, this.busZones, {
      finishS: setup.finishS,
      destName: setup.destName,
      startS: s0,
      hour: settings.hour,
      maxKmh: type.maxSpeed > 200 ? 260 : type.maxSpeed > 150 ? 200 : 140,
      redline: this.spec.redline,
      idleRpm: this.spec.idleRpm,
      heavy: heavySpeed,
      net: setup.net,
      cityGraph: city?.net.graph ?? null,
      say: (text) => {
        if (this.state !== "run") return false;
        this.sound.say(text);
        return true;
      },
      enforcement: this.enforcement,
      workZones: this.workZones,
      incidents: this.incidents,
      iceWarn: !!weather.ice,
      weather: { label: weather.label, factorAt: (s) => this.rules.weatherFactorAt(s) },
      chime: () => this.sound.chime(),
    });
    this.view = new PlayerView(this.world, type, settings.color, this.hud.root);
    this.view.setMode(settings.camera as CameraMode);
    this.view.shake.scale = SHAKE_SCALE[settings.shake ?? "on"];
    this.view.setNight(sun.night);
    this.input = new Input(this.world.renderer.domElement);

    this.rules = new RuleEngine(road, cfg.rules, this.busZones);
    this.rules.vehicleClass = this.spec.vehicleClass;
    this.rules.heavySpeed = heavySpeed;
    this.rules.enforcement = this.enforcement;
    this.rules.workZones = this.workZones;
    this.rules.incidents = this.incidents;
    this.rules.ice = this.ice;
    this.rules.weatherFactor = legalFactor(weather, cfg.rules);
    if (city) this.rules.city = { stops: this.stops, light: (st) => city.signals.go(st.junction, st.link, st.turn, this.signalClock) };
    this.recorder = new Recorder(settings.consent);
    this.rules.onEvent = (e) => this.recorder.event(e);
    this.lka = settings.lka ?? true;
    this.input.pedal = settings.pedal ?? "hold";
    this.input.steerSens = settings.steerSens ?? "normal";
    this.input.wheelRange = settings.wheelRange ?? 900;
    this.input.calibration = settings.wheelCal ?? null;
    {
      const sp = this.player.spec;
      const L = sp.lf + sp.lr;
      this.input.car = { wheelbase: L, maxSteer: sp.maxSteer, understeer: (sp.mass * sp.lr) / L / sp.cf - (sp.mass * sp.lf) / L / sp.cr };
    }
    this.steerHold = settings.steerHold ?? true;
    this.device = this.input.device;
    this.startS = s0;
    // 요약 주행: 출발·분기점·도착과 사이 몇 구간만 달린다. 사이 구간은 나들목·공사·선 차·구간단속 쪽으로 조금 당긴다.
    // 시내·국도는 짧은 구간으로 신호 교차로 쪽으로 당기고, 교차로 안이나 정지선 60m 안으로는 건너뛰지 않는다
    if ((settings.pace ?? "digest") === "digest") {
      const wins = city
        ? planDigest({
            startS: s0,
            finishS: setup.finishS,
            transfers: [],
            poi: this.stops.filter((x) => x.signal).map((x) => x.s),
            seed: settings.seed,
            profile: DIGEST_CITY,
            avoid: this.stops.map((x) => [x.s - 60, x.sExit + 20] as [number, number]),
          })
        : planDigest({
            startS: s0,
            finishS: setup.finishS,
            transfers: road.isRoute ? road.legs.slice(1).map((l, i) => ({ diverge: road.legs[i].s1, merge: l.s0 })) : [],
            poi: [...road.junctions.map((j) => j.s), ...this.workZones.map((z) => z.s0), ...this.incidents.map((i) => i.s), ...this.enforcement.sections.map((x) => x.s0)],
            seed: settings.seed,
          });
      this.digest = wins.length > 1 ? wins : null;
    }
    this.recorder.start({
      roadId: road.id,
      roadRef: road.ref,
      roadName: road.name,
      direction: `${setup.originName}→${setup.destName}`,
      startS: Math.round(s0),
      vehicle: type.id,
      weather: weather.kind,
      route: road.isRoute ? road.legs : null,
      preset: `${settings.preset}:${tr.source}:${tr.density.toFixed(1)}`,
      simHour: settings.hour + (settings.weekend ? 100 : 0),
      seed: settings.seed,
      inputMode: this.input.mode,
      camera: settings.camera,
      drive: {
        pace: this.digest ? "digest" : "full",
        windows: this.digest ? this.digest.map((w) => [Math.round(w.s0), Math.round(w.s1)]) : null,
        lka: this.lka,
        pedal: this.input.pedal,
        steerHold: this.steerHold,
        steerSens: this.input.steerSens,
        device: this.device,
        wheelRange: this.input.wheelRange,
        wheelCal: !!this.input.calibration,
      },
    });

    this.sound.enabled = settings.sound;
    this.sound.voiceOn = settings.voice;
    this.sound.rain = weather.rain;
    this.sound.wetRoad = weather.wet;
    // 눈: 앞유리에는 눈송이가 붙었다 녹고, 바퀴는 젖은 눈(진창)을 조금 튀긴다
    this.view.windshield.rain = weather.rain || weather.snow * 0.45;
    this.view.windshield.flakes = weather.snow > 0;
    this.spray.wet = weather.rain || weather.snow * 0.6;
    this.trafficView.wet = weather.wet ? 0.6 + 0.4 * Math.max(weather.rain, weather.snow * 0.5) : 0;
    this.view.windshield.onStroke = () => {
      if (this.view.mode === "cockpit") this.sound.wiper();
    };
    this.sound.setPowertrain(this.spec.powertrain);
    this.world.origin.e = 0;
    this.updateOrigin();
    this.chunks.prime(this.player.s);
    this.laneForSignal = road.laneOf(this.player.d, this.player.s);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.state === "run") this.pause();
    });
    requestAnimationFrame(this.frame);
  }

  /** s 위치의 교통량: 원래 주행선과 그 위치로 실제 교통·시간대 교통을 찾는다 */
  private trafficAt(s: number) {
    const src = this.road.sourceAt(s);
    return trafficFor({ road: { id: src.road }, startKm: src.s / 1000, preset: this.settings.preset, hour: this.settings.hour }, this.cfg);
  }

  /** 국도 주행 (경기 동부 같은 국도 지역) */
  private get rural(): boolean {
    return this.city?.net.graph.kind === "rural";
  }

  /** 시내·국도 교통량: 메뉴의 교통 설정 (자동·실제는 시간대 배율), 차종은 시내 구성. 국도는 시내의 절반쯤 */
  private cityTrafficLevel() {
    const t = this.cfg.traffic;
    const auto = this.settings.preset === "자동" || this.settings.preset === "실제";
    const base = t.presets[auto ? "보통" : this.settings.preset]?.vehPerKmPerLane ?? 15;
    const density = base * (auto ? t.hourlyFactor[this.settings.hour] : 1) * (this.rural ? RURAL_TRAFFIC : 1);
    const kind = this.rural ? "국도" : "시내";
    return { density, composition: CITY_COMPOSITION, source: auto ? `${kind}·시간대` : kind, flowKmh: undefined as number | undefined };
  }

  /** 시내: 플레이어 차의 자리·방향 (도로망 좌표) */
  private playerBody(): PlayerBody {
    const p = this.player;
    const [ox, oy] = this.city!.net.graph.origin;
    const w = this.road.toWorld(p.s, p.d, this.tmpW);
    const h = w.heading + p.theta;
    return { s: p.s, x: w.e - ox, y: w.n - oy, z: w.z, hx: Math.cos(h), hy: Math.sin(h), v: p.vx, len: p.spec.length, w: p.spec.width };
  }

  /** 경로의 다음 노선으로 넘어가면 그 노선의 교통량으로 바꾼다 (새로 나타나는 차부터 적용) */
  private updateLegTraffic() {
    const leg = this.road.legAt(this.player.s);
    const k = this.road.legs.indexOf(leg);
    if (k === this.legIndex || this.player.s < leg.s0) return;
    this.legIndex = k;
    const tr = this.trafficAt(this.player.s);
    this.traffic.density = Math.max(1, tr.density);
    this.traffic.flowSpeed = tr.flowKmh ? tr.flowKmh / 3.6 : null;
    this.traffic.setComposition(tr.composition);
    this.hud.toast(`${leg.name} · ${leg.to} 방향`, 2.5);
  }

  /** 시내 신호 시각 (자정부터 s): 출발 시각 + 달린 시간 + 건너뛴 시간 */
  get signalClock(): number {
    return this.settings.hour * 3600 + this.t + this.clockOffset;
  }

  /** 시내: s 앞(또는 지나는 중인) 첫 교차로 */
  private stopAhead(s: number): CityStop | null {
    for (const st of this.stops) if (st.sExit > s) return st;
    return null;
  }

  playerState(): PlayerState {
    const p = this.player;
    return { s: p.s, d: p.d, v: p.vx * Math.cos(p.theta), len: p.spec.length, width: p.spec.width };
  }

  private updateOrigin() {
    const w = this.road.toWorld(this.player.s, this.player.d);
    this.world.origin.e = w.e;
    this.world.origin.n = w.n;
  }

  /** 출발 안내 */
  ready(onStart?: () => void) {
    const road = this.road;
    const s = this.player.s;
    const lanes = road.lanesAt(s);
    const remain = (this.setup.finishS - s) / 1000;
    const notes: string[] = [];
    if (this.busZones.some((z) => z.s1 > s)) notes.push("경로에 버스전용차로 구간이 있습니다(파란 선, 1차로).");
    if (this.spec.vehicleClass !== "car") notes.push("화물·대형승합은 지정차로(오른쪽 차로)로 달려야 합니다. 앞지르기 때만 바로 왼쪽 차로를 쓸 수 있습니다.");
    if (this.realEvents) {
      const inc = this.incidents.filter((i) => i.s > s).length;
      notes.push(`실제 돌발상황(국가교통정보센터, ${this.realEvents})을 씁니다: 사고·고장 차량 ${inc}곳.`);
    }
    const works = this.workZones.filter((z) => z.s0 > s).length;
    if (works) notes.push(`경로에 공사 구간이 ${works}곳 있습니다. 한 차로를 라바콘으로 막고 제한속도 ${ZONE_KMH}km/h입니다.`);
    if (this.realWeather) notes.push(this.realWeather);
    const cut = Math.round((1 - this.rules.weatherFactor) * 100);
    const weatherNote = this.weatherNote(cut);
    if (weatherNote) notes.push(weatherNote);
    if (this.digest) {
      const km = this.digest.reduce((a, w) => a + w.s1 - w.s0, 0) / 1000;
      const min = this.digest.reduce((a, w) => a + this.driveTime(w.s0, w.s1), 0) / 60;
      const full = this.driveTime(s, this.setup.finishS) / 60;
      notes.push(`요약 주행: ${this.digest.length}구간 ${km.toFixed(1)}km만 달리고(약 ${Math.max(1, Math.round(min))}분, 다 달리면 ${Math.round(full)}분) 사이는 건너뜁니다.`);
    }
    const signals = this.stops.filter((x) => x.signal && x.s > s).length;
    const turns = this.stops.filter((x) => x.turn !== "S" && x.s > s).length;
    const body = this.city
      ? `<b>${road.sectionNameAt(s)}</b> 편도 ${lanes}차로 길가에 서 있습니다. 목적지까지 <b>${remain.toFixed(1)}km</b>, 신호 교차로 ${signals}곳을 지나고 ${turns}번 돕니다.` +
        (notes.length ? `<br>${notes.join(" ")}` : "") +
        `<br><span class='muted'>${this.rural ? "국도 주행입니다. 제한속도가 구간마다 다르고(60~80km/h, 읍내는 더 낮게) 굽은 길·오르내리막이 많습니다. 읍내 교차로는 신호를 지키고," : "시내 주행입니다. 신호를 지키고,"} 좌회전·우회전은 미리 그쪽 차로로 옮겨 방향지시등을 켜세요. 우회전은 적색 신호여도 정지선에서 멈췄다가 천천히 돌 수 있습니다. 주행 중에는 법규 판정을 보여 주지 않고, 끝난 뒤 결과 화면에서 보여 줍니다. 조작법은 F1.</span>`
      : `<b>${road.sectionNameAt(s)}</b> 편도 ${lanes}차로에서 ${Math.round(this.player.speed * 3.6)}km/h로 출발합니다. 목적지까지 <b>${remain.toFixed(0)}km</b>.` +
        (notes.length ? `<br>${notes.join(" ")}` : "") +
        "<br><span class='muted'>위쪽 안내를 따라 분기점에서 갈아타세요. 주행 중에는 법규 판정을 보여 주지 않고, 끝난 뒤 결과 화면에서 보여 줍니다. 조작법은 F1.</span>";
    showDialog(
      `${this.setup.originName} → ${this.setup.destName}`,
      body,
      [
        { label: "조작법 (F1)", key: "F1", keep: true, onClick: () => showControls() },
        {
          label: "출발 (Enter)",
          primary: true,
          key: "Enter",
          onClick: () => {
            this.state = "run";
            this.sound.resume();
            this.sound.say(
              `경로 안내를 시작합니다. ${this.setup.destName}까지 ${remain < 10 ? `${remain.toFixed(1)}` : Math.round(remain)}킬로미터입니다.` +
                (cut
                  ? ` ${this.weather.visibilityM <= 100 ? "앞이 잘 보이지 않습니다" : this.weather.snow > 0 ? "눈길입니다" : "노면이 젖어 있습니다"}. 제한속도의 ${cut}퍼센트를 줄여 달리세요.`
                  : ""),
            );
            onStart?.();
          },
        },
      ],
    );
  }

  /** 출발 안내에 넣을 날씨 설명 */
  private weatherNote(cut: number): string {
    const w = this.weather;
    if (w.ice)
      return "새벽 결빙: 맑지만 다리 위와 터널을 나온 뒤 그늘이 군데군데 얼어 있습니다. 젖은 것처럼 조금 어둡게 반들거릴 뿐 잘 보이지 않습니다. 얼음 위에서는 제동거리가 약 7배로 늘어납니다. 긴 다리 앞에는 결빙 주의 안내가 나옵니다.";
    if (w.kind === "clear" || w.kind === "cloudy") return "";
    const why = w.visibilityM <= 100 ? `${w.label}로 앞이 ${w.visibilityM}m 정도밖에 보이지 않습니다` : w.snow > 0 ? "눈이 내려 노면에 눈이 쌓이고 있습니다" : `${w.label}가 내려 노면이 젖어 있습니다`;
    const grip = w.wet ? ` 노면이 미끄러워 제동거리가 약 ${(1 / w.grip).toFixed(1)}배로 늘어납니다.` : "";
    return cut ? `${why}. 법대로라면 제한속도의 ${cut}%를 줄여 달려야 합니다(터널 안 제외).${grip}` : `${why}.${grip}`;
  }

  pause() {
    if (this.state !== "run") return;
    this.state = "pause";
    this.sound.suspend();
    this.pauseMenu();
  }

  private pauseMenu() {
    const remain = Math.max(0, this.setup.finishS - this.player.s) / 1000;
    showDialog("일시정지", `${this.setup.destName}까지 ${remain.toFixed(1)}km 남았습니다. 주행 기록은 멈춘 동안 쌓이지 않습니다.`, [
      { label: "계속 (Esc)", primary: true, key: "Escape", onClick: () => this.resume() },
      { label: "조작법", onClick: () => showControls(() => this.pauseMenu()) },
      { label: "주행 끝내기", onClick: () => this.finish("user") },
      { label: "경로 다시 고르기", onClick: () => location.reload() },
    ]);
  }

  private resume() {
    this.state = "run";
    this.last = performance.now();
    this.sound.resume();
  }

  private frame = (now: number) => {
    // requestAnimationFrame 시각이 시작 시각보다 조금 앞설 수 있어 음수가 되지 않게 한다
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 1) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    // 가끔 GPU까지 기다려 한 프레임에 실제로 드는 시간을 잰다 (모니터 주사율·절전 제한과 구분하려고)
    const measure = this.gov.wantsSample(this.frameNo++);
    if (measure) this.syncGpu();
    const t0 = performance.now();
    if (this.state === "run") this.step(dt);
    this.draw(dt);
    let work: number | null = null;
    if (measure) {
      this.syncGpu();
      work = performance.now() - t0;
    }
    this.tuneGraphics(now / 1000, dt * 1000, work);
    requestAnimationFrame(this.frame);
  };

  /** GPU가 앞서 받은 일을 다 끝낼 때까지 기다린다 (1화소 읽기) */
  private syncGpu() {
    const r = this.world.renderer;
    r.setRenderTarget(null);
    const gl = r.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
  }

  /** 잰 시간으로 해상도·품질을 맞춘다 (render/gfx.ts) */
  private tuneGraphics(t: number, intervalMs: number, workMs: number | null) {
    const act = this.gov.push(t, intervalMs, workMs, this.state === "run");
    if (!act) return;
    if (act.tier && act.tier !== this.world.quality) this.world.setQuality(act.tier);
    if (act.scale !== undefined) this.world.setResolutionScale(act.scale);
    if (act.note === "calibrated" || act.note === "down") saveAutoTier(this.gpu, this.gov.tier);
    if (act.note === "down") this.hud.toast(`화면이 끊겨 그래픽을 '${QUALITY_LABELS[this.gov.tier]}'(으)로 낮췄습니다`, 3);
  }

  /** 지금 그래픽 상태 (검수용) */
  get graphics() {
    return { quality: this.world.quality, scale: this.world.resolutionScale, calibrating: this.gov.calibrating, gpu: this.gpu, pixelRatio: this.world.renderer.getPixelRatio() };
  }

  private step(dt: number) {
    const p = this.player;
    const road = this.road;
    const actions = this.input.takeActions();
    if (actions.pause) {
      this.pause();
      return;
    }
    if (actions.signalLeft) this.setSignal(this.signal === -1 ? 0 : -1);
    if (actions.signalRight) this.setSignal(this.signal === 1 ? 0 : 1);
    if (actions.hazard) this.hazard = !this.hazard;
    if (actions.camera) this.hud.toast(`시점: ${CAMERA_LABELS[this.view.cycleMode()]}`, 1.2);
    if (actions.mirrors) {
      this.view.toggleMirrors();
      this.hud.toast(this.view.mirrorsOn ? "거울 크게 보기" : "거울 창 닫기", 1.2);
    }
    if (actions.horn) this.sound.horn();
    if (actions.lka) this.toggleLka();
    if (this.pendingJump && this.t >= this.pendingJump.at) this.doJump();
    if (actions.help) {
      this.state = "pause";
      this.sound.suspend();
      showControls(() => this.resume());
      return;
    }

    if (this.autopilot) this.autopilotUsed = true;
    const c = this.autopilot ? this.autoControls() : this.input.update(dt, p.speed);
    // 주행 중 키보드 ↔ 게임패드·휠을 바꾸면 기록에 남긴다 (조작 장치에 따라 운전이 달라서 분석 때 나눈다)
    if (!this.autopilot && this.input.device !== this.device) {
      this.rules.inputSwitch(this.frameInfo(0), this.device, this.input.device);
      this.device = this.input.device;
    }
    if (!this.autopilot) this.keyboardAssist(c, dt);
    this.laneKeep(c, dt);
    this.controls = c;
    this.t += dt;

    // 물리 (고정 간격)
    this.acc += dt;
    let scraping = 0;
    while (this.acc >= PHYS_DT) {
      p.step(PHYS_DT, road, c);
      this.acc -= PHYS_DT;
      for (const h of p.hits) {
        this.guardrail(h.lateralSpeed, h.side);
        scraping = Math.max(scraping, Math.min(1, h.speed / 20));
        this.scrapeSide = h.side === "left" ? -1 : 1;
      }
      this.workZoneContact();
      if (this.state !== "run") return;
    }
    this.contactCooldown -= dt;
    this.feel(dt, scraping);

    // 교통
    if (this.road.isRoute && !this.city) this.updateLegTraffic();
    const ps = this.playerState();
    this.traffic.update(dt, ps, this.t);
    this.cityTraffic?.update(dt, this.t, this.playerBody());
    this.cutIns(dt, ps);
    this.honks(dt);
    this.collide();
    if (this.state === "run") this.collideCity();
    if (this.state !== "run") return;

    // 방향지시등: 차로를 옮기고 핸들을 풀면 꺼진다. 시내에서는 곧 같은 쪽으로 돌 거면 켜 두고, 돌고 나서 핸들을 풀면 꺼진다
    const lane = road.laneOf(p.d, p.s);
    const st = this.city ? this.stopAhead(p.s) : null;
    const turnDir = st ? (st.turn === "L" ? -1 : st.turn === "R" ? 1 : 0) : 0;
    const turnSoon = !!st && turnDir === this.signal && st.s - p.s < 200;
    if (this.signal !== 0 && !turnSoon && lane !== this.laneForSignal && Math.sign(lane - this.laneForSignal) === this.signal) this.signalCancelAt = this.t + 1.2;
    if (st && turnDir === this.signal && this.signal !== 0 && p.s > st.sExit - 3) this.signalCancelAt = this.t + 0.2;
    this.laneForSignal = lane;
    if (this.signalCancelAt > 0 && this.t >= this.signalCancelAt && Math.abs(c.steer) < 0.12) {
      this.signal = 0;
      this.signalCancelAt = -1;
      this.signalOffAt = this.t;
    }

    // 법규 판정
    const f = this.frameInfo(dt);
    this.rules.update(f, this.traffic.agents);

    // 1초마다 주행 기록
    this.sampleTimer += dt;
    if (this.sampleTimer >= 1) {
      this.sampleTimer -= 1;
      this.recorder.sample(this.t, this.sample(lane));
    }

    const inTunnel = road.structureAt(p.s) === Structure.Tunnel;
    const rc = rumbleContact(road, p.s, p.d, p.spec.width / 2 - 0.12);
    const surface = this.ice.length && iceAt(this.ice, p.s) ? "ice" : this.weather.wet && !inTunnel ? "wet" : "dry";
    // 노면 거칠기: 공사 구간·눈길만 (서서히 바뀐다)
    const rough = roughnessAt(p.s, this.workZones, inTunnel ? 0 : this.weather.snow);
    this.rough += (rough - this.rough) * Math.min(1, dt * 2);
    this.sound.update({
      dt,
      revs: p.revs,
      redline: p.spec.redline,
      throttle: c.throttle,
      brake: c.brake,
      speed: p.speed,
      inTunnel,
      cockpit: this.view.mode === "cockpit",
      slip: p.slip,
      abs: p.abs,
      surface,
      rumble: rc.amount,
      rumbleSide: rc.side,
      scrape: this.scrape,
      scrapeSide: this.scrapeSide,
      rough: this.rough,
    });
    this.sound.traffic(this.nearbyCars(), this.view.mode === "cockpit");
    this.sound.signal(this.signal !== 0 || this.hazard, this.t);
    // 노면요철은 차체가 떨고, 게임패드는 요철·ABS·거친 노면·긁힘으로 운다. 보통 길은 매끈해서 떨지 않는다
    this.view.shake.hum = rc.amount * Math.min(1, p.speed / 10);
    this.view.shake.rough = this.rough;
    const road2 = Math.min(1, p.speed / 25) * this.rough;
    const squeal = Math.max(0, Math.min(1, (p.slip - 0.85) / 0.3));
    this.input.rumble(rc.amount * 0.75 + this.scrape * 0.6 + (p.abs ? 0.25 : 0), road2 * 0.18 + rc.amount * 0.5 + (p.abs ? 0.55 : 0) + squeal * 0.3);

    if (p.s >= this.setup.finishS - 30) this.finish("arrived");
    else if (p.s >= road.length - 40) this.finish("road_end");
    else this.checkDigest();
  }

  /** 요약 주행: 지금 구간 끝을 지나면 다음 구간 앞으로 건너뛴다 (바깥이 어두워지는 동안은 그대로 달린다) */
  private checkDigest() {
    const wins = this.digest;
    if (!wins || this.pendingJump || this.winIdx + 1 >= wins.length) return;
    const p = this.player;
    // 사고 뒤 다시 출발하거나 해서 다음 구간에 이미 들어갔으면 맞춘다
    while (this.winIdx + 1 < wins.length && p.s >= wins[this.winIdx + 1].s0) this.winIdx++;
    const w = wins[this.winIdx];
    if (p.s < w.s1 || this.winIdx + 1 >= wins.length) return;
    this.winIdx++;
    const next = wins[this.winIdx];
    const sec = this.driveTime(p.s, next.s0);
    const span = Math.max(1, this.setup.finishS - this.startS);
    this.fx.cut({
      km: (next.s0 - p.s) / 1000,
      minutes: sec / 60,
      next: this.windowLabel(next),
      clock: clockText(this.settings.hour, this.t + this.clockOffset + sec),
      windows: wins.map((x) => [(x.s0 - this.startS) / span, (x.s1 - this.startS) / span]),
      current: this.winIdx,
    });
    this.pendingJump = { to: next.s0, at: this.t + 0.38, sec };
  }

  /** 건너뛴 길을 제한속도(악천후 감속 포함)로 달렸다면 걸렸을 시간 (초). 시내·국도는 신호 교차로마다 평균 20초 기다린다 */
  private driveTime(a: number, b: number): number {
    let sec = 0;
    for (let s = a; s < b; s += 200) sec += Math.min(200, b - s) / (Math.max(30, this.rules.limitAt(s)) / 3.6);
    if (this.city) sec += 20 * this.stops.filter((x) => x.signal && x.s >= a && x.s < b).length;
    return sec;
  }

  /** 시내 출발 차로: 맨 오른쪽에서 나서되, 앞에서 돌아야 하면 100m에 한 차로씩 옮길 수 있는 만큼 그쪽 차로에서 */
  private cityLane(s: number): number {
    const lanes = this.road.lanesAt(s);
    const next = this.laneTargets.find((x) => x.s > s);
    return next ? Math.max(1, Math.min(lanes, next.lanes[1] + Math.floor((next.s - s) / 100))) : lanes;
  }

  /** 건너뛴 뒤 달릴 곳 설명 */
  private windowLabel(w: DriveWindow): string {
    const road = this.road;
    const km = (m: number) => `${(m / 1000).toFixed(1)}km`;
    if (w.why === "finish") return `${this.setup.destName} 도착 ${km(this.setup.finishS - w.s0)} 앞`;
    if (w.why === "transfer") {
      const k = road.legs.findIndex((_, i) => i > 0 && road.legs[i - 1].s1 > w.s0 && road.legs[i - 1].s1 <= w.s1);
      if (k > 0) {
        const l = road.legs[k];
        return `${l.via || "분기점"} ${km(road.legs[k - 1].s1 - w.s0)} 앞 · ${l.name} ${l.to} 방향으로 갈아타기`;
      }
    }
    const leg = road.legAt(w.s0);
    if (this.city) {
      const st = this.stops.find((x) => x.s > w.s0 && x.name);
      return st && st.s - w.s0 < 1500 ? `${leg.name} · ${st.name} ${km(st.s - w.s0)} 앞` : `${leg.name}`;
    }
    const j = road.junctions.find((x) => x.s > w.s0 + 300);
    return j ? `${leg.name} · ${j.name} ${km(j.s - w.s0)} 앞` : `${leg.name} ${leg.to} 방향`;
  }

  /** 바깥이 다 어두워졌을 때: 다음 구간 시작으로 옮기고 주변 교통·도로를 새로 만든다 */
  private doJump() {
    const j = this.pendingJump!;
    this.pendingJump = null;
    const road = this.road;
    const p = this.player;
    this.rules.skip(this.frameInfo(0), j.to, j.sec);
    this.clockOffset += j.sec;
    const s = j.to;
    const lanes = road.lanesAt(s);
    // 시내: 다음에 돌 차로 쪽에 내려앉고, 제한속도 넘게는 달리지 않는다 (정지선이 60m 넘게 앞이다)
    let lane = this.city ? this.cityLane(s) : Math.max(1, Math.min(lanes, road.laneOf(p.d, p.s)));
    const zone = this.workZones.find((z) => z.lane === lane && s > z.s0 - 50 && s < z.s1 + END_TAPER_M);
    if (zone) lane = Math.max(1, Math.min(lanes, zone.side === "right" ? lane - 1 : lane + 1));
    const kmh = this.city ? Math.max(20, Math.min(p.speed * 3.6, this.rules.limitAt(s))) : Math.max(30, Math.min(p.speed * 3.6, this.rules.limitAt(s) + 5, this.spec.governor * 3.6 - 5));
    p.place(road, s, lane, kmh / 3.6);
    // 노선이 바뀌었으면 그 노선 교통량으로 맞춘 다음 주변 차를 새로 채운다. 속도는 주변 흐름에 맞춘다.
    // 시내는 경로 밖 차·교차로를 건너는 차를 비우고 새 자리 둘레로 다시 채운다
    if (road.isRoute && !this.city) this.updateLegTraffic();
    if (this.cityTraffic) this.cityTraffic.clearAround(0, 0, Infinity);
    this.traffic.fill(this.playerState());
    const near = this.traffic.agents.filter((a) => Math.abs(a.s - s) < 400);
    if (near.length >= 3 && !this.city) {
      const flow = (near.reduce((sum, a) => sum + a.v, 0) / near.length) * 3.6;
      p.place(road, s, lane, Math.max(20, Math.min(kmh, flow * 1.05)) / 3.6);
    }
    this.updateOrigin();
    this.chunks.prime(p.s);
    this.axleS = [NaN, NaN];
    this.lastGear = p.gear;
    this.acc = 0;
    this.scrape = 0;
    this.signal = 0;
    this.signalCancelAt = -1;
    this.laneForSignal = lane;
    this.autoLane = 0;
    this.autoLcTo = 0;
    this.lkaSide = 0;
    this.honked.clear();
    this.fx.reveal();
  }

  private toggleLka() {
    this.lka = !this.lka;
    this.lkaSide = 0;
    this.hud.toast(this.lka ? "차로 유지 보조 켜짐" : "차로 유지 보조 꺼짐", 1.4);
    this.rules.lkaToggle(this.frameInfo(0), this.lka);
  }

  /**
   * 갑자기 끼어들기 (한국 고속도로에서 흔한 당황스러운 순간): 달린 시간 1~2.5분마다 한 번, 옆 차로 차가 바로 앞으로 들어온다
   * (Traffic.cutIn). 시속 50km 아래·자동 운전·연결로에서는 쉬고, 들어올 차가 없으면 1초 뒤 다시 찾는다.
   * 판정이 아니라 기록용 사건(cut_in)이고, 뒤 5초 안의 아차사고·충돌에는 cause가 붙는다.
   * 언제 일어날지는 달린 시간으로만 정한다 (실제 사고 자료는 보지 않는다).
   */
  private cutIns(dt: number, ps: PlayerState) {
    const p = this.player;
    if (this.city || this.autopilot || p.speed < CUT_IN.minKmh / 3.6 || this.road.onConnector(p.s)) return;
    this.cutInTimer -= dt;
    if (this.cutInTimer > 0) return;
    const r = this.traffic.cutIn(ps);
    if (!r) {
      this.cutInTimer = 1;
      return;
    }
    this.cutInTimer = CUT_IN.every[0] + this.eventRng.next() * (CUT_IN.every[1] - CUT_IN.every[0]);
    this.rules.cutIn(this.frameInfo(0), {
      other: r.agent.type.id,
      profile: r.agent.profileId,
      fromLane: r.fromLane,
      gapM: Math.round(r.gapM * 10) / 10,
      dvKmh: Math.round(r.dvKmh),
      signaled: r.signaled,
    });
  }

  /** 차로 유지 보조 상태 (계기판 표시) */
  get lkaState(): LkaState {
    if (!this.lka) return "off";
    if (this.lkaWarn > 0) return "warn";
    return this.player.speed >= LKA.minKmh / 3.6 ? "ready" : "standby";
  }

  /** 경고 중이면 넘으려던 쪽 (-1 왼쪽, 1 오른쪽) */
  get lkaWarnSide(): number {
    return this.lkaWarn > 0 ? this.warnSide : 0;
  }

  /**
   * 차로 유지 보조 (sim/assist.ts): 넘으려 하면 경고음·계기판 경고·진동을 주고 운전대를 살짝 돌려 되돌린다.
   * 자동 운전·후진·연결로·갓길에서는 쉬고, 방향지시등을 켜 두었거나 끈 지 2초 안에도 쉰다.
   */
  private laneKeep(c: Controls, dt: number) {
    this.lkaWarn = Math.max(0, this.lkaWarn - dt);
    const p = this.player;
    const road = this.road;
    const lane = road.laneOf(p.d, p.s);
    const idle =
      !this.lka ||
      this.autopilot ||
      p.speed < LKA.minKmh / 3.6 ||
      c.reverse ||
      this.signal !== 0 ||
      this.t - this.signalOffAt < LKA.signalHold ||
      road.onConnector(p.s) ||
      lane < 1 ||
      lane > road.lanesAt(p.s);
    const out = idle
      ? null
      : laneKeep({
          d: p.d,
          ddot: -(p.vx * Math.sin(p.theta) + p.vy * Math.cos(p.theta)),
          center: road.laneCenter(lane, p.s),
          laneWidth: road.laneWidth,
          carWidth: p.spec.width,
          steer: c.steer,
        });
    if (!out || !out.side) {
      // 경고가 끝날 때까지는 같은 쪽으로 다시 막아도 새로 울리지 않는다 (선 근처에서 띠띠띠가 연달아 나지 않게)
      if (!out || this.lkaWarn <= 0) this.lkaSide = 0;
      return;
    }
    const { side, intended } = out;
    c.steer = out.steer;
    this.lkaWarn = LKA.warnHold;
    this.warnSide = side;
    if (this.lkaSide !== side) {
      this.lkaSide = side;
      this.sound.laneWarn(side);
      this.input.pulse(0.3, 0.55, 160);
      this.rules.lkaAssist(this.frameInfo(0), side > 0 ? "right" : "left", !intended);
    }
  }

  /**
   * 주행감: 변속 소리, 신축이음 덜컥(앞바퀴·뒷바퀴), 벽 긁힘 소리·불똥. 판정·기록에는 쓰지 않는다.
   * scraping: 이번 프레임에 벽에 닿은 정도 (0~1)
   */
  private feel(dt: number, scraping: number) {
    const p = this.player;
    if (p.gear !== this.lastGear) {
      this.sound.shift(p.gear > this.lastGear);
      this.lastGear = p.gear;
    }
    // 신축이음: 앞바퀴와 뒷바퀴가 지날 때마다 한 번씩
    const axles: [number, number] = [p.s + p.spec.lf, p.s - p.spec.lr];
    const speedK = Math.min(1, p.speed / 25);
    for (let k = 0; k < 2; k++) {
      const prev = this.axleS[k];
      const cur = axles[k];
      if (Number.isFinite(prev) && cur > prev && cur - prev < 30) {
        for (const j of this.joints) {
          if (j.s <= prev) continue;
          if (j.s > cur) break;
          const kk = j.strength * speedK * (this.spec.vehicleClass === "car" ? 1 : 0.8);
          if (kk < 0.05) continue;
          this.sound.thump(kk);
          this.view.bump(kk, k === 0);
          this.input.pulse(0.55 * kk, 0.35 * kk, 90);
        }
      }
      this.axleS[k] = cur;
    }
    // 벽 긁힘: 닿는 동안 이어지고 떨어지면 금방 잦아든다
    this.scrape = Math.max(scraping, this.scrape * Math.exp(-dt * 6));
    // 벽에 붙어 달리는 동안(닿았다 떨어졌다 해도) 불똥이 끊기지 않게 긁힘 값으로 뿌린다
    if (this.scrape > 0.15 && p.speed > 4) {
      this.view.shake.add(dt * 1.2 * this.scrape);
      this.sparkDebt += dt * p.speed * 24 * Math.max(0.4, this.scrape);
      const n = Math.floor(this.sparkDebt);
      if (n > 0) {
        this.sparkDebt -= n;
        const car = this.view.car;
        const side = this.scrapeSide;
        // 닿는 곳은 차 옆면 앞쪽 절반 (모서리부터 긁힌다)
        const x = p.spec.length / 2 - 0.3 - Math.random() * 0.45 * p.spec.length;
        const lift = 0.3 + Math.random() * 0.25;
        const at = this.sparks.worldPoint(car, x, lift, side * (p.spec.width / 2 + 0.08)).clone();
        const yaw = this.world.heading;
        const dir = this.tmpDir.set(Math.cos(yaw), 0, -Math.sin(yaw));
        const out = this.tmpOut.set(-side * Math.sin(yaw), 0, -side * Math.cos(yaw));
        this.sparks.emit(at, dir, p.speed, out, Math.min(24, n), at.y - lift);
      }
    } else this.sparkDebt = 0;
  }

  /** 가까운 차 (소리용, 가까운 순서)와 옆 대형차 풍압 */
  private nearbyCars(): NearbyCar[] {
    const p = this.player;
    const vp = p.vx * Math.cos(p.theta);
    const out = this.nearby;
    out.length = 0;
    let buffet = 0;
    const add = (a: Agent, opposite: boolean) => {
      const s = opposite ? -a.s : a.s;
      const dx = s - p.s;
      if (Math.abs(dx) > 70) return;
      const dy = a.d - p.d;
      const r = Math.hypot(dx, dy);
      const va = opposite ? -a.v : a.v;
      const dv = va - vp;
      const vr = r > 0.1 ? (dx * dv) / r : 0;
      const heavy = a.heavy || a.len > 7;
      if (!a.parked) out.push({ dx, dy, vr, v: a.v, heavy });
      // 대형차 옆을 지나면 공기에 밀린다 (차가 나란할 때, 가까울수록·빠를수록)
      if (heavy && Math.abs(dy) < 7) {
        const along = Math.exp(-((dx / (a.len / 2 + 4)) ** 2));
        const near = 1 / (1 + ((Math.abs(dy) - 2.2) / 1.6) ** 2);
        const push = Math.min(1, (Math.abs(dv) * 0.6 + a.v * 0.25) / 22);
        buffet += -Math.sign(dy) * along * near * push * (opposite ? 0.5 : 1);
      }
    };
    for (const a of this.traffic.agents) add(a, false);
    for (const a of this.traffic.opposite) add(a, true);
    // 시내: 경로 밖 차 (교차로를 건너는 차)는 내 차 기준 앞뒤·옆으로
    if (this.cityTraffic) {
      const pb = this.playerBody();
      this.cityTraffic.forEachFree((x, y, hx, hy, a) => {
        const rx = x - pb.x;
        const ry = y - pb.y;
        const dx = rx * pb.hx + ry * pb.hy;
        const dy = rx * pb.hy - ry * pb.hx;
        if (Math.abs(dx) > 70 || Math.abs(dy) > 70) return;
        const r = Math.hypot(dx, dy);
        const rvx = hx * a.v - pb.hx * pb.v;
        const rvy = hy * a.v - pb.hy * pb.v;
        out.push({ dx, dy, vr: r > 0.1 ? (rx * rvx + ry * rvy) / r : 0, v: a.v, heavy: a.heavy || a.len > 7 });
      });
    }
    out.sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy));
    this.view.shake.buffet = Math.max(-1, Math.min(1, buffet));
    return out;
  }

  /** 내가 끼어들거나 급히 서서 뒤차가 세게 브레이크를 밟으면, 뒤차가 경적을 울리기도 한다 (한 차에 한 번) */
  private honks(dt: number) {
    this.hornCooldown -= dt;
    for (const [id, t] of this.honked) if (this.t - t > 20) this.honked.delete(id);
    if (this.hornCooldown > 0) return;
    const p = this.player;
    for (const a of this.traffic.agents) {
      if (!(a.brakedByPlayer > 0 && this.t - a.brakedByPlayer < 0.2) || this.honked.has(a.id)) continue;
      this.honked.set(a.id, this.t);
      if (Math.random() > 0.55) continue;
      const dx = a.s - p.s;
      const dy = a.d - p.d;
      const r = Math.hypot(dx, dy);
      this.sound.hornFrom(dy / (Math.abs(dy) + 3 + Math.abs(dx) * 0.2), r, a.heavy, a.acc < -6);
      this.hornCooldown = 5;
      return;
    }
  }

  private setSignal(dir: -1 | 0 | 1) {
    if (dir === 0 && this.signal !== 0) this.signalOffAt = this.t;
    this.signal = dir;
    this.signalCancelAt = -1;
  }

  private frameInfo(dt: number): PlayerFrame {
    const p = this.player;
    return { t: this.t, dt, s: p.s, d: p.d, speed: p.speed, ax: p.ax, width: p.spec.width, len: p.spec.length, signal: this.signal, hazard: this.hazard };
  }

  private sample(lane: number): Sample {
    const p = this.player;
    const c = this.controls;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const fin = (x: number) => (Number.isFinite(x) ? r2(x) : null);
    let near = 0;
    // 주변 차 흐름: 앞뒤 200m 안 같은 방향으로 움직이는 차의 평균 속도 (3대 미만이면 모름). 데이터 품질 검사가 정체를 알아보는 데 쓴다
    let flowN = 0;
    let flowSum = 0;
    for (const a of this.traffic.agents) {
      const ds = Math.abs(a.s - p.s);
      if (ds < 50) near++;
      if (ds < 200 && !a.parked) {
        flowN++;
        flowSum += a.v;
      }
    }
    const flow = flowN >= 3 ? Math.round((flowSum / flowN) * 36) / 10 : null;
    return [
      r2(this.t),
      Math.round(p.s * 10) / 10,
      r2(p.d),
      lane,
      Math.round(p.speed * 36) / 10,
      r2(p.ax),
      r2(p.ay),
      fin(this.rules.headway),
      fin(this.rules.ttc),
      this.hazard ? 2 : this.signal,
      r2(c.steer),
      r2(c.throttle),
      r2(c.brake),
      this.rules.limitAt(p.s),
      near,
      flow,
      this.road.lanesAt(p.s),
    ];
  }

  /** 앞뒤·옆 차와 부딪혔는지 */
  private collide() {
    const p = this.player;
    const P = this.playerState();
    const ddot = -(p.vx * Math.sin(p.theta) + p.vy * Math.cos(p.theta));
    for (const a of this.traffic.agents) {
      const ds = a.s - P.s;
      const overS = (a.len + P.len) / 2 - Math.abs(ds);
      if (overS <= 0) continue;
      const dd = a.d - P.d;
      const overD = (a.width + P.width) / 2 - Math.abs(dd);
      if (overD <= 0) continue;
      const rear = overS < overD * 1.5;
      const rel = rear ? Math.abs(P.v - a.v) : Math.abs(ddot) + Math.abs(P.v - a.v) * 0.3;
      const kmh = rel * 3.6;
      if (this.contactCooldown <= 0) {
        this.rules.crash(this.frameInfo(0), `${a.type.id}${rear ? (ds > 0 ? ":rear" : ":hit_from_behind") : ":side"}`, kmh);
        this.contactCooldown = 1;
      }
      if (kmh >= SERIOUS_KMH) {
        a.v = 0;
        a.hazard = true;
        this.crashed(`${a.type.name}${josa(a.type.name, "와", "과")} 충돌`, kmh);
        return;
      }
      // 가벼운 접촉: 밀어내고 속도를 나눈다
      if (rear) {
        if (ds > 0) {
          p.s = a.s - (a.len + P.len) / 2 - 0.05;
          p.vx = Math.min(p.vx, Math.max(0, a.v - 0.5));
          a.v += rel * 0.3;
        } else {
          a.s = p.s - (a.len + P.len) / 2 - 0.05;
          a.v = Math.max(0, Math.min(a.v, P.v - 0.5));
          p.vx += rel * 0.3;
        }
      } else {
        p.d = a.d - Math.sign(dd || 1) * ((a.width + P.width) / 2 + 0.05);
        p.vy = 0;
        p.theta *= 0.5;
        p.r *= 0.5;
      }
      this.sound.crash(0.25, Math.sign(dd) || 0);
      this.view.shake.add(0.35);
      this.fx.flash(0.35);
      this.input.pulse(0.6, 0.4, 160);
      this.hud.toast("접촉", 1.2);
    }
  }

  /** 시내: 교차로를 건너는 차·경로 밖 차와 부딪혔는지 */
  private collideCity() {
    const ct = this.cityTraffic;
    if (!ct) return;
    const p = this.player;
    const pb = this.playerBody();
    const a = ct.hit(pb);
    if (!a) {
      this.cityTouch = null;
      return;
    }
    const [vx, vy] = ct.velocityOf(a);
    const kmh = Math.hypot(pb.hx * pb.v - vx, pb.hy * pb.v - vy) * 3.6;
    // 같은 차와 계속 맞닿아 있는 것은 한 번의 접촉이다. 둘 다 선 채 3초가 지나면 (서로 비켜 주기를 기다리는 교착) 그 차를 먼저 보낸다
    const again = this.cityTouch?.a === a;
    if (!again) this.cityTouch = { a, since: this.t };
    else if (kmh < 3 && this.t - this.cityTouch!.since > 3) {
      ct.letGo(a);
      this.cityTouch = null;
      return;
    }
    if (this.contactCooldown <= 0 && !again) {
      this.rules.crash(this.frameInfo(0), `${a.type.id}:crossing`, kmh);
      this.contactCooldown = 1;
    }
    a.v = 0;
    if (kmh >= SERIOUS_KMH) {
      a.hazard = true;
      this.crashed(`${a.type.name}${josa(a.type.name, "와", "과")} 충돌`, kmh);
      return;
    }
    // 가벼운 접촉: 내 차를 세운다
    p.vx = Math.min(p.vx, 0.3);
    p.vy = 0;
    this.sound.crash(0.25, 0);
    this.view.shake.add(0.35);
    this.fx.flash(0.35);
    this.input.pulse(0.6, 0.4, 160);
    this.hud.toast("접촉", 1.2);
  }

  /** 공사 구간 라바콘 줄을 넘으면: 빠르면 충돌, 느리면 되돌린다 */
  private workZoneContact() {
    const p = this.player;
    const half = p.spec.width / 2;
    for (const z of this.workZones) {
      const line = coneLine(this.road, z, p.s);
      if (line === null) continue;
      const over = z.side === "right" ? p.d + half - line : line - (p.d - half);
      if (over <= 0.15) continue;
      const kmh = p.speed * 3.6;
      if (this.contactCooldown <= 0) {
        this.rules.crash(this.frameInfo(0), "work_zone", kmh);
        this.contactCooldown = 1;
        this.sound.crash(Math.min(1, kmh / 40));
      }
      if (kmh >= 30) {
        this.crashed("공사 구간 라바콘·작업 차량 충돌", kmh);
        return;
      }
      p.d += z.side === "right" ? -(over - 0.15) : over - 0.15;
      p.vy = 0;
      this.hud.toast("라바콘에 닿았습니다", 1.2);
    }
  }

  private guardrail(lateral: number, side: "left" | "right") {
    const kmh = lateral * 3.6;
    if (kmh < 4) return;
    // 시내는 보도 연석, 넓은 중앙분리대 (한 줄 왕복 도로는 반대편 차도 너머 연석)
    const s = this.player.s;
    const curb = !!this.city && (side === "right" || !this.road.hardMedianAt(s) || this.road.medianAt(s) < 1);
    const what = curb ? "연석" : side === "left" ? "중앙분리대" : "가드레일";
    if (this.contactCooldown <= 0) {
      this.rules.crash(this.frameInfo(0), curb ? "curb" : side === "left" ? "median_barrier" : "guardrail", kmh);
      this.contactCooldown = 1;
      this.sound.crash(Math.min(1, kmh / 40), side === "left" ? -1 : 1);
      this.view.shake.add(Math.min(0.6, kmh / 50));
      this.input.pulse(Math.min(1, kmh / 30), 0.5, 150);
    }
    if (kmh >= SERIOUS_KMH + 5) this.crashed(`${what} 충돌`, kmh);
    else this.hud.toast(`${what}에 닿았습니다`, 1.2);
  }

  private crashed(what: string, kmh: number) {
    if (this.state !== "run") return;
    this.state = "crash";
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.r = 0;
    this.sound.crash(1, this.scrapeSide);
    // 부딪힌 순간: 화면이 크게 흔들리고 붉게 번쩍인 뒤, 잠깐 멈췄다가 안내 창을 띄운다
    this.view.shake.add(1);
    this.fx.flash(1);
    this.input.pulse(1, 1, 450);
    setTimeout(() => {
      if (this.state !== "crash") return;
      showDialog("충돌", `${what} · 충돌 속도 약 ${Math.round(kmh)}km/h. 충돌은 기록에 남습니다.`, [
        { label: "이어서 달리기 (Enter)", primary: true, key: "Enter", onClick: () => this.respawn() },
        { label: "주행 끝내기", onClick: () => this.finish("crash") },
      ]);
    }, 850);
  }

  private respawn() {
    const road = this.road;
    const p = this.player;
    const s = Math.min(road.length - 100, p.s + 30);
    const lanes = road.lanesAt(s);
    let lane = Math.max(1, Math.min(lanes, road.laneOf(p.d, p.s)));
    // 공사로 막힌 차로면 옆 차로에서 다시 출발
    const zone = this.workZones.find((z) => z.lane === lane && s > z.s0 - 50 && s < z.s1 + END_TAPER_M);
    if (zone) lane = zone.side === "right" ? lane - 1 : lane + 1;
    this.traffic.clearAround(s, 300);
    p.place(road, s, lane, this.city ? 0 : 50 / 3.6);
    if (this.cityTraffic) {
      const pb = this.playerBody();
      this.cityTraffic.clearAround(pb.x, pb.y, 80);
    }
    this.axleS = [NaN, NaN];
    this.lastGear = p.gear;
    this.hazard = false;
    this.acc = 0;
    this.last = performance.now();
    this.state = "run";
  }

  finish(reason: string) {
    if (this.state === "end") return;
    this.state = "end";
    this.sound.suspend();
    if (reason === "arrived") this.sound.say("목적지에 도착했습니다. 경로 안내를 종료합니다.", true);
    this.hud.visible = false;
    this.fx.visible = false;
    if (this.view.mirrorsOn) this.view.toggleMirrors();
    const f = this.frameInfo(0);
    this.rules.finish(f);
    const summary = this.rules.summary;
    const quality = this.assessQuality();
    const upload: Promise<UploadStatus> = this.recorder.finish(summary, reason, quality);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    showReport(
      {
        summary,
        events: this.rules.events,
        reason,
        roadLabel: `${this.setup.originName} → ${this.setup.destName}${this.weather.kind === "clear" ? "" : ` · ${this.weather.label}`}`,
        upload,
        quality,
        exportJson: () => this.recorder.exportJson(summary, quality),
        fileName: `drip_${this.road.id.replace(/[^\w가-힣-]+/g, "_")}_${stamp}.json`,
        urban: !!this.city,
      },
      () => {
        sessionStorage.setItem("drip_retry", JSON.stringify(this.settings));
        location.reload();
      },
      () => location.reload(),
    );
  }

  /**
   * 연구 데이터 품질 검사 (data_quality.json). 이번 주행과, 최근 주행이 여러 번 걸러진 참여자(브라우저)를 거른다.
   * 참여자 기록은 동의했을 때만 남긴다 (올리지 않는 사람을 추적하지 않게).
   */
  private assessQuality(): QualityResult {
    const q = assessSession(SAMPLE_COLUMNS, this.recorder.samples, this.rules.events, this.cfg.quality);
    if (this.autopilotUsed) {
      q.reasons.push("autopilot");
      q.ok = false;
    }
    if (!this.settings.consent || this.autopilotUsed) return q;
    const h = updateParticipant(loadParticipant(), q.ok, this.cfg.quality);
    saveParticipant(h);
    if (h.flagged && q.ok) {
      q.reasons.push("participant");
      q.ok = false;
    }
    return q;
  }

  /** 키보드 조향 보조 ("곡선에서 핸들 유지"): 조향 키를 놓으면 차 방향을 도로 방향에 맞추고 굽은 길은 그 굽이만큼 핸들을 잡는다 (차로 위치는 그대로).
   *  키보드는 반대로 꺾어 바로잡기가 어려워서 넣는다. 마우스·게임패드·휠에는 쓰지 않는다.
   *  시내 교차로에서 도는 곳은 운전자가 직접 돌린다 (놓아도 저절로 돌지 않게 그동안은 풀어 둔다). */
  private keyboardAssist(c: Controls, dt: number) {
    if (!this.steerHold || this.input.mode !== "keyboard" || this.input.steeringKeyDown) {
      this.assistWeight = 0;
      return;
    }
    const p = this.player;
    const kappa = this.road.sample(p.s).kappa;
    const turning = Math.abs(kappa) > 1 / 200 && this.turnBoxAt(p.s);
    this.assistWeight = turning ? Math.max(0, this.assistWeight - dt / 0.3) : Math.min(1, this.assistWeight + dt / 0.3);
    if (this.assistWeight <= 0) return;
    const sp = p.spec;
    const v = Math.max(3, p.vx);
    const L = sp.lf + sp.lr;
    const K = (sp.mass * sp.lr) / L / sp.cf - (sp.mass * sp.lf) / L / sp.cr; // 언더스티어 계수
    // 차가 실제로 가는 방향(차 방향 + 옆미끄럼)과 길 방향의 차이. 차 방향만 맞추면 굽은 길에서 바깥으로 밀린다
    const course = p.theta + p.vy / v;
    // 바퀴각(왼쪽 +) = 굽은 길 따라가기 (L+Kv²)κ − 진행 방향 오차를 1초에 줄이기 (L+Kv²)·course/v.
    // 조향 입력은 오른쪽이 +라서 부호를 뒤집는다.
    const wheel = (L + K * v * v) * (kappa - course / (v * 1.0));
    const assist = Math.max(-0.5, Math.min(0.5, -wheel / sp.maxSteer));
    c.steer += assist * this.assistWeight;
  }

  /** 시내: s가 (갈라지기·합치기만 하는 곳이 아닌) 교차로 안인지 */
  private turnBoxAt(s: number): boolean {
    const boxes = this.road.city?.boxes;
    if (!boxes) return false;
    for (const [s0, s1, , minor] of boxes) if (!minor && s >= s0 && s <= s1) return true;
    return false;
  }

  /** 검수용: 화면이 가려져 requestAnimationFrame이 멈춰도 시뮬레이션을 sec초 진행하고 한 번 그린다 */
  advance(sec: number, fps = 30) {
    const dt = 1 / fps;
    const t0 = performance.now();
    for (let i = 0; i < sec * fps && this.state === "run"; i++) {
      this.step(dt);
      if (i % 10 === 0) {
        this.updateOrigin();
        this.chunks.update(this.player.s, 4);
      }
    }
    this.draw(dt);
    return { ms: Math.round(performance.now() - t0), s: this.player.s, kmh: this.player.speed * 3.6, state: this.state };
  }

  /** 검수용: 한 프레임 그리는 데 걸리는 시간(ms) */
  timeDraw(n = 10) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.draw(1 / 60);
    const gl = this.world.renderer.getContext();
    gl.finish();
    return { msPerFrame: (performance.now() - t0) / n, calls: this.world.renderer.info.render.calls, triangles: this.world.renderer.info.render.triangles };
  }

  /** 검수·데모용 자동 운전: 차로 중앙 유지 + 앞차 따라가기 */
  private autoControls(): Controls {
    const p = this.player;
    const road = this.road;
    const lanes = road.lanesAt(p.s);
    if (!this.autoLane) this.autoLane = Math.max(1, Math.min(lanes, road.laneOf(p.d, p.s)));
    if (this.autoLane > lanes) this.autoLane = lanes;
    // 시내: 450m 앞 교차로·갈림길에서 경로로 가는 차로로, 신호가 빨간불이면(노란불에 설 수 있으면) 정지선 앞에 선다
    let stopGap = Infinity;
    const st = this.city ? this.stopAhead(p.s) : null;
    const tgt = this.city ? this.laneTargets.find((x) => x.s > p.s) : undefined;
    // 차로 옮기기: 앞에서 차로가 줄면 그 전에, 시내는 앞 교차로·갈림길에서 경로로 가는 차로로 (500m 앞부터, 여러 차로면 더 일찍).
    // 한 번에 한 차로씩, 방향지시등을 켜고 (시내 30m, 고속도로 100m) 넘게 간 뒤 옆 차로가 비었을 때 옮긴다
    const cur = road.laneOf(p.d, p.s);
    let squeeze = false; // 꼭 옮겨야 하는데 옆 차로가 막혔다: 속도를 줄여 틈을 만든다
    if (cur === this.autoLane && cur >= 1 && cur <= lanes) {
      let fit = lanes;
      let drop = Infinity; // 지금 차로가 없어지는 곳까지
      for (let x = 20; x <= (this.city ? 200 : 600); x += 20) {
        const s = p.s + x;
        if (s >= road.length || (this.city && road.inJunction(s))) break;
        fit = Math.min(fit, road.lanesAt(s));
        if (fit < cur && drop === Infinity) drop = x;
      }
      // 옮길 차로가 많을수록 일찍 (한 차로에 200m씩 더)
      const need = tgt ? Math.max(tgt.lanes[0], Math.min(tgt.lanes[1], cur)) : cur;
      const want = Math.min(fit, tgt && tgt.s - p.s < 300 + 200 * Math.abs(need - cur) ? need : cur);
      const next = cur + Math.sign(want - cur);
      if (next === cur) this.autoLcTo = 0;
      else if (this.autoLcTo !== next) {
        this.autoLcTo = next;
        this.autoLcS = p.s;
      } else if (p.s - this.autoLcS > (this.city ? 32 : 110)) {
        if (this.laneClear(next, p.s)) this.autoLane = next;
        else squeeze = drop < (this.city ? 120 : 250) || (!!tgt && tgt.s - p.s < 300);
      }
    }
    // 방향지시등: 차로를 옮길 때 (차로가 갑자기 줄어 차도 밖에 남았으면 차도 쪽으로), (시내) 돌기 60m 앞부터
    const to = cur < 1 || cur > lanes ? Math.max(1, Math.min(lanes, cur)) : this.autoLane !== cur ? this.autoLane : this.autoLcTo;
    const want = to && to !== cur ? Math.sign(to - cur) : st && st.turn !== "S" && st.s - p.s < 60 ? (st.turn === "L" ? -1 : 1) : 0;
    if (want && this.signal !== want) this.setSignal(want as -1 | 1);
    if (this.city) {
      const gap = st ? st.s - 1 - (p.s + p.spec.length / 2) : Infinity;
      if (st?.signal && gap > -1) {
        const go = this.city.signals.go(st.junction, st.link, st.turn, this.signalClock);
        const canStop = (p.speed * p.speed) / (2 * 3) < gap;
        if (go === "stop" || (go === "yellow" && canStop)) stopGap = Math.max(0.1, gap);
        // 적색 우회전: 정지선에 멈춘 뒤 2초 기다렸다가 돈다
        if (go === "stop" && st.turn === "R") {
          if (p.speed < 0.3 && gap < 4 && this.autoHoldAt < 0) this.autoHoldAt = this.t;
          if (this.autoHoldAt >= 0 && this.t - this.autoHoldAt > 2) stopGap = Infinity;
        }
      }
      if (gap < -1 || !st) this.autoHoldAt = -1;
      // 앞을 막은 경로 밖 차 (교차로를 건너는 차, 방금 빠져나간 차)
      if (this.cityTraffic) {
        const pb = this.playerBody();
        const g = Math.min(
          this.cityTraffic.gapAhead(pb.x, pb.y, pb.hx, pb.hy, pb.len, pb.w, 50),
          // 교차로를 아직 건너고 있는 차와 길이 엇갈리면 기다린다
          this.cityTraffic.yieldGap(pb.x, pb.y, pb.hx, pb.hy, pb.len, pb.w, pb.v, road.inJunction(p.s)),
        );
        if (g < stopGap) stopGap = Math.max(0.1, g);
      }
    }
    const v = Math.max(p.vx, 1);
    const Ld = this.city ? Math.max(6, v * 1.1) : Math.max(12, v * 1.1);
    const dT = road.laneCenter(this.autoLane, Math.min(road.length - 1, p.s + Ld));
    const k = road.sample(p.s).kappa;
    const y = -(dT - p.d) + (k * Ld * Ld) / 2;
    const alpha = Math.atan2(y, Ld) - p.theta;
    const L = p.spec.lf + p.spec.lr;
    const delta = Math.atan((2 * L * Math.sin(alpha)) / Ld);
    let lead: Agent | null = null;
    let gap = Infinity;
    for (const a of this.traffic.agents) {
      // 가려는 차로의 차, 그리고 차로를 옮기는 중에도 아직 내 앞을 막고 있는 차
      if (a.lane !== this.autoLane && a.targetLane !== this.autoLane && Math.abs(a.d - p.d) > (a.width + p.spec.width) / 2 + 0.3) continue;
      const g = a.s - a.len / 2 - (p.s + p.spec.length / 2);
      if (g > -1 && g < gap) {
        gap = g;
        lead = a;
      }
    }
    // 제한속도(공사 구간·악천후 감속 포함)보다 조금 낮게, 미끄러우면 굽은 길에서 더 천천히
    let v0 = (this.rules.limitAt(p.s) - 5) / 3.6;
    // 제한속도가 낮아지는 곳은 미리 1m/s²로 줄여 표지판에서 맞춘다
    for (let x = 25; x <= 250; x += 25) {
      const lim = (this.rules.limitAt(Math.min(road.length - 1, p.s + x)) - 5) / 3.6;
      if (lim < v0) v0 = Math.min(v0, Math.sqrt(lim * lim + 2 * x));
    }
    if (squeeze) v0 *= 0.6;
    const grip = p.grip(p.speed * 3.6);
    let vc = v0;
    if (this.city) {
      // 교차로 회전: 80m 안의 가장 굽은 곳에 맞춰 (1.5m/s²로 줄여 가며) 속도를 정한다
      for (let x = 0; x <= 80; x += 4) {
        const k = Math.abs(road.sample(Math.min(road.length - 1, p.s + x)).kappa);
        if (k > 1e-4) vc = Math.min(vc, Math.sqrt((2.5 * grip) / k + 2 * 1.5 * x));
      }
    } else {
      const kk = Math.abs(road.sample(Math.min(road.length - 1, p.s + 120)).kappa);
      if (kk > 1e-4) vc = Math.min(v0, Math.sqrt((2.5 * grip) / kk));
    }
    // 정지선은 서 있는 앞차로 본다
    let leadV = lead ? lead.v : 0;
    let leadGap = gap;
    if (stopGap < leadGap) {
      leadGap = stopGap;
      leadV = 0;
    }
    const has = Number.isFinite(leadGap);
    const sStar = (this.city ? 1.5 : 3) + Math.max(0, v * (this.city ? 1.2 : 1.6) + (has ? (v * (v - leadV)) / (2 * Math.sqrt(2 * 2)) : 0));
    const free = 2 * (1 - (v / Math.max(0.5, vc)) ** 4);
    let accel = free - (has ? 2 * (sStar / Math.max(0.5, leadGap)) ** 2 : 0);
    // ACC (Kesting·Treiber 2010): 앞으로 끼어든 차가 더 빠르거나 조금만 느리면 IDM처럼 급히 밟지 않고,
    // 앞차가 지금 가속도를 이어 간다고 보고(CAH) 필요한 만큼에 1m/s²쯤만 더 줄인다 (공기저항까지 2m/s² 안쪽). 선 차·정지선은 IDM 그대로
    if (lead && leadGap === gap && leadV > 0.5) {
      const aL = Math.min(lead.acc, 2);
      const sL = Math.max(0.5, leadGap);
      const cah = leadV * (v - leadV) <= -2 * sL * aL ? (v * v * aL) / Math.max(1e-6, leadV * leadV - 2 * sL * aL) : aL - Math.max(0, v - leadV) ** 2 / (2 * sL);
      // 앞차 때문에 덜 줄일 뿐, 제한속도·굽은 길에 맞춘 속도(free)를 넘겨 밟지는 않는다
      if (accel < cah) accel = Math.min(free, 0.01 * accel + 0.99 * (cah + Math.tanh(accel - cah)));
    }
    return {
      throttle: accel > 0 ? Math.min(1, accel / 2 + 0.15) : 0,
      // 내리막에서 발을 떼도 빨라지면 살짝 밟는다
      brake: accel < -0.3 ? Math.min(1, -accel / 8) : v > vc + 1 ? 0.12 : 0,
      steer: Math.max(-1, Math.min(1, -delta / p.spec.maxSteer)),
      reverse: false,
    };
  }

  /** 자동 운전: 옆 차로 앞뒤가 비었는지 (뒤 15m, 앞 10m) */
  /**
   * 옆 차로가 비었는지: 차 앞뒤 끝이 내 차 앞 4m+0.4초 ~ 뒤 6m+0.6초(뒤에서 더 빨리 오는 차는 1.5초 거리, 12m까지 더) 안에 걸치면 막혔다.
   * 긴 화물차도 끝으로 본다. 기어가는 줄에서는 차 한 대 들어갈 틈이면 된다
   */
  private laneClear(lane: number, s: number): boolean {
    const half = this.player.spec.length / 2;
    const v = this.player.speed;
    for (const a of this.traffic.agents) {
      if (a.lane !== lane && a.targetLane !== lane) continue;
      const front = 4 + v * 0.4;
      const back = 6 + v * 0.6 + (a.s < s ? Math.min(12, Math.max(0, a.v - v) * 1.5) : 0);
      if (a.s - a.len / 2 < s + half + front && a.s + a.len / 2 > s - half - back) return false;
    }
    return true;
  }

  /** 물보라: 가까운 차(180m 안)와 내 차 뒷바퀴에서 */
  private updateSpray(dt: number, inTunnel: boolean) {
    const src = this.spraySources;
    src.length = 0;
    if (this.spray.wet > 0 && !inTunnel) {
      this.trafficView.nearby(180, (m, a) => {
        if (!a.parked) src.push({ m, v: a.v, len: a.len, width: a.width, big: a.heavy || a.len > 7 });
      });
      const p = this.player;
      src.push({ m: this.view.car.matrixWorld, v: Math.abs(p.vx), len: p.spec.length, width: p.spec.width, big: this.setup.vehicle.length > 7 });
    }
    const light = Math.max(0.15, Math.min(1, this.world.daylight) * (1 - this.world.night));
    this.spray.update(dt, src, inTunnel, light);
  }

  private draw(dt: number) {
    const p = this.player;
    const road = this.road;
    this.updateOrigin();
    this.chunks.update(p.s);
    // 터널 안은 어둡게
    const inTunnel = road.structureAt(p.s) === Structure.Tunnel;
    const target = inTunnel ? 0.3 : this.baseDaylight;
    this.world.daylight += (target - this.world.daylight) * Math.min(1, dt * 2);
    this.world.tunnel += ((inTunnel ? 1 : 0) - this.world.tunnel) * Math.min(1, dt * 2);
    this.view.assist.lka = this.lkaState;
    this.view.assist.lkaSide = this.lkaWarnSide;
    this.view.update(p, road, dt, this.signal, this.hazard, this.t);
    this.trafficView.viewGround = this.view.car.position.y;
    this.trafficView.update(this.traffic.agents, this.traffic.opposite, this.t, this.world.camera.position, this.world.visibleDistance + 50, this.cityTraffic?.free);
    this.updateSpray(dt, inTunnel);
    this.sparks.update(dt);
    this.fx.speed(this.state === "run" ? p.speed * 3.6 : 0, this.view.shake.scale);
    this.world.update(this.view.car.position);
    this.weatherView.update(dt, this.view.car, road.sample(p.s).heading + p.theta, p.spec.length, p.spec.width, this.setup.vehicle.height, inTunnel);
    // 후측방 화면: 방향지시등을 켠 쪽 (비상등은 아님). 계기판에서 그 원을 비우고 뒤에 카메라 화면을 그린다
    const bvmSide = this.hazard ? 0 : this.signal;
    this.view.setBvm(bvmSide, this.hud.bvmSpot(bvmSide, dt));
    this.view.render();
    const lane = road.laneOf(p.d, p.s);
    this.hud.update(
      {
        kmh: p.speed * 3.6 * Math.sign(p.vx || 1),
        gear: this.controls.reverse ? "R" : p.vx < 0.3 && this.controls.brake > 0.1 ? "D" : `D${this.spec.gears.length > 1 ? p.gear : ""}`,
        rpm: p.revs,
        signal: this.signal,
        hazard: this.hazard,
        blink: blinkOn(this.t),
        lka: this.lkaState,
        lkaSide: this.lkaWarnSide,
        s: p.s,
        d: p.d,
        theta: p.theta,
        lane,
        time: this.t,
        clock: this.t + this.clockOffset,
        throttle: this.controls.throttle,
        brake: this.controls.brake,
        steer: this.controls.steer,
        night: this.world.night > 0.5,
        recStatus: this.recorder.label,
        camera: CAMERA_LABELS[this.view.mode],
        inputMode: this.autopilot ? "자동 운전" : INPUT_LABELS[this.input.device],
        section: this.rules.sectionState(p.s, this.t),
      },
      dt,
    );
  }
}

/** 갑자기 끼어들기: 첫 사건까지, 그 뒤 사건 사이 달린 시간 (s), 일어나는 가장 낮은 속도 */
const CUT_IN = { first: [45, 90], every: [60, 150], minKmh: 50 };

/** 게임 속 시각 "HH:MM" (출발 시각 hour + 흐른 초) */
function clockText(hour: number, sec: number): string {
  const total = Math.floor(hour * 60 + sec / 60);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
