// 한 번의 주행: 물리·교통·법규 판정·기록·화면을 한 루프로 돌린다.

import type { Road, RoadFile } from "./road/road";
import { Structure } from "./road/road";
import type { Network } from "./road/route";
import { RoadChunks, type LaneOverride } from "./render/roadChunks";
import { PlayerView, CAMERA_LABELS, type CameraMode } from "./render/playerView";
import { TrafficView } from "./render/trafficView";
import { World } from "./render/world";
import { WeatherView } from "./render/weather";
import { RuleEngine, type PlayerFrame } from "./rules/engine";
import { Recorder, type Sample } from "./log/recorder";
import { Sound } from "./audio/sound";
import { enforcementFor, type Enforcement } from "./sim/cameras";
import { coneLine, END_TAPER_M, planWorkZones, ZONE_KMH, type WorkZone } from "./sim/workzones";
import { gripAt, legalFactor, trafficResponse, weatherOf, type Weather } from "./sim/weather";
import { planIncidents, type Incident } from "./sim/incidents";
import { realEventsFor, realEventsStamp } from "./sim/realEvents";
import type { GameConfig } from "./sim/config";
import { routeBusZones, sunFor, trafficFor } from "./sim/scenario";
import { Input } from "./sim/input";
import { PlayerCar, type Controls } from "./sim/player";
import { specFor, type PlayerSpec } from "./sim/vehicleSpec";
import type { VehicleType } from "./render/vehicleModels";
import { Traffic, type Agent, type BusLaneZone, type PlayerState } from "./sim/traffic";
import { Hud } from "./ui/hud";
import type { DriveSettings } from "./ui/menu";
import { showDialog, showReport } from "./ui/report";
import { showControls } from "./ui/help";

const PHYS_DT = 1 / 120;
const SERIOUS_KMH = 15;

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
}

/** 마지막 한글 글자에 받침이 있으면 b, 없으면 a (예: 와/과) */
function josa(word: string, a: string, b: string): string {
  const m = word.match(/[가-힣](?=[^가-힣]*$)/);
  if (!m) return a;
  return (m[0].charCodeAt(0) - 0xac00) % 28 ? b : a;
}

const INPUT_LABELS = { keyboard: "키보드", mouse: "마우스 조향", gamepad: "게임패드" } as const;

export class Game {
  readonly world: World;
  readonly player: PlayerCar;
  readonly traffic: Traffic;
  readonly view: PlayerView;
  readonly trafficView: TrafficView;
  readonly chunks: RoadChunks;
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
  readonly weatherView: WeatherView;
  readonly road: Road;
  readonly spec: PlayerSpec;
  state: "ready" | "run" | "pause" | "crash" | "end" = "ready";
  t = 0;
  signal: -1 | 0 | 1 = 0;
  hazard = false;
  autopilot = false;
  fps = 0;
  private acc = 0;
  private last = performance.now();
  private sampleTimer = 0;
  private signalCancelAt = -1;
  private laneForSignal = 0;
  private contactCooldown = 0;
  private baseDaylight = 1;
  private fpsFrames = 0;
  private fpsTime = 0;
  private autoLane = 0;
  private assistWeight = 0;
  private controls: Controls = { throttle: 0, brake: 0, steer: 0, reverse: false };
  private legIndex = -1;

