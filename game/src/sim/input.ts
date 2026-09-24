// 키보드·마우스·게임패드(레이싱 휠 포함) 입력을 하나의 조작값으로 만든다.

import type { Controls } from "./player";

export type InputMode = "keyboard" | "mouse" | "gamepad";
/** 지금 쓰는 조작 장치 (기록용): 게임패드는 레이싱 휠과 패드를 나눈다 */
export type DeviceKind = "keyboard" | "mouse" | "pad" | "wheel";
/** 키보드 페달: hold는 누른 만큼 밟히고 떼면 그 자리에 발을 둔다 (진짜 페달처럼 일정하게 밟고 달린다), momentary는 누르는 동안만 */
export type PedalMode = "hold" | "momentary";
/** 조향 감도: 키보드·패드 핸들이 돌아가는 빠르기와 끝까지 꺾었을 때 옆 가속도 */
export type SteerSens = "slow" | "normal" | "fast";

/**
 * hold 페달 빠르기 (1초에 페달 깊이가 바뀌는 양). 고속도로 정속은 페달 15~30% 사이라 짧게 누르면 조금씩 바뀌게 한다.
 * ↑: 처음 0.4초는 fine, 그 뒤는 press. ↓: 처음 0.2초는 fine으로 조금 떼고, 더 누르면 lift로 다 뗀 뒤 brake로 밟는다.
 */
export const PEDAL = { fine: 0.35, press: 0.9, fineFor: 0.4, liftFineFor: 0.2, lift: 4, brake: 2.5, brakeRelease: 6 };

/**
 * 키보드 핸들. 누르고 있으면 처음 fineFor초는 fine배로 천천히 (톡 치면 살짝 바로잡기), 그 뒤는 제 빠르기로 돈다.
 * 빠르기(1초에 끝까지 꺾는 양의 몇 배)는 lowV(m/s) 아래 lowRate(교차로에서 크게 돌리기), highV 위 highRate(고속에서 살짝씩), 사이는 곧게.
 * 놓으면 가운데로 돌아오는 빠르기도 빠를수록 크다 (달리는 차는 바퀴가 스스로 곧게 서려는 힘이 세다).
 * 끝까지 꺾었을 때 옆 가속도(m/s²)는 lowV 아래 latLow(교차로를 시속 20~25km로 돌 만큼), highV 위 latHigh, 사이는 곧게.
 */
export const STEER = { fineFor: 0.15, fine: 0.35, lowRate: 3.2, highRate: 1.2, lowV: 5, highV: 25, returnLow: 2.5, returnHigh: 5, latLow: 5.5, latHigh: 4 };

/** 조향 감도별 [빠르기 배율, 옆 가속도 배율] */
export const STEER_SENS: Record<SteerSens, [number, number]> = { slow: [0.7, 0.8], normal: [1, 1], fast: [1.4, 1.2] };

/** 차 크기: 축간거리(m), 바퀴 최대 조향각(rad), 언더스티어 계수 (rad/(m/s²), 빠를수록 같은 바퀴각에 덜 돈다) */
export interface SteerCar {
  wheelbase: number;
  maxSteer: number;
  understeer: number;
}

/** 패드 스틱: 가운데 dead 안은 0, 밖은 다시 0~1로 펴서 power 곡선 (가운데가 곱다). 최대는 키보드 한계의 limit배. 트리거는 trigDead까지 흘린다 */
export const PAD = { dead: 0.08, power: 1.6, limit: 1.5, trigDead: 0.05 };

/** 페달 하나: 어느 축(또는 버튼)인지, 뗐을 때 값 rest와 끝까지 밟았을 때 값 full */
export interface PedalAxis {
  kind: "axis" | "button";
  index: number;
  rest: number;
  full: number;
}

/** 휠·페달 맞추기 결과 (메뉴에서 맞추고 설정에 저장) */
export interface WheelCalibration {
  throttle: PedalAxis;
  brake: PedalAxis;
}

/** 게임패드 한 순간의 축·버튼 값 */
export interface PadSnapshot {
  axes: number[];
  buttons: number[];
}

export interface InputActions {
  signalLeft: boolean;
  signalRight: boolean;
  hazard: boolean;
  camera: boolean;
  pause: boolean;
  horn: boolean;
  mirrors: boolean;
  help: boolean;
  /** 차로 유지 보조 켜고 끄기 (L) */
  lka: boolean;
}

