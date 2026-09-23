// 엔진 소리: 폭발 기본음 + 배음 + 저음(서브), 흡기 잡음, 터보 휘파람과 블로오프 밸브(가솔린·소형 디젤),
// 대형 디젤의 배기 브레이크 '두두두', 변속할 때 잠깐 꺼지는 소리, 전기차 인버터 고음. 파일 없이 Web Audio로 만든다.

export type SoundPowertrain = "gasoline" | "diesel_light" | "diesel_heavy" | "electric";

/** 동력원별 소리: 기본음 = rpm/60 × 폭발 수, 필터, 음량 */
const ENGINE: Record<
  SoundPowertrain,
  { fires: number; wave1: OscillatorType; wave2: OscillatorType; filter: number; filterThrottle: number; gain: number; gainThrottle: number; sub: number; intake: number; turbo: number }
> = {
  gasoline: { fires: 2, wave1: "sawtooth", wave2: "square", filter: 420, filterThrottle: 1100, gain: 0.045, gainThrottle: 0.075, sub: 0.35, intake: 0.05, turbo: 0.006 },
  diesel_light: { fires: 2, wave1: "sawtooth", wave2: "square", filter: 320, filterThrottle: 700, gain: 0.065, gainThrottle: 0.07, sub: 0.45, intake: 0.07, turbo: 0.011 },
  diesel_heavy: { fires: 3, wave1: "sawtooth", wave2: "square", filter: 210, filterThrottle: 560, gain: 0.085, gainThrottle: 0.085, sub: 0.6, intake: 0.09, turbo: 0.016 },
  electric: { fires: 4, wave1: "sine", wave2: "triangle", filter: 3200, filterThrottle: 0, gain: 0.006, gainThrottle: 0.02, sub: 0, intake: 0, turbo: 0 },
};

export interface EngineInput {
  /** 엔진 회전수 (PlayerCar.revs) */
  revs: number;
  redline: number;
  throttle: number;
  /** m/s */
  speed: number;
  /** 운전석 안에서 듣는지 (차 밖이면 배기음이 더 크고 밝다) */
  cockpit: boolean;
}

