// 타이어·노면 소리: 한계에서 우는 타이어(마른 노면만), ABS가 브레이크를 잡았다 놓는 드르륵, 갓길 노면요철(럼블 스트립)을 밟는 부르릉,
// 교량 신축이음을 넘는 덜컥(앞바퀴·뒷바퀴 두 번), 가드레일·중앙분리대에 긁히는 쇳소리. 옆에서 나는 소리는 좌우로 나눠 들린다.

export interface RoadInput {
  /** m/s */
  speed: number;
  /** 타이어 한계 대비 (PlayerCar.slip) */
  slip: number;
  abs: boolean;
  surface: "dry" | "wet" | "ice";
  /** 노면요철을 밟은 정도 (0~1)와 쪽 (-1 왼쪽, 1 오른쪽) */
  rumble: number;
  rumbleSide: number;
  /** 벽에 긁히는 정도 (0~1)와 쪽 */
  scrape: number;
  scrapeSide: number;
}

export class RoadVoice {
  private squealGain: GainNode;
  private squealFilter: BiquadFilterNode;
  private squealTone: OscillatorNode;
  private absGain: GainNode;
  private absDepth: GainNode;
  private rumbleOsc: OscillatorNode;
  private rumbleGain: GainNode;
  private rumblePan: StereoPannerNode;
  private scrapeGain: GainNode;
  private scrapeFilter: BiquadFilterNode;
  private scrapePan: StereoPannerNode;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private noise: AudioBuffer,
    white: AudioBuffer,
  ) {
    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(0, Math.random() * 1.5);
      return s;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type: BiquadFilterType, freq: number, q = 1) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };

    // 타이어 울음: 좁은 대역 잡음 + 떨리는 고음
    this.squealGain = gain();
    this.squealFilter = filter("bandpass", 1000, 7);
    loop(white).connect(this.squealFilter).connect(this.squealGain);
    this.squealTone = ctx.createOscillator();
    this.squealTone.type = "triangle";
    this.squealTone.frequency.value = 1050;
    const vib = ctx.createOscillator();
    vib.frequency.value = 7;
    const vibDepth = gain(35);
    vib.connect(vibDepth).connect(this.squealTone.frequency);
    const toneGain = gain(0.25);
    this.squealTone.connect(toneGain).connect(this.squealGain);
    this.squealTone.start();
    vib.start();
    this.squealGain.connect(out);

    // ABS: 낮은 웅웅거림을 초당 14번 끊는다 (기본 음량 + 사각파로 흔드는 양)
    const absOsc = ctx.createOscillator();
    absOsc.type = "square";
    absOsc.frequency.value = 55;
    this.absGain = gain();
    absOsc.connect(filter("lowpass", 260)).connect(this.absGain).connect(out);
    const lfo = ctx.createOscillator();
    lfo.type = "square";
    lfo.frequency.value = 14;
    this.absDepth = gain();
    lfo.connect(this.absDepth).connect(this.absGain.gain);
    absOsc.start();
    lfo.start();

    // 노면요철: 30cm 간격 홈을 밟는 톱니 소리 (속도 ÷ 간격 Hz) + 잡음
    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = "sawtooth";
    this.rumbleGain = gain();
    this.rumblePan = ctx.createStereoPanner();
    this.rumbleOsc.connect(filter("lowpass", 420, 2)).connect(this.rumbleGain);
    const rn = gain(0.5);
    loop(noise).connect(filter("lowpass", 300)).connect(rn).connect(this.rumbleGain);
    this.rumbleGain.connect(this.rumblePan).connect(out);
    this.rumbleOsc.start();

    // 긁힘: 쇠가 끌리는 높은 잡음
    this.scrapeFilter = filter("bandpass", 2600, 1.2);
    this.scrapeGain = gain();
    this.scrapePan = ctx.createStereoPanner();
    loop(white).connect(this.scrapeFilter).connect(this.scrapeGain).connect(this.scrapePan).connect(out);
  }

  update(r: RoadInput, on: number) {
    const t = this.ctx.currentTime;
    const moving = Math.min(1, r.speed / 6);
    // 마른 노면에서만 운다 (젖으면 물을 가르는 소리, 얼음은 조용히 미끄러진다)
    const wetK = r.surface === "dry" ? 1 : r.surface === "wet" ? 0.12 : 0;
    const squeal = Math.max(0, Math.min(1, (r.slip - 0.82) / 0.3)) * moving * wetK;
    const absSqueal = r.abs && r.surface === "dry" ? 0.35 * moving : 0;
    const sq = Math.max(squeal, absSqueal);
    this.squealFilter.frequency.setTargetAtTime(850 + sq * 450, t, 0.05);
    this.squealTone.frequency.setTargetAtTime(980 + sq * 260, t, 0.05);
    this.squealGain.gain.setTargetAtTime(on * sq * 0.07, t, 0.04);

    const abs = r.abs ? 0.05 * moving : 0;
    this.absGain.gain.setTargetAtTime(on * abs * 0.5, t, 0.02);
    this.absDepth.gain.setTargetAtTime(on * abs * 0.5, t, 0.02);

    this.rumbleOsc.frequency.setTargetAtTime(Math.max(20, r.speed / 0.3), t, 0.03);
    this.rumbleGain.gain.setTargetAtTime(on * r.rumble * Math.min(1, r.speed / 8) * 0.22, t, 0.02);
    this.rumblePan.pan.setTargetAtTime(r.rumbleSide * 0.6, t, 0.05);

    this.scrapeFilter.frequency.setTargetAtTime(1800 + Math.min(1, r.speed / 30) * 1600 + Math.random() * 400, t, 0.02);
    this.scrapeGain.gain.setTargetAtTime(on * r.scrape * 0.75, t, 0.03);
    this.scrapePan.pan.setTargetAtTime(r.scrapeSide * 0.8, t, 0.05);
  }

  /** 신축이음·포장 이음매 한 번: 낮은 '덜'과 짧은 '컥' */
  thump(strength: number, on: number, pan = 0) {
    if (on <= 0 || strength <= 0.01) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.out);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(85, t0);
    o.frequency.exponentialRampToValueAtTime(42, t0 + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(0.32 * strength, t0 + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.16);
    o.connect(og).connect(p);
    o.start(t0);
    o.stop(t0 + 0.2);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 900;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.5 * strength, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.06);
    src.connect(f).connect(g).connect(p);
    src.start(t0, Math.random());
    src.stop(t0 + 0.08);
  }
}
