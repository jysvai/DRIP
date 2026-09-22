// 한 번의 주행: 물리·교통·법규 판정·기록·화면을 한 루프로 돌린다.

import type { Road } from "./road/road";
import { Structure } from "./road/road";
import { RoadChunks, type LaneOverride } from "./render/roadChunks";
import { PlayerView, CAMERA_LABELS, type CameraMode } from "./render/playerView";
import { TrafficView } from "./render/trafficView";
import { World } from "./render/world";
import { RuleEngine, type PlayerFrame } from "./rules/engine";
import { Recorder, type Sample } from "./log/recorder";
import { Sound } from "./audio/sound";
import type { GameConfig } from "./sim/config";
import { busLaneZones, sunFor, trafficFor } from "./sim/scenario";
import { Input } from "./sim/input";
import { DEFAULT_CAR, PlayerCar, type Controls } from "./sim/player";
import { Traffic, type Agent, type BusLaneZone, type PlayerState } from "./sim/traffic";
import { Hud } from "./ui/hud";
import type { DriveSettings } from "./ui/menu";
import { showDialog, showReport } from "./ui/report";

const PHYS_DT = 1 / 120;
const PLAYER_TYPE = "sedan_mid";
const PLAYER_COLOR = "#23466e";
const SERIOUS_KMH = 15;

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

  constructor(
    app: HTMLElement,
    readonly road: Road,
    readonly cfg: GameConfig,
    readonly settings: DriveSettings,
    private sound: Sound,
  ) {
    this.world = new World(app);
    this.world.renderer.shadowMap.autoUpdate = false;
    const sun = sunFor(settings.hour);
    // 밤에는 하늘을 그리지 않고, 빛 방향은 높이 뜬 달
    if (sun.night > 0.6) this.world.setSun(40, 200);
    else this.world.setSun(Math.max(2, sun.elevation), sun.azimuth);
    this.world.setNight(sun.night);
    this.baseDaylight = sun.daylight;
    this.world.daylight = sun.daylight;

    this.busZones = busLaneZones(road, cfg.rules, settings.weekend, settings.hour);
    this.chunks = new RoadChunks(road, this.world);
    this.chunks.overrides = this.busZones.map<LaneOverride>((z) => ({ s0: z.s0, s1: z.s1, boundary: z.lane, color: 0x2463d8 }));

    const type = cfg.catalog.types.find((t) => t.id === PLAYER_TYPE) ?? cfg.catalog.types[0];
    this.player = new PlayerCar({ ...DEFAULT_CAR, length: type.length, width: type.width });
    const s0 = Math.max(60, Math.min(road.length - 400, settings.startKm * 1000));
    const lanes = road.lanesAt(s0);
    const startLane = lanes >= 3 ? 2 : lanes;
    const startKmh = Math.min(road.speedAt(s0) * 0.8, 90);
    this.player.place(road, s0, startLane, startKmh / 3.6);

    const tr = trafficFor(settings, cfg);
    this.traffic = new Traffic(road, cfg, settings.seed);
    this.traffic.density = Math.max(1, tr.density);
    this.traffic.flowSpeed = tr.flowKmh ? tr.flowKmh / 3.6 : null;
    this.traffic.setComposition(tr.composition);
    this.traffic.busZones = this.busZones;
    this.traffic.fill(this.playerState());
    // 출발 속도는 주변 차 흐름에 맞춘다 (막히는 길에서 바로 급제동하지 않게)
    const near = this.traffic.agents.filter((a) => Math.abs(a.s - s0) < 400);
    if (near.length >= 3) {
      const flow = (near.reduce((sum, a) => sum + a.v, 0) / near.length) * 3.6;
      this.player.place(road, s0, startLane, Math.max(20, Math.min(startKmh, flow)) / 3.6);
    }

    this.trafficView = new TrafficView(this.world, road, cfg.catalog);
    this.hud = new Hud(document.body, road, this.busZones);
    this.view = new PlayerView(this.world, type, PLAYER_COLOR, this.hud.root);
    this.view.setMode(settings.camera as CameraMode);
    this.view.setNight(sun.night);
    this.input = new Input(this.world.renderer.domElement);

    this.rules = new RuleEngine(road, cfg.rules, this.busZones);
    this.recorder = new Recorder(settings.consent);
    this.rules.onEvent = (e) => this.recorder.event(e);
    this.recorder.start({
      roadId: road.id,
      roadRef: road.ref,
      roadName: road.name,
      direction: `${road.from}→${road.to}`,
      startS: Math.round(s0),
      preset: `${settings.preset}:${tr.source}:${tr.density.toFixed(1)}`,
      simHour: settings.hour + (settings.weekend ? 100 : 0),
      seed: settings.seed,
      inputMode: this.input.mode,
      camera: settings.camera,
    });

    this.sound.enabled = settings.sound;
    this.world.origin.e = 0;
    this.updateOrigin();
    this.chunks.prime(this.player.s);
    this.laneForSignal = road.laneOf(this.player.d, this.player.s);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.state === "run") this.pause();
    });
    requestAnimationFrame(this.frame);
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
    const lanes = road.lanesAt(this.player.s);
    showDialog(
      "출발 준비",
      `${road.name} ${road.from} → ${road.to}, ${(this.player.s / 1000).toFixed(1)}km 지점 편도 ${lanes}차로에서 ${Math.round(this.player.speed * 3.6)}km/h로 출발합니다.` +
        (this.busZones.length ? " 이 시간대에는 1차로가 버스전용차로입니다(파란 선)." : "") +
        "<br>주행 중에는 법규 판정을 보여 주지 않고, 끝난 뒤 결과 화면에서 보여 줍니다.",
      [
        {
          label: "출발 (Enter)",
          primary: true,
          key: "Enter",
          onClick: () => {
            this.state = "run";
            this.sound.resume();
            onStart?.();
          },
        },
      ],
    );
  }

  pause() {
    if (this.state !== "run") return;
    this.state = "pause";
    this.sound.suspend();
    showDialog("일시정지", "주행 기록은 멈춘 동안 쌓이지 않습니다.", [
      { label: "계속 (Esc)", primary: true, key: "Escape", onClick: () => this.resume() },
      { label: "주행 끝내기", onClick: () => this.finish("user") },
      { label: "노선 고르기", onClick: () => location.reload() },
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
      if (this.state !== "run") return;
    }
    this.contactCooldown -= dt;

    // 교통
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

    this.sound.update(p.rpm, c.throttle, p.speed, road.structureAt(p.s) === Structure.Tunnel);
    this.sound.signal(this.signal !== 0 || this.hazard, this.t);

    if (p.s >= road.length - 40) this.finish("road_end");
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
      this.road.speedAt(p.s),
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
    const lane = Math.max(1, Math.min(lanes, road.laneOf(p.d, p.s)));
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
        roadLabel: `${this.road.name} ${this.road.from} → ${this.road.to}`,
        upload,
        exportJson: () => this.recorder.exportJson(summary),
        fileName: `drip_${this.road.id}_${stamp}.json`,
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
    const v0 = (road.speedAt(p.s) - 5) / 3.6;
    const kk = Math.abs(road.sample(Math.min(road.length - 1, p.s + 120)).kappa);
    const vc = kk > 1e-4 ? Math.min(v0, Math.sqrt(2.5 / kk)) : v0;
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
    this.view.render();
    const lane = road.laneOf(p.d, p.s);
    this.hud.update(
      {
        kmh: p.speed * 3.6 * Math.sign(p.vx || 1),
        gear: this.controls.reverse ? "R" : `D${p.gear}`,
        rpmRatio: p.rpm / p.spec.redline,
        signal: this.signal,
        hazard: this.hazard,
        s: p.s,
        lane,
        time: this.t,
        recStatus: !this.settings.consent ? "기록 (브라우저에만)" : this.recorder.online ? (this.recorder.status === "error" ? "기록 (서버 오류)" : "기록 중") : "기록 (오프라인)",
        camera: CAMERA_LABELS[this.view.mode],
        inputMode: this.autopilot ? "자동 운전" : INPUT_LABELS[this.input.mode],
      },
      dt,
    );
  }
}