const KEYMAP: Record<string, keyof typeof keysDown> = {
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
};

const keysDown = { up: false, down: false, left: false, right: false };

const KEY_FALLBACK: Record<string, string> = { ",": "Comma", ".": "Period", " ": "Space" };

export class Input {
  mode: InputMode = "keyboard";
  pedal: PedalMode = "hold";
  steerSens: SteerSens = "normal";
  /** 레이싱 휠이 끝에서 끝까지 도는 각도 (휠 드라이버 설정) */
  wheelRange = 900;
  /** 휠 페달 맞추기 (없으면 기본 배치) */
  calibration: WheelCalibration | null = null;
  /** 차 크기: 키보드·패드로 꺾을 수 있는 한계를 잡는다 (게임이 차종에 맞게 바꾼다) */
  car: SteerCar = { wheelbase: 2.85, maxSteer: 0.6, understeer: 0.004 };
  controls: Controls = { throttle: 0, brake: 0, steer: 0, reverse: false };
  private pressed = new Set<string>();
  private throttleKey = 0;
  private brakeKey = 0;
  /** ↑·↓를 이어서 누른 시간 (s) */
  private upFor = 0;
  private downFor = 0;
  private steerKey = 0;
  /** 같은 쪽 조향 키를 이어서 누른 시간 (s)과 그 방향 */
  private steerFor = 0;
  private steerDir = 0;
  private mouseX = 0.5;
  private gamepadIndex: number | null = null;
  private padId = "";
  /** 키보드로 바꾼 때의 패드 값: 여기서 크게 움직이면 다시 게임패드로 */
  private padBase: PadSnapshot | null = null;
  private prevButtons: boolean[] = [];
  private pendingActions: InputActions = blank();
  /** 진동: 마지막으로 보낸 시각(ms)과 세기, 한 번 세게 울리는 것이 끝나는 시각 */
  private rumbleSent = 0;
  private rumbleLast: [number, number] = [0, 0];
  private pulseUntil = 0;

  constructor(target: HTMLElement) {
    window.addEventListener("keydown", this.onKey, { passive: false });
    window.addEventListener("keyup", this.onKey);
    // 창 밖을 누르면 keyup이 오지 않아 가속 키가 눌린 채로 남는다
    window.addEventListener("blur", () => {
      keysDown.up = keysDown.down = keysDown.left = keysDown.right = false;
      this.pressed.clear();
      // 밟아 둔 가속 페달도 뗀다 (창을 벗어난 사이 혼자 달려 나가지 않게)
      this.throttleKey = 0;
    });
    target.addEventListener("mousemove", (e) => {
      const rect = target.getBoundingClientRect();
      this.mouseX = (e.clientX - rect.left) / rect.width;
    });
    window.addEventListener("gamepadconnected", (e) => {
      this.gamepadIndex = (e as GamepadEvent).gamepad.index;
      this.padId = (e as GamepadEvent).gamepad.id;
      this.padBase = null;
      this.mode = "gamepad";
    });
    window.addEventListener("gamepaddisconnected", (e) => {
      if ((e as GamepadEvent).gamepad.index !== this.gamepadIndex) return;
      this.gamepadIndex = null;
      this.padId = "";
      if (this.mode === "gamepad") this.mode = "keyboard";
    });
  }

  private onKey = (e: KeyboardEvent) => {
    const down = e.type === "keydown";
    // 물리 키(code)를 먼저 본다. 한글 입력 상태에서도 Q는 KeyQ다. code가 비어 있는 이벤트만 key로 대신한다
    const code = e.code || KEY_FALLBACK[e.key] || (e.key.length === 1 ? `Key${e.key.toUpperCase()}` : e.key);
    const k = KEYMAP[code];
    if (k) {
      keysDown[k] = down;
      e.preventDefault();
    }
    if (down && !e.repeat) {
      switch (code) {
        case "KeyQ":
        case "Comma":
          this.pendingActions.signalLeft = true;
          break;
        case "KeyE":
        case "Period":
          this.pendingActions.signalRight = true;
          break;
        case "KeyX":
          this.pendingActions.hazard = true;
          break;
        case "KeyC":
          this.pendingActions.camera = true;
          break;
        case "Escape":
        case "KeyP":
          this.pendingActions.pause = true;
          break;
        case "KeyH":
          this.pendingActions.horn = true;
          break;
        case "KeyV":
          this.pendingActions.mirrors = true;
          break;
        case "KeyL":
          this.pendingActions.lka = true;
          break;
        case "KeyM":
          this.mode = this.mode === "mouse" ? "keyboard" : "mouse";
          break;
        case "F1":
          e.preventDefault();
          this.pendingActions.help = true;
          break;
        case "KeyR":
          this.controls.reverse = !this.controls.reverse;
          break;
      }
    }
    if (down) this.pressed.add(code);
    else this.pressed.delete(code);
  };

