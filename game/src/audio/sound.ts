// 합성음: 엔진(audio/engine.ts), 타이어·노면(audio/road.ts), 주변 차(audio/traffic.ts), 바람(돌풍·A필러 휘파람),
// 타이어 노면음, 터널 울림, 방향지시등 딸깍 소리, 충돌(쿵·찌그러짐·유리), 경적(내 차와 뒤차), 대형차 에어브레이크,
// 빗소리와 젖은 노면 타이어 소리. 파일 없이 Web Audio로 만든다.
// 내비 음성 안내는 브라우저 음성 합성(ko-KR)을 쓰고, 한국어 음성이 없는 브라우저에서는 말하지 않는다.

import { EngineVoice, type SoundPowertrain } from "./engine";
import { RoadVoice } from "./road";
import { TrafficVoices, type NearbyCar } from "./traffic";

export type { SoundPowertrain } from "./engine";
export type { NearbyCar } from "./traffic";

/** 매 프레임 소리에 넘기는 주행 상태 */
export interface DriveAudio {
  dt: number;
  /** 엔진 회전수 (PlayerCar.revs) */
  revs: number;
  redline: number;
  throttle: number;
  brake: number;
  /** m/s */
  speed: number;
  inTunnel: boolean;
  /** 운전석 시점 (차 안에서 듣는 소리) */
  cockpit: boolean;
  slip: number;
  abs: boolean;
  surface: "dry" | "wet" | "ice";
  rumble: number;
  rumbleSide: number;
  scrape: number;
  scrapeSide: number;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private engine!: EngineVoice;
  private roadVoice!: RoadVoice;
  private trafficVoices!: TrafficVoices;
  private windGain!: GainNode;
  private whistleGain!: GainNode;
  private gustT = 0;
  private windFilter!: BiquadFilterNode;
  private tireGain!: GainNode;
  private tireFilter!: BiquadFilterNode;
  private wet!: GainNode;
  private noise!: AudioBuffer;
  private rainGain!: GainNode;
  private hissGain!: GainNode;
  private hissFilter!: BiquadFilterNode;
  private lastTick = -1;
  private pt: SoundPowertrain = "gasoline";
  private lastBrake = 0;
  private voice: SpeechSynthesisVoice | null = null;
  private paused = false;
  enabled = true;
  /** 내비 음성 안내 */
  voiceOn = true;
  /** 빗소리 세기 0~1 */
  rain = 0;
  /** 젖은 노면: 타이어가 물을 가르는 쉭 소리 */
  wetRoad = false;

