// 주행선 한 줄. pipeline/osm_roads.py가 만든 JSON을 풀어서, 거리 s(m)로 위치·방향·차로·제한속도를 바로 찾을 수 있게 한다.
//
// 좌표계
//   E, N  : UTM-K 동쪽·북쪽(m). 파이썬 파이프라인과 같은 값.
//   s     : 주행선 시작점부터 잰 거리(m)
//   d     : 주행선 중심에서 진행 방향 오른쪽으로 잰 거리(m). 차로 번호는 왼쪽(중앙분리대 쪽)부터 1차로.
//   heading: 동쪽 기준 반시계 방향 각도(rad)

export const LANE_WIDTH = 3.6;
export const RIGHT_SHOULDER = 3.0;
export const LEFT_SHOULDER = 1.0;
export const MEDIAN_WIDTH = 3.0; // 좌우 갓길 끝에서 반대편 갓길 끝까지 (분리대 포함)

export const enum Structure {
  Normal = 0,
  Tunnel = 1,
  Bridge = 2,
}

export interface RoadIndexEntry {
  id: string;
  ref: string;
  name: string;
  from: string;
  to: string;
  lengthKm: number;
  lanes: number;
  junctions: number;
  tunnels: number;
  bridges: number;
}

export interface RoadIndex {
  source: string;
  osmTimestamp: string;
  roads: RoadIndexEntry[];
}

type Run<T> = [number, T];

export interface RoadFile {
  id: string;
  ref: string;
  name: string;
  from: string;
  to: string;
  length: number;
  step: number;
  origin: [number, number];
  dx: number[];
  dy: number[];
  z: number[];
  lanes: Run<number>[];
  speed: Run<number>[];
  speedHgv: Run<number>[];
  minSpeed: Run<number>[];
  structure: Run<number>[];
  structureName: Run<string>[];
  sectionName: Run<string>[];
  junctions: [number, string, string][];
  terrain: { step: number; offsets: number[]; rows: number[][] };
}

export interface Junction {
  s: number;
  name: string;
  exitNo: string;
  kind: "IC" | "JC" | "TG" | "SA" | "기타";
}

export interface StructureSpan {
  kind: Structure;
  s0: number;
  s1: number;
  name: string;
}

export interface RoadSample {
  e: number;
  n: number;
  z: number;
  /** 진행 방향 단위벡터 (동, 북) */
  te: number;
  tn: number;
  heading: number;
  /** 곡률(1/m). 왼쪽으로 굽으면 + */
  kappa: number;
  /** 경사 (올라가면 +) */
  grade: number;
}

function expandRuns<T>(runs: Run<T>[], n: number, step: number, fill: T): T[] {
  const out = new Array<T>(n).fill(fill);
  for (let r = 0; r < runs.length; r++) {
    const i0 = Math.max(0, Math.round(runs[r][0] / step));
    const i1 = r + 1 < runs.length ? Math.round(runs[r + 1][0] / step) : n;
    for (let i = i0; i < Math.min(i1, n); i++) out[i] = runs[r][1];
  }
  return out;
}

// OSM 나들목 이름은 "수원신갈"처럼 IC가 빠져 있거나 "기흥 휴게소 (부산 방향)"처럼 덧붙은 말이 있다
function junctionKind(name: string, exitNo: string): Junction["kind"] {
  if (/분기점|JCT?\b|JC$/i.test(name)) return "JC";
  if (/요금소|톨게이트|TG$/i.test(name)) return "TG";
  if (/휴게소|졸음쉼터|쉼터|SA$/i.test(name)) return "SA";
  if (/나들목|IC\b|IC$/i.test(name)) return "IC";
  if (/하이패스/.test(name)) return "기타";
  if (exitNo) return "IC";
  return "기타";
}

function shortJunctionName(name: string, kind: Junction["kind"]): string {
  let n = name
    .replace(/\s*\([^)]*방향\)\s*/g, "")
    .replace("분기점", "JC")
    .replace("나들목", "IC")
    .replace("요금소", "TG")
    .replace(/\s+(IC|JC|TG)$/, "$1")
    .trim();
  if (kind === "IC" && !/IC$/.test(n)) n += "IC";
  return n;
}

