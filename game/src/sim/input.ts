// 키보드·마우스·게임패드(레이싱 휠 포함) 입력을 하나의 조작값으로 만든다.

import type { Controls } from "./player";

export type InputMode = "keyboard" | "mouse" | "gamepad";
/** 키보드 페달: hold는 누른 만큼 밟히고 떼면 그 자리에 발을 둔다 (진짜 페달처럼 일정하게 밟고 달린다), momentary는 누르는 동안만 */
export type PedalMode = "hold" | "momentary";

/**
 * hold 페달 빠르기 (1초에 페달 깊이가 바뀌는 양). 고속도로 정속은 페달 15~30% 사이라 짧게 누르면 조금씩 바뀌게 한다.
 * ↑: 처음 0.4초는 fine, 그 뒤는 press. ↓: 처음 0.2초는 fine으로 조금 떼고, 더 누르면 lift로 다 뗀 뒤 brake로 밟는다.
 */
export const PEDAL = { fine: 0.35, press: 0.9, fineFor: 0.4, liftFineFor: 0.2, lift: 4, brake: 2.5, brakeRelease: 6 };

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
  controls: Controls = { throttle: 0, brake: 0, steer: 0, reverse: false };
  private pressed = new Set<string>();
  private throttleKey = 0;
  private brakeKey = 0;
  /** ↑·↓를 이어서 누른 시간 (s) */
  private upFor = 0;
  private downFor = 0;
  private steerKey = 0;
  private mouseX = 0.5;
  private gamepadIndex: number | null = null;
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
      this.mode = "gamepad";
    });
    window.addEventListener("gamepaddisconnected", () => {
      this.gamepadIndex = null;
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

  /** 이번 프레임에 눌린 버튼들 (한 번 읽으면 비워진다) */
  takeActions(): InputActions {
    const a = this.pendingActions;
    this.pendingActions = blank();
    return a;
  }

  update(dt: number, speed: number): Controls {
    const c = this.controls;
    const pad = this.gamepadIndex !== null ? navigator.getGamepads()[this.gamepadIndex] : null;
    if (pad && this.mode === "gamepad") {
      this.readGamepad(pad);
      return c;
    }

    this.upFor = keysDown.up ? this.upFor + dt : 0;
    this.downFor = keysDown.down ? this.downFor + dt : 0;
    const pedals = pedalStep(this.pedal, this.throttleKey, this.brakeKey, keysDown.up, keysDown.down, dt, this.upFor, this.downFor);
    this.throttleKey = pedals.throttle;
    this.brakeKey = pedals.brake;
    c.throttle = this.throttleKey;
    c.brake = this.brakeKey;

    // 키보드 조향: 속도가 높을수록 최대 조향각을 줄여 옆 가속도가 약 4m/s²를 넘지 않게 한다
    const v = Math.max(speed, 1);
    const limit = Math.min(1, (4.0 * 2.85) / (v * v) / 0.6 + 0.02);
    if (this.mode === "mouse") {
      const x = (this.mouseX - 0.5) * 2;
      const shaped = Math.sign(x) * Math.pow(Math.abs(x), 1.6);
      c.steer = shaped * Math.min(1, limit * 2.2);
    } else {
      const want = (keysDown.right ? 1 : 0) - (keysDown.left ? 1 : 0);
      this.steerKey = approach(this.steerKey, want, dt * (want !== 0 ? 1.6 : 4));
      c.steer = this.steerKey * limit;
    }
    return c;
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

  private readGamepad(pad: Gamepad) {
    const c = this.controls;
    const steer = pad.axes[0] ?? 0;
    const dead = Math.abs(steer) < 0.04 ? 0 : steer;
    // 레이싱 휠은 보통 900도 → 바퀴 약 35도. 조향비 약 15:1과 비슷하게 그대로 쓴다
    c.steer = Math.sign(dead) * Math.pow(Math.abs(dead), 1.3);
    // 일반 패드: RT(7) 가속, LT(6) 브레이크. 휠 페달은 축으로 들어오는 경우가 많다
    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;
    const axisThrottle = pad.axes.length > 2 ? (1 - (pad.axes[2] ?? 1)) / 2 : 0;
    const axisBrake = pad.axes.length > 3 ? (1 - (pad.axes[3] ?? 1)) / 2 : 0;
    c.throttle = Math.max(rt, pad.mapping === "standard" ? 0 : axisThrottle);
    c.brake = Math.max(lt, pad.mapping === "standard" ? 0 : axisBrake);

    const b = pad.buttons.map((x) => x.pressed);
    const edge = (i: number) => b[i] && !this.prevButtons[i];
    if (edge(4)) this.pendingActions.signalLeft = true; // LB
    if (edge(5)) this.pendingActions.signalRight = true; // RB
    if (edge(3)) this.pendingActions.camera = true; // Y
    if (edge(9)) this.pendingActions.pause = true; // Start
    if (edge(1)) this.pendingActions.hazard = true; // B
    if (edge(2)) this.pendingActions.horn = true; // X
    this.prevButtons = b;
  }
}

/**
 * 키보드 페달 한 걸음.
 * hold: ↑를 누르는 동안 서서히 깊게 밟고, 떼면 그 깊이를 그대로 둔다 (속도·엔진 회전수가 그 자리에서 자리 잡는다).
 *       ↓를 누르면 먼저 가속 페달에서 발을 떼고, 다 뗀 뒤에도 누르고 있으면 브레이크를 밟는다. 브레이크는 떼면 풀린다.
 * momentary: 누르는 동안만 밟히고 떼면 곧 풀린다.
 */
export function pedalStep(
  mode: PedalMode,
  throttle: number,
  brake: number,
  up: boolean,
  down: boolean,
  dt: number,
  upFor = 1,
  downFor = 1,
): { throttle: number; brake: number } {
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
