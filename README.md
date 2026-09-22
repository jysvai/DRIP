# DRIP (Driving Practice) — 한국 도로 운전 시뮬레이터 & 공개 주행 데이터셋

실제 한국 고속도로 구간을 브라우저 운전 게임으로 만들고, 사람들이 남긴 사고·아차사고·법규 위반 위치가 **실제 사고다발구간과 얼마나 일치하는지** 검증한다. 모은 데이터는 공개 데이터셋으로 낸다.

사이트: https://jysvai.github.io/DRIP/ · 운전하기: https://jysvai.github.io/DRIP/play/ · 차량 도감: https://jysvai.github.io/DRIP/play/garage.html

> 예전 iOS 운전 습관 앱(HAD v0.1)은 `_archive/had-ios-app/`에 보관돼 있다.

## 분석 축

**사람별 — 운전 패턴.** 시뮬 운전자가 한국 교통법규를 얼마나 지키고, 어떤 행동을 얼마나 자주 하는지 본다.
방향지시등 사용률과 켠 시점, 실선 침범, 제한속도 초과, 안전거리 2초 미만 비율, 급가감속 빈도를 잰다.
이걸로 운전 성향을 분류하고, 설문(DBQ)에서 본인이 답한 것과 실제 행동을 비교한다.

**구간별 — 위험 지점.** 사람들의 기록을 도로 1km 구간으로 모아 실제 사고 데이터와 비교한다.

1. 실제 사고가 잦은 1km 구간일수록 시뮬에서도 사고·아차사고 비율이 높다.
2. 실제 사고 원인 유형(과속, 안전거리 미확보 등)이 많은 구간에서 시뮬의 해당 위반도 많다.
3. (참고) 방향지시등 없는 차선 변경이 몰리는 구간을 따로 지도에 표시한다. 실제 사고 원인에는 진로 변경 항목이 없어서 직접 검증은 못 한다.

## 진행 단계

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 사고 데이터 1km 집계 → 게임 후보 구간 선정 | 완료 |
| 2 | 전국 고속도로 운전 게임 + 법규 판정 + 주행 기록 저장 + 실제 교통 수집 | 시험판 공개. 남은 일: 본인 API 키 넣기, 한국 운전 습관 데이터 |
| 3 | 참가자 모집 → 실제 사고다발구간과 비교 | |
| 4 | 데이터셋 공개, AI 운전자 비교 | |

## 폴더

| 경로 | 내용 |
|---|---|
| `pipeline/` | 데이터 수집·가공 스크립트 (Python) |
| `game/` | 운전 게임 (Vite + TypeScript + three.js). 사이트의 `/play/`로 배포 |
| `game/public/roads/` | 전국 고속도로 주행선 129개 (`pipeline/osm_roads.py`가 만든 것) |
| `game/public/data/` | 차종 76가지, 운전 습관, 교통 기본값, 한국 법규 (JSON, 코드 수정 없이 바꿀 수 있음. `game/DATA.md` 참고) |
| `game/public/traffic/latest.json` | 전날 실제 교통 (주행선별 시간대 밀도·속도·차종 구성). `pipeline/traffic_ex.py`가 만든다 |
| `supabase/` | 주행 기록 DB 스키마 (브라우저 키는 넣기만 가능) |
| `web/` | 소개 페이지. main에 push하면 게임과 함께 GitHub Pages로 자동 배포 |
| `data/raw/` | 받은 원본 공공데이터 (git 제외, 스크립트가 다시 받음) |
| `data/processed/` | 가공 결과: 사고 1km 집계, 주행선 ↔ 이정 기준점(`road_km_anchors.csv`), 날짜별 실제 교통(`traffic/`) |

## 실행

```
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python pipeline\accident_hotspots.py   # 사고 1km 집계
.venv\Scripts\python pipeline\osm_roads.py           # 전국 고속도로 주행선 (OSM + 지형)

cd game
npm install
npm run dev      # http://localhost:5173 (주행), /garage.html (차량 도감)
npm test         # 도로·차 물리·교통·법규 판정 테스트
npm run build
```

게임에 기록 저장을 켜려면 `game/.env.local`에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`를 넣는다 (publishable 키만. secret 키는 절대 넣지 않는다).
배포 빌드는 저장소 변수(Settings → Variables)의 같은 이름 값을 쓴다.

검수용 주소: `/play/?road=r1-1&km=20&cam=chase&hour=22&preset=실제&auto=1` 처럼 붙이면 메뉴 없이 바로 시작한다 (`auto=1`은 자동 운전, 이렇게 연 주행은 서버에 올리지 않음).

API 키가 필요한 단계부터는 `.env.example`을 `.env`로 복사해 값을 채운다.

## 실제 교통 수집

| 스크립트 | 하는 일 | 키 |
|---|---|---|
| `pipeline/traffic_ex.py anchors` | 도로공사 VDS 8천여 곳 위치로 게임 주행선의 s ↔ 도로공사 이정(km) 기준점을 만든다 (85개 주행선). 사고 다발 구간 비교에 쓴다 | `EX_API_KEY` |
| `pipeline/traffic_ex.py daily` | 전날 AVC(차종 분류기) 15분 자료 → 주행선별 시간대 차로당 밀도·속도·차종 구성 → `game/public/traffic/latest.json`. 메뉴의 "실제 교통"이 이걸 쓴다 (측정 지점이 있는 36개 주행선, 출발 위치에서 가장 가까운 지점 값) | `EX_API_KEY` |
| `pipeline/events_its.py [--loop 5]` | ITS 돌발상황(사고·공사·고장·기상)을 받아 게임 주행선 위치를 붙여 쌓는다 | `ITS_API_KEY` |
| `pipeline/compare_hotspots.py` | 게임 주행 기록(Supabase)을 실제 사고 1km 구간과 비교 (가설 1·2) | DB |

- 키 없이 시험: `--key test` (포털 설명서의 예시 키. 도로공사는 실제 자료를 주지만 시험용, ITS는 고정 표본만 준다). 지금 저장소의 `latest.json`과 기준점은 이 예시 키로 한 번 만든 것이다.
- 매일 자동 수집: `.github/workflows/traffic.yml`이 매일 06:40(한국 시간)에 전날 자료를 받아 커밋하고 사이트를 다시 올린다. 저장소 비밀 `EX_API_KEY`가 있어야 돈다:
  `gh secret set EX_API_KEY` (붙여 넣기). `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`도 넣으면 AVC 원자료(차로별·차종별 속도)를 R2에 쌓는다.
- 도로공사 방향: E = 이정이 느는 쪽(종점 방향), S = 기점 방향. 경부선은 기점이 부산이라 E = 서울 방향.
- VDS 좌표가 비어 있는 노선(수도권제2순환선 일부, 세종포천선)과 민자 고속도로는 아직 기준점이 없다.

## 데이터 출처

- 한국도로공사, [고속도로 교통사고 상세현황](https://www.data.go.kr/data/15145192/fileData.do) (2022~2024)
- 도로 선형·차로 수·제한속도·터널·교량·나들목: © OpenStreetMap contributors (ODbL)
- 지형 높이: AWS Terrain Tiles (Mapzen terrarium, SRTM 등)
- 교통량·속도·차종(VDS·AVC): 한국도로공사 [고속도로 공공데이터 포털](https://data.ex.co.kr)
- 돌발상황: 국토교통부 [국가교통정보센터](https://www.its.go.kr/opendata/)
