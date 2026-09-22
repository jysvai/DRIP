import { describe, expect, it } from "vitest";
import { destPhrase, turnPhrase } from "./hud";

describe("내비 음성 안내 문장", () => {
  const v = { via: "신갈JC", road: "영동고속도로", to: "강릉" };
  it("분기점 거리별", () => {
    expect(turnPhrase(2000, "left", v)).toBe("2킬로미터 앞, 신갈분기점에서 영동고속도로 강릉 방향, 왼쪽 방향입니다.");
    expect(turnPhrase(1000, "right", v)).toBe("1킬로미터 앞, 신갈분기점에서 영동고속도로 강릉 방향, 오른쪽 방향입니다.");
    expect(turnPhrase(300, "left", v)).toBe("잠시 후 신갈분기점에서 왼쪽 방향입니다.");
    expect(turnPhrase(300, "straight", v)).toBe("잠시 후 강릉 방향으로 직진입니다.");
    // 처음 볼 때 이미 가까우면 실제 거리로
    expect(turnPhrase(1496, "left", v)).toBe("1.5킬로미터 앞, 신갈분기점에서 영동고속도로 강릉 방향, 왼쪽 방향입니다.");
    expect(turnPhrase(994, "left", v)).toBe("1킬로미터 앞, 신갈분기점에서 영동고속도로 강릉 방향, 왼쪽 방향입니다.");
    expect(turnPhrase(640, "left", v)).toBe("600미터 앞, 신갈분기점에서 영동고속도로 강릉 방향, 왼쪽 방향입니다.");
  });
  it("목적지", () => {
    expect(destPhrase(1995)).toBe("목적지까지 2킬로미터 남았습니다.");
    expect(destPhrase(500)).toBe("잠시 후 목적지 부근입니다.");
  });
});