export class EngineVoice {
  private osc1: OscillatorNode;
  private osc2: OscillatorNode;
  private sub: OscillatorNode;
  private subGain: GainNode;
  private filter: BiquadFilterNode;
  private gain: GainNode;
  /** 변속할 때만 움직이는 음량 (매 프레임 음량과 따로) */
  private shiftGain: GainNode;
  private intakeFilter: BiquadFilterNode;
  private intakeGain: GainNode;
  private turbo: OscillatorNode;
  private turboGain: GainNode;
  private jake: OscillatorNode;
  private jakeFilter: BiquadFilterNode;
  private jakeGain: GainNode;
  private whine: OscillatorNode;
  private whineGain: GainNode;
  private pt: SoundPowertrain = "gasoline";
  private boost = 0;
  private lastThrottle = 0;
  private bovCooldown = 0;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private noise: AudioBuffer,
  ) {
    const osc = (type: OscillatorType) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.start();
      return o;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    this.shiftGain = gain(1);
    this.shiftGain.connect(out);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 900;
    this.filter.Q.value = 0.9;
    this.gain = gain();
    this.filter.connect(this.gain).connect(this.shiftGain);
    this.osc1 = osc("sawtooth");
    this.osc2 = osc("square");
    this.osc1.connect(this.filter);
    this.osc2.connect(this.filter);
    // 저음: 폭발음 반 옥타브 아래 (차체가 울리는 느낌)
    this.sub = osc("sine");
    this.subGain = gain();
    this.sub.connect(this.subGain).connect(this.gain);

    // 흡기: 밟을수록 커지는 거친 숨소리
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.start(0, Math.random());
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = "bandpass";
    this.intakeFilter.Q.value = 1.4;
    this.intakeGain = gain();
    src.connect(this.intakeFilter).connect(this.intakeGain).connect(this.shiftGain);

    // 터보: 과급이 오를수록 높고 커지는 휘파람
    this.turbo = osc("sine");
    this.turboGain = gain();
    this.turbo.connect(this.turboGain).connect(out);

    // 대형 디젤 배기 브레이크: 가속 페달을 떼면 배기를 막아 '두두두' 하고 운다
    this.jake = osc("square");
    this.jakeFilter = ctx.createBiquadFilter();
    this.jakeFilter.type = "lowpass";
    this.jakeFilter.frequency.value = 700;
    this.jakeGain = gain();
    this.jake.connect(this.jakeFilter).connect(this.jakeGain).connect(out);

    // 전기차 인버터 고음
    this.whine = osc("sine");
    this.whineGain = gain();
    this.whine.connect(this.whineGain).connect(out);
    this.setPowertrain("gasoline");
  }

  setPowertrain(pt: SoundPowertrain) {
    this.pt = pt;
    this.osc1.type = ENGINE[pt].wave1;
    this.osc2.type = ENGINE[pt].wave2;
  }

  update(e: EngineInput, on: number, dt: number) {
    const t = this.ctx.currentTime;
    const cfg = ENGINE[this.pt];
    const ev = this.pt === "electric";
    const f = 12 + (e.revs / 60) * cfg.fires;
    const inside = e.cockpit ? 1 : 0;
    this.osc1.frequency.setTargetAtTime(ev ? f : f * 2, t, 0.03);
    this.osc2.frequency.setTargetAtTime(ev ? f * 2.01 : f, t, 0.03);
    this.sub.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    // 운전석 안은 방음 때문에 어둡고 조금 작게, 밖은 배기음이 밝고 크게
    const bright = inside ? 0.85 : 1.3;
    this.filter.frequency.setTargetAtTime((cfg.filter + e.throttle * cfg.filterThrottle + e.revs * (ev ? 0 : 0.1)) * bright, t, 0.08);
    const evSpeed = ev ? Math.min(1, e.speed / 8) : 1;
    const level = (cfg.gain + e.throttle * cfg.gainThrottle) * evSpeed * (inside ? 1 : 1.2);
    this.gain.gain.setTargetAtTime(on * level, t, 0.08);
    this.subGain.gain.setTargetAtTime(cfg.sub * (0.5 + 0.5 * e.throttle), t, 0.1);
    this.intakeFilter.frequency.setTargetAtTime(f * 3.2, t, 0.05);
    this.intakeGain.gain.setTargetAtTime(on * cfg.intake * e.throttle ** 1.5 * Math.min(1, e.revs / Math.max(1, e.redline) + 0.2), t, 0.06);

    // 터보: 과급은 가속 페달과 rpm을 0.6초쯤 늦게 따라간다
    const want = ev ? 0 : Math.min(1, e.throttle * Math.min(1, (e.revs / Math.max(1, e.redline)) * 1.6));
    this.boost = Math.max(0, this.boost + (want - this.boost) * Math.min(1, dt * (want > this.boost ? 1.7 : 4)));
    this.turbo.frequency.setTargetAtTime(2400 + this.boost * 6500, t, 0.05);
    this.turboGain.gain.setTargetAtTime(on * cfg.turbo * this.boost ** 1.5, t, 0.05);
    // 블로오프: 과급이 찬 채로 페달을 확 떼면 '피슉'
    this.bovCooldown -= dt;
    if ((this.pt === "gasoline" || this.pt === "diesel_light") && this.lastThrottle > 0.55 && e.throttle < 0.1 && this.boost > 0.45 && this.bovCooldown <= 0) {
      this.blowoff(on * this.boost);
      this.bovCooldown = 1.2;
    }
    this.lastThrottle = e.throttle;

    // 배기 브레이크 (대형 디젤, 시속 30km 넘게 페달을 뗐을 때)
    const jake = this.pt === "diesel_heavy" && e.throttle < 0.05 && e.speed > 8.3 && e.revs > 1000 ? 1 : 0;
    this.jake.frequency.setTargetAtTime((e.revs / 60) * 3, t, 0.05);
    this.jakeGain.gain.setTargetAtTime(on * jake * 0.035 * Math.min(1, (e.revs - 900) / 600), t, 0.12);

    // 전기차: 모터 회전을 따라 오르는 가는 고음
    this.whine.frequency.setTargetAtTime(300 + e.revs * 0.55, t, 0.05);
    this.whineGain.gain.setTargetAtTime(on * (ev ? 0.004 + 0.01 * e.throttle : 0) * Math.min(1, e.speed / 5), t, 0.1);
  }

  /** 변속: 올릴 때는 토크가 빠지는 동안 소리가 푹 꺼졌다 돌아오고, 대형차는 공기 변속기가 '칙' */
  shift(up: boolean, on: number) {
    if (this.pt === "electric") return;
    const t = this.ctx.currentTime;
    const g = this.shiftGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(up ? 0.45 : 1.15, t, 0.02);
    g.setTargetAtTime(1, t + (up ? 0.12 : 0.08), 0.06);
    if (this.pt === "diesel_heavy") this.burst(on * 0.05, 3200, 0.12, "highpass");
  }

  private blowoff(level: number) {
    this.burst(level * 0.09, 1800, 0.35, "bandpass", 3800);
  }

  /** 짧은 잡음 한 번 (공기 빠지는 소리) */
  private burst(level: number, freq: number, dur: number, type: BiquadFilterType, sweepTo?: number) {
    if (level <= 0.001) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(level, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    src.connect(f).connect(g).connect(this.out);
    src.start(t0, Math.random());
    src.stop(t0 + dur + 0.05);
  }
}
