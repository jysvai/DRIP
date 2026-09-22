"""고속도로 사고를 1km 구간으로 묶어 사고다발구간과 게임 후보 구간을 뽑는다.

입력: 한국도로공사_고속도로 교통사고 상세현황 (2022~2024년, CP949 CSV)
출력:
  data/processed/accident_bins_1km.csv    노선·방향·1km 구간별 사고 수 (사고 없는 구간은 0)
  data/processed/candidate_segments.csv   게임 후보 구간 (다발구간과 평범한 구간이 섞인 곳)

실행: .venv\\Scripts\\python pipeline\\accident_hotspots.py
"""

import argparse
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW_PATH = ROOT / "data" / "raw" / "accidents" / "ex_accidents_2022_2024.csv"
OUT_DIR = ROOT / "data" / "processed"

# https://www.data.go.kr/data/15145192/fileData.do
SOURCE_URL = (
    "https://www.data.go.kr/cmm/cmm/fileDownload.do"
    "?atchFileId=FILE_000000003220244&fileDetailSn=1&insertDataPrcus=N"
)

# 원본에 섞여 있는 노선명 오타. 발견할 때마다 추가한다.
ROUTE_FIXES = {"서1울양양선": "서울양양선"}

COLUMNS = {
    "사고일자": "date",
    "사고시각": "time",
    "노선명": "route",
    "사고발생이정": "km",
    "방향": "direction",
    "사망": "deaths",
    "부상": "injuries",
    "원인": "cause",
}


def load_accidents(path: Path = RAW_PATH) -> pd.DataFrame:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(SOURCE_URL, path)
    df = pd.read_csv(path, encoding="cp949").rename(columns=COLUMNS)[list(COLUMNS.values())]
    df["route"] = df["route"].str.strip().replace(ROUTE_FIXES)
    df["direction"] = df["direction"].str.strip()
    df["km_bin"] = df["km"].floordiv(1).astype(int)
    return df


def count_bins(accidents: pd.DataFrame) -> pd.DataFrame:
    """노선·방향별 1km 구간 사고 수. 사고가 없는 구간도 0으로 채운다.

    노선 길이 정보가 아직 없어서, 그 노선에서 사고가 난 가장 작은~큰 이정을 노선 범위로 본다.
    """
    span = accidents.groupby("route")["km_bin"].agg(["min", "max"])
    counts = accidents.groupby(["route", "direction", "km_bin"]).agg(
        accidents=("km", "size"),
        deaths=("deaths", "sum"),
        injuries=("injuries", "sum"),
    )
    frames = []
    for (route, direction), group in counts.groupby(level=["route", "direction"]):
        lo, hi = span.loc[route]
        full = pd.MultiIndex.from_product(
            [[route], [direction], range(lo, hi + 1)], names=counts.index.names
        )
        frames.append(group.reindex(full, fill_value=0))
    return pd.concat(frames).reset_index()


def describe_causes(accidents: pd.DataFrame) -> str:
    return ", ".join(f"{cause} {n}" for cause, n in accidents["cause"].value_counts().items())


def find_candidates(
    bins: pd.DataFrame,
    accidents: pd.DataFrame,
    length_km: int,
    hot_threshold: int,
    min_hot: int,
    min_quiet_ratio: float,
) -> pd.DataFrame:
    """다발구간이 min_hot개 이상이면서 사고 없는 구간도 충분히 섞인 length_km 길이 구간을 찾는다.

    비교 대상(평범한 구간)이 있어야 "다발구간이라서 시뮬 사고가 많았다"를 검증할 수 있다.
    """
    rows = []
    for (route, direction), group in bins.groupby(["route", "direction"]):
        kms = group["km_bin"].to_numpy()
        counts = group["accidents"].to_numpy()
        windows = []
        for i in range(len(counts) - length_km + 1):
            window = counts[i : i + length_km]
            hot = int((window >= hot_threshold).sum())
            quiet = int((window == 0).sum())
            if hot >= min_hot and quiet >= min_quiet_ratio * length_km:
                windows.append((hot, int(window.sum()), i))

        # 같은 노선·방향 안에서는 겹치지 않게, 다발구간이 많은 곳부터 고른다.
        taken: list[int] = []
        for hot, total, i in sorted(windows, reverse=True):
            if any(abs(i - j) < length_km for j in taken):
                continue
            taken.append(i)
            start = int(kms[i])
            end = start + length_km
            window_bins = group[(group["km_bin"] >= start) & (group["km_bin"] < end)]
            hot_bins = window_bins[window_bins["accidents"] >= hot_threshold]
            inside = accidents[
                (accidents["route"] == route)
                & (accidents["direction"] == direction)
                & (accidents["km_bin"] >= start)
                & (accidents["km_bin"] < end)
            ]
            rows.append({
                "route": route,
                "direction": direction,
                "start_km": start,
                "end_km": end,
                "hot_bins": hot,
                "quiet_bins": int((window_bins["accidents"] == 0).sum()),
                "accidents": total,
                "deaths": int(window_bins["deaths"].sum()),
                "injuries": int(window_bins["injuries"].sum()),
                "hot_km": ", ".join(f"{k}({n})" for k, n in zip(hot_bins["km_bin"], hot_bins["accidents"])),
                "causes": describe_causes(inside),
            })

    columns = ["route", "direction", "start_km", "end_km", "hot_bins", "quiet_bins",
               "accidents", "deaths", "injuries", "hot_km", "causes"]
    return (
        pd.DataFrame(rows, columns=columns)
        .sort_values(["hot_bins", "accidents"], ascending=False)
        .reset_index(drop=True)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--length", type=int, default=15, help="후보 구간 길이(km)")
    parser.add_argument("--hot", type=int, default=4, help="다발구간 기준: 1km·한 방향·3년 사고 수")
    parser.add_argument("--min-hot", type=int, default=2, help="후보 구간에 필요한 다발구간 수")
    parser.add_argument("--min-quiet", type=float, default=0.4, help="사고 없는 구간의 최소 비율")
    parser.add_argument("--top", type=int, default=10, help="화면에 보여줄 후보 수")
    args = parser.parse_args()

    accidents = load_accidents()
    bins = count_bins(accidents)
    candidates = find_candidates(bins, accidents, args.length, args.hot, args.min_hot, args.min_quiet)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # utf-8-sig: 엑셀에서 열어도 한글이 깨지지 않는다.
    bins.to_csv(OUT_DIR / "accident_bins_1km.csv", index=False, encoding="utf-8-sig")
    candidates.to_csv(OUT_DIR / "candidate_segments.csv", index=False, encoding="utf-8-sig")

    hot_total = int((bins["accidents"] >= args.hot).sum())
    print(f"사고 {len(accidents)}건 · 1km 구간 {len(bins)}개 · 다발구간(≥{args.hot}건) {hot_total}개")
    print(f"후보 구간 {len(candidates)}개 (길이 {args.length}km, 다발구간 ≥{args.min_hot}개)\n")
    with pd.option_context("display.max_colwidth", 60, "display.width", 200):
        print(candidates.head(args.top).drop(columns=["deaths", "injuries"]).to_string())


if __name__ == "__main__":
    main()
