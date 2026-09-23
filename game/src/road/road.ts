// 주행선 한 줄. pipeline/osm_roads.py가 만든 JSON을 풀어서, 거리 s(m)로 위치·방향·차로·제한속도를 바로 찾을 수 있게 한다.
//
// 좌표계
//   E, N  : UTM-K 동쪽·북쪽(m). 파이썬 파이프라인과 같은 값.
//   s     : 주행선 시작점부터 잰 거리(m)
//   d     : 주행선 중심에서 진행 방향 오른쪽으로 잰 거리(m). 차로 번호는 왼쪽(중앙분리대 쪽)부터 1차로.
//   heading: 동쪽 기준 반시계 방향 각도(rad)

import type { CityInfo } from "../city/route";

export const LANE_WIDTH = 3.6;
export const RIGHT_SHOULDER = 3.0;
export const LEFT_SHOULDER = 1.0;
export const MEDIAN_WIDTH = 3.0; // 좌우 갓길 끝에서 반대편 갓길 끝까지 (분리대 포함)
/**
 * 높이 고르기 반 폭 (m). 파일의 높이는 0.1m 단위라 점 간격(고속도로 10m, 시내 2m)마다 기울기가 1~5%씩 튀어
 * 오르막·내리막에서 차와 화면이 덜컥거린다. 앞뒤 이만큼을 두 번 평균 내어 매끄럽게 한다
 */
const Z_SMOOTH = 12;

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
  /** dx·dy 한 칸의 길이 (m). 없으면 0.1 (고속도로). 시내는 점 간격이 2m라 0.01 */
  unit?: number;
  /** z 한 칸의 높이 (m). 없으면 0.1. 시내는 그린 차도 높이와 맞게 0.001 */
  zUnit?: number;
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
  /** 경로(여러 주행선을 이어 붙인 도로)일 때만: 구간마다 원래 노선 번호 */
  refs?: Run<string>[];
  /** 경로일 때만: 이어 붙인 조각들 */
  legs?: LegInfo[];
  /** 시내 도로일 때만: 반대편 차로·중앙선·교차로 구간·정지선 (city/route.ts) */
  city?: CityInfo;
}