  /** 키보드로 지금 조향 키를 누르고 있는지 */
  get steeringKeyDown(): boolean {
    return keysDown.left || keysDown.right;
  }

  /** 지금 쓰는 조작 장치 */
  get device(): DeviceKind {
    if (this.mode === "gamepad") return isWheel(this.padId) ? "wheel" : "pad";
    return this.mode;
  }

  /** 이번 프레임에 눌린 버튼들 (한 번 읽으면 비워진다) */
  takeActions(): InputActions {
    const a = this.pendingActions;
    this.pendingActions = blank();
    return a;
  }

  update(dt: number, speed: number): Controls {
    const c = this.controls;
    const [rateScale, latScale] = STEER_SENS[this.steerSens];
    const limit = steerLimit(speed, latAccel(speed, latScale), this.car);
    const pad = this.findPad();
    if (pad) {
      // 장치 바꾸기: 운전 키를 누르면 키보드, 패드·휠을 크게 움직이면 게임패드 (둘 다 꽂아 두고 번갈아 써도 된다)
      const snap = snapshot(pad);
      const keyDown = keysDown.up || keysDown.down || keysDown.left || keysDown.right;
      if (this.mode === "gamepad" && keyDown) {
        this.mode = "keyboard";
        this.padBase = snap;
      } else if (this.mode !== "gamepad") {
        if (!this.padBase || this.padBase.axes.length !== snap.axes.length) this.padBase = snap;
        else if (padMoved(this.padBase, snap)) this.mode = "gamepad";
      }
      if (this.mode === "gamepad") {
        this.readGamepad(pad, snap, limit);
        return c;
      }
    } else if (this.mode === "gamepad") this.mode = "keyboard";

    this.upFor = keysDown.up ? this.upFor + dt : 0;
    this.downFor = keysDown.down ? this.downFor + dt : 0;
    const pedals = pedalStep(this.pedal, this.throttleKey, this.brakeKey, keysDown.up, keysDown.down, dt, this.upFor, this.downFor);
    this.throttleKey = pedals.throttle;
    this.brakeKey = pedals.brake;
    c.throttle = this.throttleKey;
    c.brake = this.brakeKey;

    // 조향: 빠를수록 끝까지 꺾는 각을 줄여 옆 가속도가 한계(보통 감도로 고속 4m/s², 교차로 5.5m/s²)를 넘지 않게 한다
    if (this.mode === "mouse") {
      const x = (this.mouseX - 0.5) * 2;
      const shaped = Math.sign(x) * Math.pow(Math.abs(x), 1.6);
      c.steer = shaped * Math.min(1, limit * 2.2);
    } else {
      const want = ((keysDown.right ? 1 : 0) - (keysDown.left ? 1 : 0)) as -1 | 0 | 1;
      this.steerFor = want !== 0 && want === this.steerDir ? this.steerFor + dt : 0;
      this.steerDir = want;
      this.steerKey = keySteerStep(this.steerKey, want, this.steerFor, speed, dt, rateScale);
      c.steer = this.steerKey * limit;
    }
    return c;
  }