export class Road {
  readonly id: string;
  readonly ref: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly length: number;
  readonly step: number;
  readonly n: number;
  readonly e: Float64Array;
  readonly nn: Float64Array;
  readonly z: Float64Array;
  readonly te: Float64Array;
  readonly tn: Float64Array;
  readonly kappa: Float64Array;
  readonly lanes: Uint8Array;
  /** 차로 수가 바뀌는 곳에서 폭이 부드럽게 변하도록 만든 차도 폭(m) */
  readonly width: Float32Array;
  readonly speed: Uint8Array;
  readonly speedHgv: Uint8Array;
  readonly minSpeed: Uint8Array;
  readonly structure: Uint8Array;
  readonly structures: StructureSpan[];
  readonly sections: { s0: number; name: string }[];
  readonly junctions: Junction[];
  readonly terrain: RoadFile["terrain"];

  constructor(f: RoadFile) {
    this.id = f.id;
    this.ref = f.ref;
    this.name = f.name;
    this.from = f.from;
    this.to = f.to;
    this.step = f.step;
    const n = f.dx.length + 1;
    this.n = n;
    this.length = (n - 1) * f.step;

    this.e = new Float64Array(n);
    this.nn = new Float64Array(n);
    this.z = new Float64Array(n);
    let qx = Math.round(f.origin[0] * 10);
    let qy = Math.round(f.origin[1] * 10);
    this.e[0] = qx / 10;
    this.nn[0] = qy / 10;
    for (let i = 1; i < n; i++) {
      qx += f.dx[i - 1];
      qy += f.dy[i - 1];
      this.e[i] = qx / 10;
      this.nn[i] = qy / 10;
    }
    for (let i = 0; i < n; i++) this.z[i] = (f.z[i] ?? f.z[f.z.length - 1] ?? 0) / 10;

    // 방향과 곡률: 앞뒤 점으로 잰다
    this.te = new Float64Array(n);
    this.tn = new Float64Array(n);
    const heading = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const de = this.e[b] - this.e[a];
      const dn = this.nn[b] - this.nn[a];
      const len = Math.hypot(de, dn) || 1;
      this.te[i] = de / len;
      this.tn[i] = dn / len;
      heading[i] = Math.atan2(dn, de);
    }
    // 각도를 이어 붙여서(2π 점프 제거) 미분
    for (let i = 1; i < n; i++) {
      let dh = heading[i] - heading[i - 1];
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      heading[i] = heading[i - 1] + dh;
    }
    const rawK = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 2);
      const b = Math.min(n - 1, i + 2);
      rawK[i] = (heading[b] - heading[a]) / ((b - a) * f.step || 1);
    }
    // 곡률은 한 번 더 부드럽게 (물리 계산이 튀지 않게)
    this.kappa = new Float64Array(n);
    const w = 4;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let cnt = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) {
        sum += rawK[k];
        cnt++;
      }
      this.kappa[i] = sum / cnt;
    }

    this.lanes = Uint8Array.from(expandRuns(f.lanes, n, f.step, 2));
    this.speed = Uint8Array.from(expandRuns(f.speed, n, f.step, 100));
    this.speedHgv = Uint8Array.from(expandRuns(f.speedHgv, n, f.step, 80));
    this.minSpeed = Uint8Array.from(expandRuns(f.minSpeed, n, f.step, 50));
    this.structure = Uint8Array.from(expandRuns(f.structure, n, f.step, 0));

    // 폭: 차로 수 변화는 약 200m에 걸쳐 서서히
    this.width = new Float32Array(n);
    const target = new Float32Array(n);
    for (let i = 0; i < n; i++) target[i] = this.lanes[i] * LANE_WIDTH;
    const half = Math.round(100 / f.step);
    let acc = 0;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      acc += target[i];
      prefix[i + 1] = acc;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(n, i + half + 1);
      this.width[i] = (prefix[b] - prefix[a]) / (b - a);
    }

    const names = expandRuns(f.structureName, n, f.step, "");
    this.structures = [];
    for (let i = 0; i < n; ) {
      const kind = this.structure[i];
      let j = i;
      while (j < n && this.structure[j] === kind) j++;
      if (kind !== Structure.Normal) {
        this.structures.push({ kind: kind as Structure, s0: i * f.step, s1: j * f.step, name: names[i] });
      }
      i = j;
    }
    this.sections = f.sectionName.map(([s0, name]) => ({ s0, name }));
    this.junctions = f.junctions
      .filter(([, name]) => name)
      .map(([s, name, ref]) => {
        const kind = junctionKind(name, ref);
        return { s, name: shortJunctionName(name, kind), exitNo: ref, kind };
      });
    this.terrain = f.terrain;
  }

  static async load(id: string, base = "./roads/"): Promise<Road> {
    const res = await fetch(`${base}${id}.json`);
    if (!res.ok) throw new Error(`도로 데이터를 불러오지 못했습니다 (${id}, ${res.status})`);
    return new Road((await res.json()) as RoadFile);
  }

  index(s: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.round(s / this.step)));
  }

  /** s 위치의 중심선 정보. 점 사이는 선형 보간 */
  sample(s: number, out: RoadSample = {} as RoadSample): RoadSample {
    const f = Math.min(Math.max(s / this.step, 0), this.n - 1.000001);
    const i = Math.floor(f);
    const t = f - i;
    const j = i + 1;
    out.e = this.e[i] + (this.e[j] - this.e[i]) * t;
    out.n = this.nn[i] + (this.nn[j] - this.nn[i]) * t;
    out.z = this.z[i] + (this.z[j] - this.z[i]) * t;
    const te = this.te[i] + (this.te[j] - this.te[i]) * t;
    const tn = this.tn[i] + (this.tn[j] - this.tn[i]) * t;
    const len = Math.hypot(te, tn) || 1;
    out.te = te / len;
    out.tn = tn / len;
    out.heading = Math.atan2(out.tn, out.te);
    out.kappa = this.kappa[i] + (this.kappa[j] - this.kappa[i]) * t;
    out.grade = (this.z[j] - this.z[i]) / this.step;
    return out;
  }

  /** (s, d)의 지도 좌표. d는 오른쪽이 + */
  toWorld(s: number, d: number, out = { e: 0, n: 0, z: 0, heading: 0 }) {
    const p = this.sample(s, scratch);
    out.e = p.e + d * p.tn;
    out.n = p.n - d * p.te;
    out.z = p.z;
    out.heading = p.heading;
    return out;
  }

  lanesAt(s: number): number {
    return this.lanes[this.index(s)];
  }

  widthAt(s: number): number {
    const f = Math.min(Math.max(s / this.step, 0), this.n - 1.000001);
    const i = Math.floor(f);
    return this.width[i] + (this.width[i + 1] - this.width[i]) * (f - i);
  }

  /** lane: 1이 가장 왼쪽 차로 */
  laneCenter(lane: number, s: number): number {
    return -this.widthAt(s) / 2 + (lane - 0.5) * LANE_WIDTH;
  }

  /** d가 속한 차로 번호 (차도 밖이면 0 또는 lanes+1) */
  laneOf(d: number, s: number): number {
    const w = this.widthAt(s);
    const x = d + w / 2;
    if (x < 0) return 0;
    const lanes = this.lanesAt(s);
    const lane = Math.floor(x / LANE_WIDTH) + 1;
    return Math.min(lane, lanes + 1);
  }

  speedAt(s: number, heavy = false): number {
    const i = this.index(s);
    return heavy ? this.speedHgv[i] : this.speed[i];
  }

  structureAt(s: number): Structure {
    return this.structure[this.index(s)] as Structure;
  }

  sectionNameAt(s: number): string {
    let name = this.name;
    for (const sec of this.sections) {
      if (sec.s0 <= s) name = sec.name || name;
      else break;
    }
    return name;
  }

  nextJunction(s: number): Junction | undefined {
    return this.junctions.find((j) => j.s > s);
  }

  /** 주변 지형 높이(도로 높이 기준 상대값, m). offsets 열 k, s 위치 */
  terrainRel(s: number, k: number): number {
    const rows = this.terrain.rows;
    if (!rows.length) return -2;
    const f = Math.min(Math.max(s / this.terrain.step, 0), rows.length - 1.000001);
    const i = Math.floor(f);
    const t = f - i;
    const a = rows[i][k];
    const b = rows[Math.min(i + 1, rows.length - 1)][k];
    return a + (b - a) * t;
  }
}

const scratch = {} as RoadSample;
