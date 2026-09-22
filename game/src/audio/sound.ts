// 합성음: 엔진, 바람·노면 소음, 방향지시등 딸깍 소리, 충돌, 경적. 파일 없이 Web Audio로 만든다.

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineOsc!: OscillatorNode;
  private engineOsc2!: OscillatorNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private lastTick = -1;
  enabled = true;

  /** 사용자 입력(시작 버튼) 뒤에 불러야 소리가 난다 */
  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 900;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = "sawtooth";
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = "square";
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.engineOsc.start();
    this.engineOsc2.start();

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      b = 0.97 * b + 0.03 * (Math.random() * 2 - 1);
      data[i] = b * 3;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();
  }

  update(rpm: number, throttle: number, speed: number, inTunnel: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const on = this.enabled ? 1 : 0;
    const f = 18 + rpm / 60; // 4기통: 회전수/60 × 2 폭발 ≈ 기본음
    this.engineOsc.frequency.setTargetAtTime(f * 2, t, 0.05);
    this.engineOsc2.frequency.setTargetAtTime(f, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(400 + throttle * 900 + rpm * 0.1, t, 0.1);
    this.engineGain.gain.setTargetAtTime(on * (0.05 + throttle * 0.07), t, 0.1);
    const kmh = speed * 3.6;
    this.windFilter.frequency.setTargetAtTime(300 + kmh * 6, t, 0.2);
    this.windGain.gain.setTargetAtTime(on * Math.min(0.5, (kmh / 130) ** 2 * 0.35) * (inTunnel ? 1.8 : 1), t, 0.3);
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
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + 0.9);
  }

  horn() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    for (const freq of [420, 500]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sawtooth";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      g.gain.setValueAtTime(0.08, ctx.currentTime + 0.45);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
      o.connect(g).connect(this.master);
      o.start();
      o.stop(ctx.currentTime + 0.6);
    }
  }

  suspend() {
    void this.ctx?.suspend();
  }

  resume() {
    void this.ctx?.resume();
  }
}