  /** 연결된 게임패드. 페이지를 열기 전에 꽂아 둔 것은 연결 이벤트가 안 와서 직접 찾는다 */
  private findPad(): Gamepad | null {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.gamepadIndex !== null) {
      const p = pads[this.gamepadIndex];
      if (p?.connected) return p;
      this.gamepadIndex = null;
    }
    for (const p of pads) {
      if (!p?.connected) continue;
      this.gamepadIndex = p.index;
      this.padId = p.id;
      this.padBase = null;
      return p;
    }
    return null;
  }

  private pad(): Gamepad | null {
    if (this.gamepadIndex === null || this.mode !== "gamepad") return null;
    return navigator.getGamepads()[this.gamepadIndex] ?? null;
  }

  /**
   * 게임패드 진동 (노면요철·ABS·고속 잔떨림). strong: 큰 모터(묵직한 떨림), weak: 작은 모터(잔떨림), 0~1.
   * 매 프레임 불러도 되고, 0.1초마다 또는 세기가 바뀔 때만 보낸다.
   */
  rumble(strong: number, weak: number) {
    const act = this.pad()?.vibrationActuator;
    if (!act) return;
    const now = performance.now();
    if (now < this.pulseUntil) return;
    const [s0, w0] = this.rumbleLast;
    const changed = Math.abs(strong - s0) > 0.08 || Math.abs(weak - w0) > 0.08;
    if (!changed && now - this.rumbleSent < 100) return;
    if (strong < 0.02 && weak < 0.02 && s0 < 0.02 && w0 < 0.02) return;
    this.rumbleSent = now;
    this.rumbleLast = [strong, weak];
    void act.playEffect("dual-rumble", { duration: 140, strongMagnitude: clamp01(strong), weakMagnitude: clamp01(weak) }).catch(() => {});
  }

  /** 한 번 세게 (충돌·신축이음) */
  pulse(strong: number, weak: number, ms: number) {
    const act = this.pad()?.vibrationActuator;
    if (!act) return;
    this.pulseUntil = performance.now() + ms;
    void act.playEffect("dual-rumble", { duration: ms, strongMagnitude: clamp01(strong), weakMagnitude: clamp01(weak) }).catch(() => {});
  }

  private readGamepad(pad: Gamepad, snap: PadSnapshot, limit: number) {
    const c = this.controls;
    const x = snap.axes[0] ?? 0;
    // 휠은 돌린 각도 그대로, 패드 스틱은 가운데를 곱게 하고 빠를수록 덜 꺾이게
    c.steer = isWheel(pad.id) ? wheelSteer(x, this.wheelRange, this.car.maxSteer) : padSteer(x, limit);
    const cal = this.calibration;
    if (cal) {
      c.throttle = pedalValue(snap, cal.throttle);
      c.brake = pedalValue(snap, cal.brake);
    } else {
      // 일반 패드: RT(7) 가속, LT(6) 브레이크. 휠 페달은 축으로 들어오는 경우가 많다 (맞추기를 하면 그 축을 쓴다)
      const rt = trigger(snap.buttons[7] ?? 0);
      const lt = trigger(snap.buttons[6] ?? 0);
      const axisThrottle = snap.axes.length > 2 ? trigger((1 - (snap.axes[2] ?? 1)) / 2) : 0;
      const axisBrake = snap.axes.length > 3 ? trigger((1 - (snap.axes[3] ?? 1)) / 2) : 0;
      c.throttle = Math.max(rt, pad.mapping === "standard" ? 0 : axisThrottle);
      c.brake = Math.max(lt, pad.mapping === "standard" ? 0 : axisBrake);
    }

    const b = pad.buttons.map((x) => x.pressed);
    const edge = (i: number) => b[i] && !this.prevButtons[i];
    if (edge(4)) this.pendingActions.signalLeft = true; // LB
    if (edge(5)) this.pendingActions.signalRight = true; // RB
    if (edge(3)) this.pendingActions.camera = true; // Y
    if (edge(9)) this.pendingActions.pause = true; // Start
    if (edge(1)) this.pendingActions.hazard = true; // B
    if (edge(2)) this.pendingActions.horn = true; // X
    if (edge(8)) this.controls.reverse = !this.controls.reverse; // Back·Select: 후진 기어
    this.prevButtons = b;
  }
}

/**
 * 키보드 페달 한 걸음.
 * hold: ↑를 누르는 동안 서서히 깊게 밟고, 떼면 그 깊이를 그대로 둔다 (속도·엔진 회전수가 그 자리에서 자리 잡는다).
 *       ↓를 누르면 먼저 가속 페달에서 발을 떼고, 다 뗀 뒤에도 누르고 있으면 브레이크를 밟는다. 브레이크는 떼면 풀린다.
 * momentary: 누르는 동안만 밟히고 떼면 곧 풀린다.
 */
