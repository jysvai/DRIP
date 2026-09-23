import { describe, expect, it } from "vitest";
import rulesJson from "../../public/data/data_quality.json";
import { assessSession, updateParticipant, type ParticipantHistory, type QualityRules } from "./quality";
import { SAMPLE_COLUMNS, type Sample } from "./recorder";

const RULES = rulesJson as unknown as QualityRules;

interface Row {
  kmh: number;
  flow?: number | null;
  limit?: number;
  lane?: number;
  lanes?: number;
  throttle?: number;
}

/** sec초 동안 같은 상태로 달린 1초 기록 */
function drive(sec: number, r: Row, t0 = 0): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < sec; i++) {
    const v: Record<string, number | null> = {
      t: t0 + i,
      s: 0,
      d: 0,
      lane: r.lane ?? 2,
      speed_kmh: r.kmh,
      ax: 0,
      ay: 0,
      headway_s: null,
      ttc_s: null,
      signal: 0,
      steer: 0.01,
      throttle: r.throttle ?? 0.3,
      brake: 0,
      limit_kmh: r.limit ?? 110,
      near_count: 3,
      flow_kmh: r.flow === undefined ? 100 : r.flow,
      lanes: r.lanes ?? 3,
    };
    out.push(SAMPLE_COLUMNS.map((c) => v[c]));
  }
  return out;
}

const crash = (relSpeedKmh: number) => ({ type: "crash", detail: { with: "guardrail", relSpeedKmh } });
const check = (samples: Sample[], events: { type: string; detail?: Record<string, unknown> }[] = []) => assessSession(SAMPLE_COLUMNS, samples, events, RULES);

describe("연구 데이터 품질 검사", () => {
  it("평범한 주행은 통과한다", () => {
    const q = check(drive(600, { kmh: 100 }));
    expect(q.ok).toBe(true);
    expect(q.metrics.distanceM).toBeGreaterThan(16000);
  });

  it("너무 짧은 주행은 올리지 않는다", () => {
    expect(check(drive(60, { kmh: 100 })).reasons).toContain("too_short");
  });

  it("정체 도로(흐름 30km/h)에서 150km/h로 달리면 거른다", () => {
    const q = check([...drive(200, { kmh: 30, flow: 30 }), ...drive(100, { kmh: 150, flow: 30 }, 200)]);
    expect(q.reasons).toContain("jam_speeding");
  });

  it("정체 끝을 보고 늦게 줄이는 정도는 거르지 않는다 (정체 세 번, 매번 10초)", () => {
    const rows: Sample[] = [];
    for (let k = 0; k < 3; k++) {
      rows.push(...drive(10, { kmh: 110, flow: 40 }, rows.length));
      rows.push(...drive(90, { kmh: 35, flow: 40 }, rows.length));
      rows.push(...drive(200, { kmh: 100 }, rows.length));
    }
    const q = check(rows);
    expect(q.metrics.jamSpeedingSec).toBe(30);
    expect(q.ok).toBe(true);
  });

  it("비어 있는 길에서 150km/h 과속은 연구 대상이라 남긴다", () => {
    expect(check(drive(900, { kmh: 150, flow: 110 })).ok).toBe(true);
  });

  it("110 도로에서 200km/h로 1분 넘게 달리면 거른다", () => {
    expect(check([...drive(300, { kmh: 100 }), ...drive(90, { kmh: 200 }, 300)]).reasons).toContain("extreme_speed");
  });

  it("10km 안에서 크게 네 번 부딪히면 거르고, 100km에 세 번이면 남긴다", () => {
    const short = check(drive(400, { kmh: 100 }), [crash(40), crash(30), crash(25), crash(60)]);
    expect(short.reasons).toContain("crashes");
    const long = check(drive(3600, { kmh: 100 }), [crash(40), crash(30), crash(25)]);
    expect(long.ok).toBe(true);
  });

  it("가드레일에 계속 기대 달리면(가벼운 접촉 12번) 거른다", () => {
    const events = Array.from({ length: 12 }, () => crash(6));
    const q = check(drive(600, { kmh: 100 }), events);
    expect(q.reasons).toContain("contacts");
    expect(q.reasons).not.toContain("crashes");
  });

  it("갓길을 오래 달리면 거르고, 잠깐 빠지는 것은 남긴다", () => {
    expect(check([...drive(400, { kmh: 100 }), ...drive(200, { kmh: 90, lane: 4 }, 400)]).reasons).toContain("shoulder");
    expect(check([...drive(580, { kmh: 100 }), ...drive(20, { kmh: 40, lane: 4 }, 580)]).ok).toBe(true);
  });

  it("흐르는 길에 세워 두면 거른다", () => {
    expect(check([...drive(200, { kmh: 100 }), ...drive(400, { kmh: 0, flow: 90 }, 200)]).reasons).toContain("idle");
  });

  it("조작 없이 켜 두기만 하면 거른다", () => {
    const rows = drive(600, { kmh: 80, throttle: 0 }).map((r) => {
      r[SAMPLE_COLUMNS.indexOf("steer")] = 0;
      return r;
    });
    expect(check(rows).reasons).toContain("no_input");
  });

  it("흐름을 모르는 곳(주변에 차가 적음)은 정체로 보지 않는다", () => {
    expect(check(drive(600, { kmh: 160, flow: null })).metrics.congestedSec).toBe(0);
  });
});

describe("참여자 거르기", () => {
  const run = (verdicts: boolean[]) => verdicts.reduce<ParticipantHistory>((h, ok) => updateParticipant(h, ok, RULES), { recent: [], flagged: false });

  it("최근 5번 중 3번 걸러지면 참여자를 거른다", () => {
    expect(run([true, false, true, false]).flagged).toBe(false);
    expect(run([true, false, true, false, false]).flagged).toBe(true);
  });

  it("거른 참여자도 잇따라 3번 정상으로 달리면 풀린다", () => {
    expect(run([false, false, false, true, true]).flagged).toBe(true);
    expect(run([false, false, false, true, true, true]).flagged).toBe(false);
  });
});
