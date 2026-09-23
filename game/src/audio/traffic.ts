// 주변 차 소리: 옆을 지나가는 차의 바람·타이어 소리(좌우로 나뉘고, 다가오면 높게 멀어지면 낮게 들리는 도플러)와
// 가까운 트럭·버스의 낮은 디젤 엔진음. 반대편 차로 차가 스쳐 가는 '쉭'도 여기서 난다.
// 가장 가까운 몇 대만 소리를 낸다 (목소리 VOICES개를 가까운 차에 나눠 준다).

export interface NearbyCar {
  /** 내 차 기준 앞(+)·뒤(-) 거리 (m) */
  dx: number;
  /** 내 차 기준 오른쪽(+) 거리 (m) */
  dy: number;
  /** 서로 멀어지는 속도 (m/s, 다가오면 음수) */
  vr: number;
  /** 그 차의 속력 (m/s) */
  v: number;
  /** 대형차 (트럭·버스) */
  heavy: boolean;
}

const VOICES = 4;
const SOUND_SPEED = 343;

interface Voice {
  filter: BiquadFilterNode;
  gain: GainNode;
  drone: OscillatorNode;
  droneGain: GainNode;
  pan: StereoPannerNode;
}

export class TrafficVoices {
  private voices: Voice[] = [];

  constructor(
    private ctx: AudioContext,
    out: AudioNode,
    noise: AudioBuffer,
  ) {
    for (let i = 0; i < VOICES; i++) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.start(0, Math.random() * 1.5);
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 600;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      src.connect(filter).connect(gain).connect(pan).connect(out);
      const drone = ctx.createOscillator();
      drone.type = "sawtooth";
      drone.frequency.value = 70;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 240;
      const droneGain = ctx.createGain();
      droneGain.gain.value = 0;
      drone.connect(lp).connect(droneGain).connect(pan);
      drone.start();
      this.voices.push({ filter, gain, drone, droneGain, pan });
    }
  }

  /** cars는 가까운 순서로 (앞의 VOICES대만 쓴다). cockpit이면 차 안이라 조금 작게 들린다 */
  update(cars: NearbyCar[], on: number, cockpit: boolean) {
    const t = this.ctx.currentTime;
    const damp = cockpit ? 0.7 : 1;
    for (let i = 0; i < VOICES; i++) {
      const v = this.voices[i];
      const c = cars[i];
      if (!c) {
        v.gain.gain.setTargetAtTime(0, t, 0.15);
        v.droneGain.gain.setTargetAtTime(0, t, 0.15);
        continue;
      }
      const r = Math.hypot(c.dx, c.dy);
      // 도플러: 다가오면 높게, 멀어지면 낮게
      const dop = SOUND_SPEED / (SOUND_SPEED + Math.max(-60, Math.min(60, c.vr)));
      const size = c.heavy ? 1.8 : 1;
      const loud = (size * Math.min(1.6, (c.v / 25) ** 1.4)) / (1 + (r / 7) ** 2);
      v.filter.frequency.setTargetAtTime((c.heavy ? 420 : 650) * dop * (0.8 + Math.min(0.6, c.v / 60)), t, 0.05);
      v.gain.gain.setTargetAtTime(on * damp * Math.min(0.16, loud * 0.12), t, 0.06);
      v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, c.dy / (Math.abs(c.dy) + 2 + Math.abs(c.dx) * 0.35))), t, 0.06);
      // 대형 디젤: 속도에 따라 1100~1700rpm 근처의 낮은 소리
      const rpm = 1000 + Math.min(700, c.v * 25);
      v.drone.frequency.setTargetAtTime(((rpm / 60) * 3 + 8) * dop, t, 0.08);
      v.droneGain.gain.setTargetAtTime(on * damp * (c.heavy ? Math.min(0.09, 0.08 / (1 + (r / 12) ** 2)) : 0), t, 0.1);
    }
  }
}