  constructor(
    app: HTMLElement,
    readonly setup: DriveSetup,
    readonly cfg: GameConfig,
    readonly settings: DriveSettings,
    private sound: Sound,
  ) {
    const road = setup.road;
    this.road = road;
    this.world = new World(app);
    (this.world as World & { setQuality?: (q: DriveSettings["quality"]) => void }).setQuality?.(settings.quality);
    this.world.renderer.shadowMap.autoUpdate = false;
    const sun = sunFor(settings.hour);
    // 밤에는 하늘을 그리지 않고, 빛 방향은 높이 뜬 달
    if (sun.night > 0.6) this.world.setSun(40, 200);
    else this.world.setSun(Math.max(2, sun.elevation), sun.azimuth);
    this.world.setNight(sun.night);
    // 날씨: 흐리면 어둡고, 비·안개는 가시거리만큼 안개를 당긴다
    const weather = weatherOf(settings.weather);
    this.weather = weather;
    this.weatherView = new WeatherView(this.world, weather);
    this.weatherView.apply(sun.night);
    this.baseDaylight = sun.daylight * (1 - 0.35 * weather.overcast);
    this.world.daylight = this.baseDaylight;

    this.busZones = routeBusZones(road, setup.sources ?? new Map(), cfg.rules, settings.weekend, settings.hour);
    this.chunks = new RoadChunks(road, this.world);
    this.chunks.overrides = this.busZones.map<LaneOverride>((z) => ({ s0: z.s0, s1: z.s1, boundary: z.lane, color: 0x2463d8 }));
    this.enforcement = enforcementFor(road, cfg.cameras);
    this.chunks.setEnforcement(this.enforcement);
    if (weather.wet) this.chunks.setWet(0.75 + 0.25 * weather.rain, this.weatherView.roadEnvironment());

    const type = setup.vehicle;
    this.spec = specFor(type);
    this.player = new PlayerCar(this.spec);
    // 젖은 노면은 미끄럽다 (터널 안은 마른 노면)
    const heavyGrip = this.spec.vehicleClass !== "car";
    this.player.grip = (kmh) => (road.structureAt(this.player.s) === Structure.Tunnel ? 1 : gripAt(weather, kmh, heavyGrip));
    const s0 = Math.max(60, Math.min(setup.finishS - 400, setup.startS));
    const lanes = road.lanesAt(s0);
    // 화물·대형승합은 지정차로(오른쪽)에서 출발
    const startLane = this.spec.vehicleClass !== "car" ? lanes : lanes >= 3 ? 2 : lanes;
    const heavySpeed = this.spec.vehicleClass === "truck" && !!type.heavy;
    const startKmh = Math.min(road.speedAt(s0, heavySpeed) * 0.8 * legalFactor(weather, cfg.rules), 90, this.spec.governor * 3.6 - 5);
    this.player.place(road, s0, startLane, startKmh / 3.6);
    const night = sun.night > 0.5;
    // '실제' 교통을 고르고 실제 돌발상황(ITS)이 있으면 그 공사·선 차를 쓴다
    const real = settings.preset === "실제" ? realEventsFor(road, cfg.events) : null;
    this.realEvents = real ? realEventsStamp(cfg.events!) : "";
    if (real) {
      const ahead = (s: number) => s > s0 + 300 && s < setup.finishS - 300;
      this.workZones = real.workZones.filter((z) => ahead(z.s0));
      this.incidents = real.incidents.filter((i) => ahead(i.s));
    } else {
      // 공사 구간 (시드로 도로 전체에 놓고 출발 1.2km 뒤부터, 시간대·요일 빈도)
      this.workZones = planWorkZones(road, { seed: settings.seed, hour: settings.hour, weekend: settings.weekend, startS: s0, finishS: setup.finishS });
      // 돌발상황 (고장·사고로 선 차): 같은 시드면 어디서 출발하든 같은 자리라, 피할 공사 구간도 출발 위치로 거르기 전 전체를 쓴다
      const allZones = planWorkZones(road, { seed: settings.seed, hour: settings.hour, weekend: settings.weekend, startS: -Infinity, finishS: Infinity });
      this.incidents = planIncidents(road, { seed: settings.seed, night, startS: s0, finishS: setup.finishS, workZones: allZones });
    }
    this.chunks.setWorkZones(this.workZones);
    this.chunks.setIncidents(this.incidents, night);

    // 실제 교통은 출발 위치의 원래 주행선·위치로 찾는다
    const tr = this.trafficAt(s0);
    this.legIndex = road.legs.indexOf(road.legAt(s0));
    this.traffic = new Traffic(road, cfg, settings.seed);
    this.traffic.density = Math.max(1, tr.density);
    this.traffic.flowSpeed = tr.flowKmh ? tr.flowKmh / 3.6 : null;
    // 날씨 반응: 비에는 속도를 거의 줄이지 않고(실측), 폭우·안개에는 줄인다 (driver_profiles.json weather)
    const resp = trafficResponse(weather, cfg.profiles.weather);
    this.traffic.headwayScale = (1 + 0.1 * sun.night) * resp.headwayScale;
    this.traffic.weatherSpeed = resp.speedScale;
    this.traffic.setComposition(tr.composition);
    this.traffic.busZones = this.busZones;
    this.traffic.workZones = this.workZones;
    this.traffic.incidents = this.incidents;
    this.traffic.fill(this.playerState());
    // 출발 속도는 주변 차 흐름에 맞춘다 (막히는 길에서 바로 급제동하지 않게)
    const near = this.traffic.agents.filter((a) => Math.abs(a.s - s0) < 400);
    if (near.length >= 3) {
      const flow = (near.reduce((sum, a) => sum + a.v, 0) / near.length) * 3.6;
      this.player.place(road, s0, startLane, Math.max(20, Math.min(startKmh, flow)) / 3.6);
    }

    this.trafficView = new TrafficView(this.world, road, cfg.catalog);
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
      say: (text) => {
        if (this.state !== "run") return false;
        this.sound.say(text);
        return true;
      },
      enforcement: this.enforcement,
      workZones: this.workZones,
      incidents: this.incidents,
      weather: { label: weather.label, factorAt: (s) => this.rules.weatherFactorAt(s) },
      chime: () => this.sound.chime(),
    });
    this.view = new PlayerView(this.world, type, settings.color, this.hud.root);
    this.view.setMode(settings.camera as CameraMode);
    this.view.setNight(sun.night);
    this.input = new Input(this.world.renderer.domElement);

    this.rules = new RuleEngine(road, cfg.rules, this.busZones);
    this.rules.vehicleClass = this.spec.vehicleClass;
    this.rules.heavySpeed = heavySpeed;
    this.rules.enforcement = this.enforcement;
    this.rules.workZones = this.workZones;
    this.rules.incidents = this.incidents;
    this.rules.weatherFactor = legalFactor(weather, cfg.rules);
    this.recorder = new Recorder(settings.consent);
    this.rules.onEvent = (e) => this.recorder.event(e);
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
    });

    this.sound.enabled = settings.sound;
    this.sound.voiceOn = settings.voice;
    this.sound.rain = weather.rain;
    this.sound.wetRoad = weather.wet;
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
    const cut = Math.round((1 - this.rules.weatherFactor) * 100);
    const weatherNote = this.weatherNote(cut);
    if (weatherNote) notes.push(weatherNote);
    showDialog(
      `${this.setup.originName} → ${this.setup.destName}`,
      `<b>${road.sectionNameAt(s)}</b> 편도 ${lanes}차로에서 ${Math.round(this.player.speed * 3.6)}km/h로 출발합니다. 목적지까지 <b>${remain.toFixed(0)}km</b>.` +
        (notes.length ? `<br>${notes.join(" ")}` : "") +
        "<br><span class='muted'>위쪽 안내를 따라 분기점에서 갈아타세요. 주행 중에는 법규 판정을 보여 주지 않고, 끝난 뒤 결과 화면에서 보여 줍니다. 조작법은 F1.</span>",
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
              `경로 안내를 시작합니다. ${this.setup.destName}까지 ${Math.round(remain)}킬로미터입니다.` +
                (cut ? ` ${this.weather.visibilityM <= 100 ? "앞이 잘 보이지 않습니다" : "노면이 젖어 있습니다"}. 제한속도의 ${cut}퍼센트를 줄여 달리세요.` : ""),
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
    if (w.kind === "clear" || w.kind === "cloudy") return "";
    const why = w.visibilityM <= 100 ? `${w.label}로 앞이 ${w.visibilityM}m 정도밖에 보이지 않습니다` : `${w.label}가 내려 노면이 젖어 있습니다`;
    const grip = w.wet ? " 노면이 미끄러워 제동거리가 약 1.8배로 늘어납니다." : "";
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
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 1) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    if (this.state === "run") this.step(dt);
    this.draw(dt);
    requestAnimationFrame(this.frame);
  };

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
    if (actions.mirrors) this.view.toggleMirrors();
    if (actions.horn) this.sound.horn();
    if (actions.help) {
      this.state = "pause";
      this.sound.suspend();
      showControls(() => this.resume());
      return;
    }

    const c = this.autopilot ? this.autoControls() : this.input.update(dt, p.speed);
    if (!this.autopilot) this.keyboardAssist(c, dt);
    this.controls = c;
    this.t += dt;

    // 물리 (고정 간격)
    this.acc += dt;
    while (this.acc >= PHYS_DT) {
      p.step(PHYS_DT, road, c);
      this.acc -= PHYS_DT;
      for (const h of p.hits) this.guardrail(h.lateralSpeed, h.side);
      this.workZoneContact();
      if (this.state !== "run") return;
    }
    this.contactCooldown -= dt;

    // 교통
    if (this.road.isRoute) this.updateLegTraffic();
    const ps = this.playerState();
    this.traffic.update(dt, ps, this.t);
    this.collide();
    if (this.state !== "run") return;

    // 방향지시등: 차로를 옮기고 핸들을 풀면 꺼진다
    const lane = road.laneOf(p.d, p.s);
    if (this.signal !== 0 && lane !== this.laneForSignal && Math.sign(lane - this.laneForSignal) === this.signal) this.signalCancelAt = this.t + 1.2;
    this.laneForSignal = lane;
    if (this.signalCancelAt > 0 && this.t >= this.signalCancelAt && Math.abs(c.steer) < 0.12) {
      this.signal = 0;
      this.signalCancelAt = -1;
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
    this.recorder.tick(dt);

    this.sound.update(p.rpm, c.throttle, p.speed, road.structureAt(p.s) === Structure.Tunnel, c.brake);
    this.sound.signal(this.signal !== 0 || this.hazard, this.t);

    if (p.s >= this.setup.finishS - 30) this.finish("arrived");
    else if (p.s >= road.length - 40) this.finish("road_end");
  }

  private setSignal(dir: -1 | 0 | 1) {
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
    for (const a of this.traffic.agents) if (Math.abs(a.s - p.s) < 50) near++;
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
      this.sound.crash(0.2);
      this.hud.toast("접촉", 1.2);
    }
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
    if (this.contactCooldown <= 0) {
      this.rules.crash(this.frameInfo(0), side === "left" ? "median_barrier" : "guardrail", kmh);
      this.contactCooldown = 1;
      this.sound.crash(Math.min(1, kmh / 40));
    }
    if (kmh >= SERIOUS_KMH + 5) this.crashed(side === "left" ? "중앙분리대 충돌" : "가드레일 충돌", kmh);
    else this.hud.toast(side === "left" ? "중앙분리대에 닿았습니다" : "가드레일에 닿았습니다", 1.2);
  }

  private crashed(what: string, kmh: number) {
    if (this.state !== "run") return;
    this.state = "crash";
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.r = 0;
    this.sound.crash(1);
    showDialog("충돌", `${what} · 충돌 속도 약 ${Math.round(kmh)}km/h. 충돌은 기록에 남습니다.`, [
      { label: "이어서 달리기 (Enter)", primary: true, key: "Enter", onClick: () => this.respawn() },
      { label: "주행 끝내기", onClick: () => this.finish("crash") },
    ]);
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
    p.place(road, s, lane, 50 / 3.6);
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
    if (this.view.mirrorsOn) this.view.toggleMirrors();
    const f = this.frameInfo(0);
    this.rules.finish(f);
    const summary = this.rules.summary;
    let upload: Promise<"ok" | "offline" | "error" | "no_consent">;
    if (!this.settings.consent) upload = Promise.resolve("no_consent");
    else if (!this.recorder.online) upload = Promise.resolve("offline");
    else upload = this.recorder.finish(summary, reason).then((ok) => (ok ? "ok" : "error"));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    showReport(
      {
        summary,
        events: this.rules.events,
        reason,
        roadLabel: `${this.setup.originName} → ${this.setup.destName}${this.weather.kind === "clear" ? "" : ` · ${this.weather.label}`}`,
        upload,
        exportJson: () => this.recorder.exportJson(summary),
        fileName: `drip_${this.road.id.replace(/[^\w가-힣-]+/g, "_")}_${stamp}.json`,
      },
      () => {
        sessionStorage.setItem("drip_retry", JSON.stringify(this.settings));
        location.reload();
      },
      () => location.reload(),
    );
  }

  /** 키보드 조향 보조: 조향 키를 놓으면 차 방향을 도로 방향에 맞춘다 (차로 위치는 그대로).
   *  키보드는 반대로 꺾어 바로잡기가 어려워서 넣는다. 마우스·게임패드·휠에는 쓰지 않는다. */
  private keyboardAssist(c: Controls, dt: number) {
    if (this.input.mode !== "keyboard" || this.input.steeringKeyDown) {
      this.assistWeight = 0;
      return;
    }
    this.assistWeight = Math.min(1, this.assistWeight + dt / 0.3);
    const p = this.player;
    const sp = p.spec;
    const v = Math.max(3, p.vx);
    const L = sp.lf + sp.lr;
    const K = (sp.mass * sp.lr) / L / sp.cf - (sp.mass * sp.lf) / L / sp.cr; // 언더스티어 계수
    const kappa = this.road.sample(p.s).kappa;
    // 차가 실제로 가는 방향(차 방향 + 옆미끄럼)과 길 방향의 차이. 차 방향만 맞추면 굽은 길에서 바깥으로 밀린다
    const course = p.theta + p.vy / v;
    // 바퀴각(왼쪽 +) = 굽은 길 따라가기 (L+Kv²)κ − 진행 방향 오차를 1초에 줄이기 (L+Kv²)·course/v.
    // 조향 입력은 오른쪽이 +라서 부호를 뒤집는다.
    const wheel = (L + K * v * v) * (kappa - course / (v * 1.0));
    const assist = Math.max(-0.5, Math.min(0.5, -wheel / sp.maxSteer));
    c.steer += assist * this.assistWeight;
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
    const v = Math.max(p.vx, 1);
    const Ld = Math.max(12, v * 1.1);
    const dT = road.laneCenter(this.autoLane, Math.min(road.length - 1, p.s + Ld));
    const k = road.sample(p.s).kappa;
    const y = -(dT - p.d) + (k * Ld * Ld) / 2;
    const alpha = Math.atan2(y, Ld) - p.theta;
    const L = p.spec.lf + p.spec.lr;
    const delta = Math.atan((2 * L * Math.sin(alpha)) / Ld);
    let lead: Agent | null = null;
    let gap = Infinity;
    for (const a of this.traffic.agents) {
      if (a.lane !== this.autoLane && a.targetLane !== this.autoLane) continue;
      const g = a.s - a.len / 2 - (p.s + p.spec.length / 2);
      if (g > -1 && g < gap) {
        gap = g;
        lead = a;
      }
    }
    // 제한속도(공사 구간·악천후 감속 포함)보다 조금 낮게, 미끄러우면 굽은 길에서 더 천천히
    const v0 = (this.rules.limitAt(p.s) - 5) / 3.6;
    const kk = Math.abs(road.sample(Math.min(road.length - 1, p.s + 120)).kappa);
    const vc = kk > 1e-4 ? Math.min(v0, Math.sqrt((2.5 * p.grip(p.speed * 3.6)) / kk)) : v0;
    const sStar = 3 + Math.max(0, v * 1.6 + (lead ? (v * (v - lead.v)) / (2 * Math.sqrt(2 * 3)) : 0));
    const accel = 2 * (1 - (v / vc) ** 4 - (lead ? (sStar / Math.max(0.5, gap)) ** 2 : 0));
    return {
      throttle: accel > 0 ? Math.min(1, accel / 2 + 0.15) : 0,
      brake: accel < -0.3 ? Math.min(1, -accel / 8) : 0,
      steer: Math.max(-1, Math.min(1, -delta / p.spec.maxSteer)),
      reverse: false,
    };
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
    this.view.update(p, road, dt, this.signal, this.hazard, this.t);
    this.trafficView.update(this.traffic.agents, this.traffic.opposite, this.t, this.world.camera.position);
    this.world.update(this.view.car.position);
    this.weatherView.light();
    this.weatherView.update(dt, this.view.car, road.sample(p.s).heading + p.theta, p.spec.length, p.spec.width, this.setup.vehicle.height, inTunnel);
    this.view.render();
    const lane = road.laneOf(p.d, p.s);
    this.hud.update(
      {
        kmh: p.speed * 3.6 * Math.sign(p.vx || 1),
        gear: this.controls.reverse ? "R" : p.vx < 0.3 && this.controls.brake > 0.1 ? "D" : `D${this.spec.gears.length > 1 ? p.gear : ""}`,
        rpm: p.rpm,
        signal: this.signal,
        hazard: this.hazard,
        s: p.s,
        d: p.d,
        theta: p.theta,
        lane,
        time: this.t,
        throttle: this.controls.throttle,
        brake: this.controls.brake,
        steer: this.controls.steer,
        night: this.world.night > 0.5,
        recStatus: !this.settings.consent ? "기록 (브라우저에만)" : this.recorder.online ? (this.recorder.status === "error" ? "기록 (서버 오류)" : "기록 중") : "기록 (오프라인)",
        camera: CAMERA_LABELS[this.view.mode],
        inputMode: this.autopilot ? "자동 운전" : INPUT_LABELS[this.input.mode],
        section: this.rules.sectionState(p.s, this.t),
      },
      dt,
    );
  }
}
