// 키보드·마우스·게임패드(레이싱 휠 포함) 입력을 하나의 조작값으로 만든다.

import type { Controls } from "./player";

export type InputMode = "keyboard" | "mouse" | "gamepad";

export interface InputActions {
  signalLeft: boolean;
  signalRight: boolean;
  hazard: boolean;
  camera: boolean;
  pause: boolean;
  horn: boolean;
  mirrors: boolean;
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

export class Input {
  mode: InputMode = "keyboard";
  controls: Controls = { throttle: 0, brake: 0, steer: 0, reverse: false };
  private pressed = new Set<string>();
  private throttleKey = 0;
  private brakeKey = 0;
  private steerKey = 0;
  private mouseX = 0.5;
  private gamepadIndex: number | null = null;
  private prevButtons: boolean[] = [];
  private pendingActions: InputActions = blank();

  constructor(target: HTMLElement) {
    window.addEventListener("keydown", this.onKey, { passive: false });
    window.addEventListener("keyup", this.onKey);
    // 창 밖을 누르면 keyup이 오지 않아 가속 키가 눌린 채로 남는다
    window.addEventListener("blur", () => {
      keysDown.up = keysDown.down = keysDown.left = keysDown.right = false;
      this.pressed.clear();
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
    const k = KEYMAP[e.code];
    if (k) {
      keysDown[k] = down;
      e.preventDefault();
    }
    if (down && !e.repeat) {
      switch (e.code) {
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
        case "KeyM":
          this.mode = this.mode === "mouse" ? "keyboard" : "mouse";
          break;
        case "KeyR":
          this.controls.reverse = !this.controls.reverse;
          break;
      }
    }
    if (down) this.pressed.add(e.code);
    else this.pressed.delete(e.code);
  };

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

    // 키보드 페달은 눌린 시간만큼 서서히 올라간다
    this.throttleKey = approach(this.throttleKey, keysDown.up ? 1 : 0, dt * (keysDown.up ? 2.2 : 5));
    this.brakeKey = approach(this.brakeKey, keysDown.down ? 1 : 0, dt * (keysDown.down ? 2.5 : 6));
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

function approach(x: number, target: number, maxDelta: number): number {
  if (x < target) return Math.min(target, x + maxDelta);
  return Math.max(target, x - maxDelta);
}

function blank(): InputActions {
  return { signalLeft: false, signalRight: false, hazard: false, camera: false, pause: false, horn: false, mirrors: false };
}