export function pedalStep(mode: PedalMode, throttle: number, brake: number, up: boolean, down: boolean, dt: number, upFor = 1, downFor = 1): { throttle: number; brake: number } {
  if (mode === "momentary") {
    return { throttle: approach(throttle, up ? 1 : 0, dt * (up ? 2.2 : 5)), brake: approach(brake, down ? 1 : 0, dt * (down ? 2.5 : 6)) };
  }
  if (down) {
    const lift = downFor < PEDAL.liftFineFor ? PEDAL.fine : PEDAL.lift;
    if (throttle > 0) return { throttle: Math.max(0, throttle - dt * lift), brake: approach(brake, 0, dt * PEDAL.brakeRelease) };
    return { throttle: 0, brake: approach(brake, 1, dt * PEDAL.brake) };
  }
  const press = upFor < PEDAL.fineFor ? PEDAL.fine : PEDAL.press;
  return { throttle: up ? Math.min(1, throttle + dt * press) : throttle, brake: approach(brake, 0, dt * PEDAL.brakeRelease) };
}

/** 끝까지 꺾었을 때 옆 가속도 (m/s²): 느리면 STEER.latLow, 빠르면 latHigh, 감도 배율을 곱한다 */
export function latAccel(v: number, scale = 1): number {
  const t = clamp01((Math.abs(v) - STEER.lowV) / (STEER.highV - STEER.lowV));
  return (STEER.latLow + (STEER.latHigh - STEER.latLow) * t) * scale;
}

/**
 * 속도 v(m/s)에서 끝까지 꺾어도 옆 가속도가 aLat(m/s²)을 넘지 않는 조향 입력 (바퀴 최대각 대비 0~1).
 * 바퀴각 = (축간거리 + 언더스티어 × v²) × aLat / v² (빠를수록 같은 바퀴각에 덜 돌아서 그만큼 더 꺾게 둔다). 느리면 1(끝까지)
 */
export function steerLimit(v: number, aLat: number, car: SteerCar): number {
  const vv = Math.max(Math.abs(v), 1) ** 2;
  return Math.min(1, Math.atan(((car.wheelbase + car.understeer * vv) * aLat) / vv) / car.maxSteer);
}

/**
 * 키보드 핸들 한 걸음. x: 지금 꺾인 정도 (한계 대비 -1 왼쪽 ~ 1 오른쪽), want: 누른 쪽 (0이면 놓음),
 * heldFor: 그쪽을 이어서 누른 시간 (s), v: 속도 (m/s), rateScale: 감도 배율. 반대쪽으로 꺾여 있으면 놓을 때만큼 더 빨리 되돌린다
 */
export function keySteerStep(x: number, want: -1 | 0 | 1, heldFor: number, v: number, dt: number, rateScale = 1): number {
  const back = STEER.returnLow + (STEER.returnHigh - STEER.returnLow) * clamp01(Math.abs(v) / STEER.highV);
  if (want === 0) return approach(x, 0, dt * back);
  const t = clamp01((Math.abs(v) - STEER.lowV) / (STEER.highV - STEER.lowV));
  const rate = (STEER.lowRate + (STEER.highRate - STEER.lowRate) * t) * rateScale * (heldFor < STEER.fineFor ? STEER.fine : 1);
  return approach(x, want, dt * (rate + (x * want < 0 ? back : 0)));
}

/** 패드 스틱 조향: 가운데 흔들림을 빼고 곱게 편 뒤, 키보드 한계(limit)의 PAD.limit배까지만 */
export function padSteer(x: number, limit: number): number {
  const a = Math.abs(x);
  if (a < PAD.dead) return 0;
  const u = Math.min(1, (a - PAD.dead) / (1 - PAD.dead));
  return Math.sign(x) * Math.pow(u, PAD.power) * Math.min(1, limit * PAD.limit);
}

/**
 * 레이싱 휠: 돌린 각도 그대로 (곡선·속도 제한 없음). rangeDeg: 휠이 끝에서 끝까지 도는 각도.
 * 조향비는 휠을 끝까지 돌리면 앞바퀴도 끝까지 꺾이게 잡되 8:1~15:1 안 (승용차는 보통 13~16:1). 휠이 짧게 돌면 끝까지 꺾이지 않는다
 */
export function wheelSteer(x: number, rangeDeg: number, maxSteer: number): number {
  const half = rangeDeg / 2;
  const lockDeg = (maxSteer * 180) / Math.PI;
  const ratio = Math.max(8, Math.min(15, half / lockDeg));
  return Math.max(-1, Math.min(1, (x * half) / ratio / lockDeg));
}

