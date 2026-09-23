// 테스트용 가짜 도로와 설정. 실제 데이터 파일(public/data)을 그대로 쓴다.

import vehicles from "../../public/data/vehicles.json";
import profiles from "../../public/data/driver_profiles.json";
import traffic from "../../public/data/traffic_defaults.json";
import rules from "../../public/data/rules_kr.json";
import quality from "../../public/data/data_quality.json";
import { Road, type RoadFile } from "../road/road";
import type { DriverProfiles, GameConfig, Rules, TrafficDefaults } from "../sim/config";
import type { VehicleCatalog } from "../render/vehicleModels";
import type { QualityRules } from "../log/quality";

/** 동쪽으로 곧게 뻗은 길. curveFrom 뒤로는 반지름 radius로 왼쪽으로 굽는다 */
export function makeRoad(opts: { length?: number; lanes?: number; speed?: number; tunnel?: [number, number]; bridges?: [number, number][]; curveFrom?: number; radius?: number; junctions?: [number, string, string][]; ref?: string; from?: string; to?: string; hill?: (s: number) => number } = {}): Road {
  const length = opts.length ?? 5000;
  const step = 10;
  const n = Math.round(length / step) + 1;
  const pts: [number, number][] = [];
  let x = 1000000;
  let y = 1900000;
  let h = 0;
  for (let i = 0; i < n; i++) {
    pts.push([x, y]);
    const s = i * step;
    if (opts.curveFrom !== undefined && s >= opts.curveFrom) h += step / (opts.radius ?? 500);
    x += Math.cos(h) * step;
    y += Math.sin(h) * step;
  }
  const dx: number[] = [];
  const dy: number[] = [];
  let qx = Math.round(pts[0][0] * 10);
  let qy = Math.round(pts[0][1] * 10);
  for (let i = 1; i < n; i++) {
    const nx = Math.round(pts[i][0] * 10);
    const ny = Math.round(pts[i][1] * 10);
    dx.push(nx - qx);
    dy.push(ny - qy);
    qx = nx;
    qy = ny;
  }
  const structure: [number, number][] = [[0, 0]];
  const spans: [number, number, number][] = [...(opts.tunnel ? [[opts.tunnel[0], opts.tunnel[1], 1] as [number, number, number]] : []), ...(opts.bridges ?? []).map(([a, b]) => [a, b, 2] as [number, number, number])];
  for (const [a, b, k] of spans.sort((x, y) => x[0] - y[0])) structure.push([a, k], [b, 0]);
  const f: RoadFile = {
    id: "test",
    ref: opts.ref ?? "1",
    name: "시험고속도로",
    from: opts.from ?? "가",
    to: opts.to ?? "나",
    length,
    step,
    origin: pts[0],
    dx,
    dy,
    z: Array.from({ length: n }, (_, i) => Math.round(500 + 10 * (opts.hill?.(i * step) ?? 0))),
    lanes: [[0, opts.lanes ?? 3]],
    speed: [[0, opts.speed ?? 100]],
    speedHgv: [[0, 80]],
    minSpeed: [[0, 50]],
    structure,
    structureName: [[0, ""]],
    sectionName: [[0, "시험구간"]],
    junctions: opts.junctions ?? [],
    terrain: { step: 40, offsets: [-45, 45], rows: [] },
  };
  return new Road(f);
}

export function makeConfig(): GameConfig {
  return {
    catalog: vehicles as unknown as VehicleCatalog,
    profiles: profiles as unknown as DriverProfiles,
    traffic: traffic as unknown as TrafficDefaults,
    rules: rules as unknown as Rules,
    real: null,
    cameras: null,
    events: null,
    realWeather: null,
    quality: quality as unknown as QualityRules,
  };
}