  /** 사용자 입력(시작 버튼) 뒤에 불러야 소리가 난다 */
  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);
    // 모든 소리는 bus로 모이고, 터널에서는 짧은 메아리를 섞는다
    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.09;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const echoFilter = ctx.createBiquadFilter();
    echoFilter.type = "lowpass";
    echoFilter.frequency.value = 1800;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.bus.connect(delay);
    delay.connect(echoFilter).connect(feedback).connect(delay);
    echoFilter.connect(this.wet).connect(this.master);

    this.pickVoice();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.addEventListener("voiceschanged", () => this.pickVoice());

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      b = 0.97 * b + 0.03 * (Math.random() * 2 - 1);
      data[i] = b * 3;
    }
    const noiseSrc = () => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.start(0, Math.random() * 1.5);
      return src;
    };
    // 바람: 높은 대역
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noiseSrc().connect(this.windFilter).connect(this.windGain).connect(this.bus);
    // 타이어 노면음: 낮은 대역 웅웅거림
    this.tireFilter = ctx.createBiquadFilter();
    this.tireFilter.type = "lowpass";
    this.tireFilter.frequency.value = 200;
    this.tireGain = ctx.createGain();
    this.tireGain.gain.value = 0;
    noiseSrc().connect(this.tireFilter).connect(this.tireGain).connect(this.bus);
    // 비: 흰 잡음을 높은 대역으로 (지붕·유리에 떨어지는 소리), 젖은 노면: 속도에 따라 커지는 쉭 소리
    const white = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const whiteSrc = () => {
      const src = ctx.createBufferSource();
      src.buffer = white;
      src.loop = true;
      src.start(0, Math.random() * 1.5);
      return src;
    };
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = "bandpass";
    rainFilter.frequency.value = 3200;
    rainFilter.Q.value = 0.4;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    whiteSrc().connect(rainFilter).connect(this.rainGain).connect(this.bus);
    this.hissFilter = ctx.createBiquadFilter();
    this.hissFilter.type = "bandpass";
    this.hissFilter.frequency.value = 1500;
    this.hissFilter.Q.value = 0.7;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    whiteSrc().connect(this.hissFilter).connect(this.hissGain).connect(this.bus);
    // A필러 휘파람: 빠를 때 창틀에서 나는 가는 바람 소리
    const whistle = ctx.createBiquadFilter();
    whistle.type = "bandpass";
    whistle.frequency.value = 2300;
    whistle.Q.value = 14;
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    whiteSrc().connect(whistle).connect(this.whistleGain).connect(this.bus);

    this.engine = new EngineVoice(ctx, this.bus, this.noise);
    this.engine.setPowertrain(this.pt);
    this.roadVoice = new RoadVoice(ctx, this.bus, this.noise, white);
    this.trafficVoices = new TrafficVoices(ctx, this.bus, this.noise);
  }

  private pickVoice() {
    if (typeof speechSynthesis === "undefined") return;
    const ko = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("ko"));
    // 자연스러운 음성(Edge Natural, Google)을 먼저
    this.voice = ko.find((v) => /natural|online/i.test(v.name)) ?? ko.find((v) => /google/i.test(v.name)) ?? ko[0] ?? null;
  }

  /** 내비 음성 한 마디. force는 일시정지·끝난 뒤에도 말한다 (도착 안내) */
  say(text: string, force = false) {
    if (!this.enabled || !this.voiceOn || !this.voice || (this.paused && !force)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = this.voice;
    u.lang = this.voice.lang;
    u.rate = 1.08;
    u.volume = 0.9;
    speechSynthesis.speak(u);
  }

  setPowertrain(pt: SoundPowertrain) {
    this.pt = pt;
    this.engine?.setPowertrain(pt);
  }

  update(a: DriveAudio) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const on = this.enabled ? 1 : 0;
    const { speed, inTunnel, brake } = a;
    this.engine.update({ revs: a.revs, redline: a.redline, throttle: a.throttle, speed, cockpit: a.cockpit }, on, a.dt);
    this.roadVoice.update({ speed, slip: a.slip, abs: a.abs, surface: a.surface, rumble: a.rumble, rumbleSide: a.rumbleSide, scrape: a.scrape, scrapeSide: a.scrapeSide }, on);
    const kmh = speed * 3.6;
    // 바람: 빠를수록 크고, 돌풍처럼 천천히 일렁인다 (터널 안은 잔잔)
    this.gustT += a.dt;
    const gust = inTunnel ? 1 : 1 + 0.18 * Math.sin(this.gustT * 0.7) * Math.sin(this.gustT * 1.9 + 1.3) + 0.08 * Math.sin(this.gustT * 5.3);
    this.windFilter.frequency.setTargetAtTime(600 + kmh * 8, t, 0.2);
    this.windGain.gain.setTargetAtTime(on * gust * Math.min(0.45, (kmh / 130) ** 2 * 0.3) * (a.cockpit ? 0.85 : 1), t, 0.3);
    this.whistleGain.gain.setTargetAtTime(on * gust * Math.max(0, Math.min(1, (kmh - 95) / 60)) * 0.02 * (a.cockpit ? 1 : 0.3), t, 0.4);
    // 타이어 노면음: 터널 안에서는 벽에 울려 크게
    this.tireFilter.frequency.setTargetAtTime(140 + kmh * 2.2, t, 0.3);
    this.tireGain.gain.setTargetAtTime(on * Math.min(0.5, (kmh / 120) ** 1.4 * 0.28 * (inTunnel ? 1.5 : 1)), t, 0.3);
    this.wet.gain.setTargetAtTime(inTunnel ? 0.55 : 0, t, 0.4);
    // 터널 안에는 비가 들이치지 않고, 노면도 곧 마른다
    this.rainGain.gain.setTargetAtTime(on * this.rain * (inTunnel ? 0.08 : 0.16), t, 0.5);
    const wet = this.wetRoad && !inTunnel ? 1 : 0;
    this.hissFilter.frequency.setTargetAtTime(900 + kmh * 12, t, 0.3);
    this.hissGain.gain.setTargetAtTime(on * wet * Math.min(0.14, (kmh / 110) ** 1.5 * 0.11), t, 0.4);
    // 대형 디젤: 세게 밟던 브레이크를 떼면 에어브레이크 소리
    if (this.pt === "diesel_heavy" && this.lastBrake > 0.5 && brake < 0.1) this.air();
    this.lastBrake = brake;
  }

  private air() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    src.connect(f).connect(g).connect(this.bus);
    src.start();
    src.stop(ctx.currentTime + 0.55);
  }

  /** 와이퍼 날이 끝에 닿는 소리: 고무가 유리를 쓰는 '슥' + 멈추는 '툭' */
  wiper() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || this.paused) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1500;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + 0.18);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(140, t0);
    o.frequency.exponentialRampToValueAtTime(70, t0 + 0.08);
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(0.06, t0 + 0.01);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.1);
    o.connect(og).connect(this.bus);
    o.start(t0);
    o.stop(t0 + 0.12);
  }

  /** 단속 카메라 앞 과속 경고음 (띵동) */
  chime() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || this.paused) return;
    [1318, 1046].forEach((freq, i) => {
      const t0 = ctx.currentTime + i * 0.22;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
      o.connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + 0.5);
    });
  }

  /** 차로 유지 보조 경고: 넘으려는 쪽에서 짧게 세 번 (띠띠띠) */
  laneWarn(side: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || this.paused) return;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, side * 0.7));
    pan.connect(this.master);
    for (let i = 0; i < 3; i++) {
      const t0 = ctx.currentTime + i * 0.11;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = 1480;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.075);
      o.connect(g).connect(pan);
      o.start(t0);
      o.stop(t0 + 0.09);
    }
  }

  /** 방향지시등이 켜져 있는 동안 매 프레임 호출 */
  signal(on: boolean, time: number) {
    if (!this.ctx || !this.enabled) return;
    const phase = Math.floor(time * 3.2);
    if (on && phase !== this.lastTick) {
      this.lastTick = phase;
      this.click(phase % 2 === 0 ? 2400 : 1900);
    }
  }

  private click(freq: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 0.04);
  }

  /** 주변 차 (가까운 순서) */
  traffic(cars: NearbyCar[], cockpit: boolean) {
    if (!this.ctx) return;
    this.trafficVoices.update(cars, this.enabled ? 1 : 0, cockpit);
  }

  /** 변속 */
  shift(up: boolean) {
    if (!this.ctx || this.paused) return;
    this.engine.shift(up, this.enabled ? 1 : 0);
  }

  /** 신축이음·이음매를 넘는 소리 */
  thump(strength: number, pan = 0) {
    if (!this.ctx || this.paused) return;
    this.roadVoice.thump(strength, this.enabled ? 1 : 0, pan);
  }

  /** 충돌: 차체가 받는 낮은 쿵, 찌그러지는 금속, 세면 유리 깨지는 소리. side: -1 왼쪽, 1 오른쪽 */
  crash(strength: number, side = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t0 = ctx.currentTime;
    const k = Math.max(0.05, Math.min(1, strength));
    const pan = ctx.createStereoPanner();
    pan.pan.value = side * 0.5;
    pan.connect(this.bus);
    // 쿵
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(70, t0);
    o.frequency.exponentialRampToValueAtTime(32, t0 + 0.35);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(0.9 * k, t0 + 0.01);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
    o.connect(og).connect(pan);
    o.start(t0);
    o.stop(t0 + 0.5);
    // 찌그러짐
    const noiseHit = (type: BiquadFilterType, freq: number, q: number, level: number, dur: number, delay = 0) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + delay);
      g.gain.exponentialRampToValueAtTime(level, t0 + delay + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + delay + dur);
      src.connect(f).connect(g).connect(pan);
      src.start(t0 + delay, Math.random());
      src.stop(t0 + delay + dur + 0.05);
    };
    noiseHit("lowpass", 1200, 0.7, Math.min(1.2, 0.3 + k), 0.8);
    noiseHit("bandpass", 2400, 1.5, 0.5 * k, 0.35, 0.02);
    // 유리: 세게 부딪히면 높은 파편 소리가 흩어진다
    if (k > 0.6) {
      for (let i = 0; i < 7; i++) {
        const d = 0.04 + Math.random() * 0.35;
        const p = ctx.createOscillator();
        p.type = "sine";
        p.frequency.value = 3200 + Math.random() * 4200;
        const pg = ctx.createGain();
        pg.gain.setValueAtTime(0.0001, t0 + d);
        pg.gain.exponentialRampToValueAtTime(0.05 * k, t0 + d + 0.003);
        pg.gain.exponentialRampToValueAtTime(0.0005, t0 + d + 0.09);
        p.connect(pg).connect(pan);
        p.start(t0 + d);
        p.stop(t0 + d + 0.12);
      }
      noiseHit("highpass", 5000, 0.7, 0.25 * k, 0.5, 0.03);
    }
  }

  /** 다른 차의 경적 (끼어들어 급제동하게 만든 뒤차 등). pan: -1 왼쪽 ~ 1 오른쪽, dist: m */
  hornFrom(pan: number, dist: number, heavy: boolean, long = false) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || this.paused) return;
    const t0 = ctx.currentTime;
    const level = 0.06 / (1 + (dist / 25) ** 2) + 0.012;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200 - Math.min(1200, dist * 12);
    lp.connect(p).connect(this.bus);
    const base = heavy ? 230 : 380 + Math.random() * 80;
    const dur = long ? 0.9 : 0.28;
    // 짧게 두 번 또는 길게 한 번
    const beeps = long ? [0] : [0, 0.36];
    for (const d of beeps) {
      for (const ratio of heavy ? [1, 1.26, 1.5] : [1, 1.19]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sawtooth";
        o.frequency.value = base * ratio;
        g.gain.setValueAtTime(0.0001, t0 + d);
        g.gain.exponentialRampToValueAtTime(level, t0 + d + 0.015);
        g.gain.setValueAtTime(level, t0 + d + dur - 0.05);
        g.gain.exponentialRampToValueAtTime(0.0005, t0 + d + dur);
        o.connect(g).connect(lp);
        o.start(t0 + d);
        o.stop(t0 + d + dur + 0.02);
      }
    }
  }

  horn() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    // 대형차는 낮고 굵은 경적
    const freqs = this.pt === "diesel_heavy" ? [220, 277, 330] : [420, 500];
    for (const freq of freqs) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sawtooth";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      g.gain.setValueAtTime(0.08, ctx.currentTime + 0.45);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
      o.connect(g).connect(this.bus);
      o.start();
      o.stop(ctx.currentTime + 0.6);
    }
  }

  suspend() {
    void this.ctx?.suspend();
    this.paused = true;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  resume() {
    void this.ctx?.resume();
    this.paused = false;
  }
}