/** 경로 조각: 이어 붙인 도로의 s0~s1이 원래 주행선 road의 src0~src1 */
export interface LegInfo {
  road: string;
  ref: string;
  name: string;
  from: string;
  to: string;
  s0: number;
  s1: number;
  src0: number;
  src1: number;
  /** 이 조각으로 들어올 때 지난 분기점 이름 (첫 조각은 "") */
  via: string;
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
  /** 점마다 기울기 (앞뒤 점으로 잰 것, 점 사이는 선형 보간) */
  private readonly gradeAt: Float64Array;
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
  /** 경로일 때 조각들 (한 주행선이면 그 주행선 전체 한 조각) */
  readonly legs: LegInfo[];
  readonly isRoute: boolean;
  /** 차로 폭 (고속도로 3.6m, 시내 3.25m) */
  readonly laneWidth: number;
  /** 시내 도로 정보 (고속도로는 null) */
  readonly city: CityInfo | null;
  /** 시내: 반대 방향 차로 수, 우리 차도 왼쪽 끝에서 반대편 차도까지 거리, 분리대가 연석인지 */
  private readonly oppLanes: Uint8Array | null = null;
  private readonly medianW: Float32Array | null = null;
  private readonly medianHard: Uint8Array | null = null;
  /** 시내: 교차로 안인지 (0 밖, 1 안) */
  private readonly box: Uint8Array | null = null;
  private readonly refs: Run<string>[];

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
    const per = Math.round(1 / (f.unit ?? 0.1));
    let qx = Math.round(f.origin[0] * per);
    let qy = Math.round(f.origin[1] * per);
    this.e[0] = qx / per;
    this.nn[0] = qy / per;
    for (let i = 1; i < n; i++) {
      qx += f.dx[i - 1];
      qy += f.dy[i - 1];
      this.e[i] = qx / per;
      this.nn[i] = qy / per;
    }
    const zUnit = f.zUnit ?? 0.1;
    for (let i = 0; i < n; i++) this.z[i] = (f.z[i] ?? f.z[f.z.length - 1] ?? 0) * zUnit;
    // 0.1m로 자른 높이만 고른다 (시내처럼 곱게 적힌 높이는 화면에 그린 차도 높이 그대로 둔다)
    if (zUnit >= 0.05) {
      const zw = Math.max(1, Math.round(Z_SMOOTH / f.step));
      for (let pass = 0; pass < 2; pass++) boxSmooth(this.z, zw);
    }
    this.gradeAt = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      this.gradeAt[i] = b > a ? (this.z[b] - this.z[a]) / ((b - a) * f.step) : 0;
    }

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

    this.city = f.city ?? null;
    this.laneWidth = f.city?.laneWidth ?? LANE_WIDTH;
    this.lanes = Uint8Array.from(expandRuns(f.lanes, n, f.step, 2));
    this.speed = Uint8Array.from(expandRuns(f.speed, n, f.step, 100));
    this.speedHgv = Uint8Array.from(expandRuns(f.speedHgv, n, f.step, 80));
    this.minSpeed = Uint8Array.from(expandRuns(f.minSpeed, n, f.step, 50));
    this.structure = Uint8Array.from(expandRuns(f.structure, n, f.step, 0));

    // 폭: 차로 수 변화는 약 200m에 걸쳐 서서히 (시내는 교차로 앞뒤에서 바뀌므로 약 20m)
    this.width = new Float32Array(n);
    const target = new Float32Array(n);
    for (let i = 0; i < n; i++) target[i] = this.lanes[i] * this.laneWidth;
    const half = Math.round((f.city ? 10 : 100) / f.step);
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
    if (f.city) {
      const c = f.city;
      this.oppLanes = Uint8Array.from(expandRuns(c.oppLanes, n, f.step, 0));
      this.medianW = Float32Array.from(expandRuns(c.median, n, f.step, 0));
      this.medianHard = Uint8Array.from(expandRuns(c.medianKind, n, f.step, 0));
      this.box = new Uint8Array(n);
      // 1 = 교차로, 2 = 갈라지기·합치기만 하는 곳
      for (const [s0, s1, , minor] of c.boxes) for (let i = Math.max(0, Math.floor(s0 / f.step)); i <= Math.min(n - 1, Math.ceil(s1 / f.step)); i++) this.box[i] = minor ? 2 : 1;
    }
    this.isRoute = !!f.legs?.length;
    this.legs = f.legs?.length
      ? f.legs
      : [{ road: f.id, ref: f.ref, name: f.name, from: f.from, to: f.to, s0: 0, s1: this.length, src0: 0, src1: this.length, via: "" }];
    this.refs = f.refs?.length ? f.refs : [[0, f.ref]];
  }

  static async load(id: string, base = "./roads/"): Promise<Road> {
    const res = await fetch(`${base}${id}.json`);
    if (!res.ok) throw new Error(`도로 데이터를 불러오지 못했습니다 (${id}, ${res.status})`);
    return new Road((await res.json()) as RoadFile);
  }

  index(s: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.round(s / this.step)));
  }

  /** s 위치의 중심선 정보. 점 사이는 선형 보간 (높이만 3차) */
  sample(s: number, out: RoadSample = {} as RoadSample): RoadSample {
    const f = Math.min(Math.max(s / this.step, 0), this.n - 1.000001);
    const i = Math.floor(f);
    const t = f - i;
    const j = i + 1;
    out.e = this.e[i] + (this.e[j] - this.e[i]) * t;
    out.n = this.nn[i] + (this.nn[j] - this.nn[i]) * t;
    // 높이는 점마다 기울기를 맞춘 3차 곡선으로 이어서 오르내림이 점에서 꺾이지 않게 한다
    const t2 = t * t;
    const t3 = t2 * t;
    out.z = (2 * t3 - 3 * t2 + 1) * this.z[i] + (3 * t2 - 2 * t3) * this.z[j] + (t3 - 2 * t2 + t) * this.step * this.gradeAt[i] + (t3 - t2) * this.step * this.gradeAt[j];
    const te = this.te[i] + (this.te[j] - this.te[i]) * t;
    const tn = this.tn[i] + (this.tn[j] - this.tn[i]) * t;
    const len = Math.hypot(te, tn) || 1;
    out.te = te / len;
    out.tn = tn / len;
    out.heading = Math.atan2(out.tn, out.te);
    out.kappa = this.kappa[i] + (this.kappa[j] - this.kappa[i]) * t;
    out.grade = this.gradeAt[i] + (this.gradeAt[j] - this.gradeAt[i]) * t;
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
    return -this.widthAt(s) / 2 + (lane - 0.5) * this.laneWidth;
  }

  /** d가 속한 차로 번호 (차도 밖이면 0 또는 lanes+1) */
  laneOf(d: number, s: number): number {
    const w = this.widthAt(s);
    const x = d + w / 2;
    if (x < 0) return 0;
    const lanes = this.lanesAt(s);
    const lane = Math.floor(x / this.laneWidth) + 1;
    return Math.min(lane, lanes + 1);
  }

  /** 시내: 반대 방향 차로 수 (고속도로는 우리와 같은 수) */
  oppLanesAt(s: number): number {
    return this.oppLanes ? this.oppLanes[this.index(s)] : this.lanesAt(s);
  }

  /** 시내: 우리 차도 왼쪽 끝에서 반대편 차도까지 (m). 고속도로는 분리대 3m */
  medianAt(s: number): number {
    return this.medianW ? this.medianW[this.index(s)] : 3;
  }

  /** 가운데가 넘을 수 없는 분리대(방호벽·연석)인지 */
  hardMedianAt(s: number): boolean {
    return this.medianHard ? this.medianHard[this.index(s)] === 1 : true;
  }

  /** 시내: 교차로 안인지 (정지선에서 건너편 도로 시작까지) */
  inBox(s: number): boolean {
    return this.box ? this.box[this.index(s)] === 1 : false;
  }

  /** 시내: 교차로나 갈라지기·합치기 곡선 위인지 (여기서 차로 번호가 들어온 도로에서 나갈 도로로 바뀐다) */
  inJunction(s: number): boolean {
    return this.box ? this.box[this.index(s)] > 0 : false;
  }

  /**
   * 차가 닿는 벽의 d (왼쪽, 오른쪽): 고속도로는 중앙분리대·가드레일, 시내는 연석(보도)과 반대편 차도 바깥 연석.
   * 시내 교차로 안은 넓게 열고, 교차로 끝 6m에 걸쳐 모서리 연석으로 좁힌다.
   */
  walls(s: number): [number, number] {
    const w = this.widthAt(s);
    if (!this.city) return [-w / 2 - LEFT_SHOULDER - 0.1, w / 2 + RIGHT_SHOULDER + 0.35];
    const curb = (at: number): [number, number] => {
      const ww = this.widthAt(at);
      const right = ww / 2 + 0.45;
      const opp = this.oppLanesAt(at);
      const left = opp > 0 && !this.hardMedianAt(at) ? -ww / 2 - this.medianAt(at) - opp * this.laneWidth - 0.45 : -ww / 2 - 0.35;
      return [left, right];
    };
    if (!this.inBox(s)) {
      // 교차로 바로 앞뒤: 모서리를 돌아 나가는 곳이라 조금씩 넓힌다
      let near = Infinity;
      for (let k = 1; k <= 3; k++) {
        if (this.inBox(s + k * 2)) near = Math.min(near, k * 2);
        if (this.inBox(s - k * 2)) near = Math.min(near, k * 2);
      }
      const [l, r] = curb(s);
      if (near === Infinity) return [l, r];
      const open = (1 - near / 8) * 6;
      return [l - open, r + open];
    }
    return [-w / 2 - 30, w / 2 + 30];
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

  /** s 위치의 노선 번호 (경로는 구간마다 다르다) */
  refAt(s: number): string {
    let ref = this.refs[0][1];
    for (const r of this.refs) {
      if (r[0] <= s) ref = r[1];
      else break;
    }
    return ref;
  }

  /** s 위치가 속한 조각. 연결로 위면 다음 조각 */
  legAt(s: number): LegInfo {
    for (const l of this.legs) if (s < l.s1) return l;
    return this.legs[this.legs.length - 1];
  }

  /** s가 연결로(조각과 조각 사이) 위인가 */
  onConnector(s: number): boolean {
    if (!this.isRoute) return false;
    const l = this.legAt(s);
    return s < l.s0;
  }

  /** 원래 주행선에서의 위치 (연결로 위면 다음 조각의 시작) */
  sourceAt(s: number): { road: string; s: number } {
    const l = this.legAt(s);
    return { road: l.road, s: l.src0 + Math.max(0, s - l.s0) };
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

/** 앞뒤 w점 이동 평균 (양 끝은 있는 점만) */
function boxSmooth(v: Float64Array, w: number) {
  const n = v.length;
  if (n < 3) return;
  const src = Float64Array.from(v);
  let sum = 0;
  let cnt = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    while (hi < Math.min(n - 1, i + w)) sum += src[++hi], cnt++;
    while (lo < i - w) sum -= src[lo++], cnt--;
    v[i] = sum / cnt;
  }
}
