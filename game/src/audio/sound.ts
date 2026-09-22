// 합성음: 엔진(가솔린·디젤·대형 디젤·전기 모터), 타이어 노면음, 바람, 터널 울림, 방향지시등 딸깍 소리,
// 충돌, 경적, 대형차 에어브레이크. 파일 없이 Web Audio로 만든다.
// 내비 음성 안내는 브라우저 음성 합성(ko-KR)을 쓰고, 한국어 음성이 없는 브라우저에서는 말하지 않는다.

export type SoundPowertrain = "gasoline" | "diesel_light" | "diesel_heavy" | "electric";

/** 동력원별 소리: 기본음 = rpm/60 × 폭발 수, 필터, 음량 */
const ENGINE: Record<SoundPowertrain, { fires: number; wave1: OscillatorType; wave2: OscillatorType; filter: number; filterThrottle: number; gain: number; gainThrottle: number }> = {
  gasoline: { fires: 2, wave1: "sawtooth", wave2: "square", filter: 400, filterThrottle: 900, gain: 0.05, gainThrottle: 0.07 },
  diesel_light: { fires: 2, wave1: "sawtooth", wave2: "square", filter: 320, filterThrottle: 650, gain: 0.07, gainThrottle: 0.07 },
  diesel_heavy: { fires: 3, wave1: "sawtooth", wave2: "square", filter: 220, filterThrottle: 520, gain: 0.09, gainThrottle: 0.08 },
  electric: { fires: 4, wave1: "sine", wave2: "triangle", filter: 3200, filterThrottle: 0, gain: 0.006, gainThrottle: 0.02 },
};

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private engineOsc!: OscillatorNode;
  private engineOsc2!: OscillatorNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private tireGain!: GainNode;
  private tireFilter!: BiquadFilterNode;
  private wet!: GainNode;
  private noise!: AudioBuffer;
  private lastTick = -1;
  private pt: SoundPowertrain = "gasoline";
  private lastBrake = 0;
  private voice: SpeechSynthesisVoice | null = null;
  private paused = false;
  enabled = true;
  /** 내비 음성 안내 */
  voiceOn = true;

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

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 900;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.bus);
    this.engineOsc.start();
    this.engineOsc2.start();
    this.setPowertrain(this.pt);

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
    if (!this.ctx) return;
    this.engineOsc.type = ENGINE[pt].wave1;
    this.engineOsc2.type = ENGINE[pt].wave2;
  }

  update(rpm: number, throttle: number, speed: number, inTunnel: boolean, brake = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const on = this.enabled ? 1 : 0;
    const e = ENGINE[this.pt];
    const f = 12 + (rpm / 60) * e.fires;
    this.engineOsc.frequency.setTargetAtTime(this.pt === "electric" ? f : f * 2, t, 0.05);
    this.engineOsc2.frequency.setTargetAtTime(this.pt === "electric" ? f * 2.01 : f, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(e.filter + throttle * e.filterThrottle + rpm * (this.pt === "electric" ? 0 : 0.1), t, 0.1);
    const evSpeed = this.pt === "electric" ? Math.min(1, speed / 8) : 1;
    this.engineGain.gain.setTargetAtTime(on * (e.gain + throttle * e.gainThrottle) * evSpeed, t, 0.1);
    const kmh = speed * 3.6;
    this.windFilter.frequency.setTargetAtTime(600 + kmh * 8, t, 0.2);
    this.windGain.gain.setTargetAtTime(on * Math.min(0.45, (kmh / 130) ** 2 * 0.3), t, 0.3);
    this.tireFilter.frequency.setTargetAtTime(140 + kmh * 2.2, t, 0.3);
    this.tireGain.gain.setTargetAtTime(on * Math.min(0.4, (kmh / 120) ** 1.4 * 0.28), t, 0.3);
    this.wet.gain.setTargetAtTime(inTunnel ? 0.55 : 0, t, 0.4);
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

  crash(strength: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 1200;
    g.gain.setValueAtTime(Math.min(1.2, 0.3 + strength), ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    src.connect(f).connect(g).connect(this.bus);
    src.start();
    src.stop(ctx.currentTime + 0.9);
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