const WHEEL_ID = /wheel|racing|driving force|\bg2[579]\b|g9[02]0|g923|dfgt|t150|t248|t300|tmx|t500|t-gt|thrustmaster|fanatec|moza|simucube|simagic/i;

/** 게임패드 이름으로 레이싱 휠인지 */
export function isWheel(id: string): boolean {
  return WHEEL_ID.test(id);
}

export function snapshot(pad: Gamepad): PadSnapshot {
  return { axes: Array.from(pad.axes), buttons: pad.buttons.map((b) => b.value) };
}

/** 키보드를 쓰는 사이 패드·휠을 크게 움직였는지 (페달·스틱을 0.3 넘게, 또는 버튼을 눌렀다) */
export function padMoved(base: PadSnapshot, now: PadSnapshot): boolean {
  for (let i = 0; i < now.axes.length; i++) if (Math.abs(now.axes[i] - (base.axes[i] ?? 0)) > 0.3) return true;
  for (let i = 0; i < now.buttons.length; i++) if (now.buttons[i] > 0.5 && (base.buttons[i] ?? 0) <= 0.5) return true;
  return false;
}

/** 맞춘 페달 값 0~1 (밟기 시작 3%는 흘린다) */
export function pedalValue(s: PadSnapshot, p: PedalAxis): number {
  const v = (p.kind === "axis" ? s.axes[p.index] : s.buttons[p.index]) ?? p.rest;
  const span = p.full - p.rest;
  if (Math.abs(span) < 1e-3) return 0;
  const t = clamp01((v - p.rest) / span);
  return t < 0.03 ? 0 : (t - 0.03) / 0.97;
}

/**
 * 휠·페달 맞추기: 페달을 끝까지 밟았다 뗀 동안의 기록에서 가장 크게 움직인 축(또는 버튼)을 찾는다.
 * 뗀 값(마지막)이 rest, 거기서 가장 먼 값이 full (크롬은 한 번 움직이기 전까지 축을 0으로 주기도 해서 처음 값은 믿지 않는다).
 * 밟기 전에도 rest 근처였어야 뗀 것으로 본다 (아직 밟고 있으면 마지막 값이 rest가 아니다).
 * 조향 축(0)과 이미 고른 페달(skip)은 뺀다. 덜 움직였거나 아직 안 뗐으면 null
 */
export function detectPedal(frames: PadSnapshot[], skip: PedalAxis[] = []): PedalAxis | null {
  if (frames.length < 2) return null;
  const last = frames[frames.length - 1];
  let best: PedalAxis | null = null;
  let bestRange = 0;
  const scan = (kind: PedalAxis["kind"], count: number, get: (f: PadSnapshot, i: number) => number) => {
    for (let i = 0; i < count; i++) {
      if (kind === "axis" && i === 0) continue;
      if (skip.some((p) => p.kind === kind && p.index === i)) continue;
      const rest = get(last, i);
      let lo = Infinity;
      let hi = -Infinity;
      let full = rest;
      let at = 0;
      frames.forEach((f, k) => {
        const v = get(f, i);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        if (Math.abs(v - rest) > Math.abs(full - rest)) {
          full = v;
          at = k;
        }
      });
      const range = hi - lo;
      const released = frames.slice(0, at).some((f) => Math.abs(get(f, i) - rest) < 0.15);
      if (released && range >= 0.4 && Math.abs(full - rest) >= 0.4 && range > bestRange) {
        bestRange = range;
        best = { kind, index: i, rest, full };
      }
    }
  };
  scan("axis", last.axes.length, (f, i) => f.axes[i] ?? 0);
  scan("button", last.buttons.length, (f, i) => f.buttons[i] ?? 0);
  return best;
}

function trigger(v: number): number {
  return v < PAD.trigDead ? 0 : Math.min(1, (v - PAD.trigDead) / (1 - PAD.trigDead));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function approach(x: number, target: number, maxDelta: number): number {
  if (x < target) return Math.min(target, x + maxDelta);
  return Math.max(target, x - maxDelta);
}

function blank(): InputActions {
  return { signalLeft: false, signalRight: false, hazard: false, camera: false, pause: false, horn: false, mirrors: false, help: false, lka: false };
}
