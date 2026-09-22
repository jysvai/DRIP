# 게임 데이터 파일

게임 속 교통·운전 습관·법규·차종은 모두 `public/data/`의 JSON 파일에서 읽는다. 코드를 고치지 않고 이 파일만 바꾸면 게임이 바뀐다.
고친 뒤에는 `npm test`로 형식을 검사한다 (`src/data.test.ts`).

| 파일 | 내용 | 지금 값 |
|---|---|---|
| `driver_profiles.json` | 운전 성향 (택시·버스·화물차·경차·초보·난폭 등)과 차종별 배정 | 가정값 |
| `traffic_defaults.json` | 교통량 단계, 시간대별 교통량, 차종 구성 | 가정값 |
| `rules_kr.json` | 플레이어 주행을 판정하는 한국 고속도로 법규 | 법 조문은 확인, 위험운전 수치는 확인 필요 |
| `vehicles.json` | 차종 76가지 (크기, 최고속도, 가속, 도색, 번호판, 교통 속 비율) | 제원 기반 |
| `../traffic/latest.json` | 전날 실제 교통 (수집기가 만든다) | 아직 없음 → API 키가 들어오면 생김 |

## 한국 운전 특징 넣기 (`driver_profiles.json`)

### 운전 성향 (`profiles`)

차 한 대가 생길 때마다 아래 값을 **정규분포 [평균, 표준편차]**에서 하나씩 뽑는다. 같은 성향이라도 차마다 조금씩 다르게 달린다.

| 항목 | 뜻 | 단위 | 모형 |
|---|---|---|---|
| `speedFactor` | 원하는 속도 = 제한속도 × 이 값 (차종 최고속도를 넘지 않음) | 배 | IDM v0 |
| `timeHeadway` | 앞차와 두려는 시간 간격 | 초 | IDM T |
| `minGap` | 정지했을 때 앞차와 간격 | m | IDM s0 |
| `accelScale` | 차종 최대 가속도에 곱하는 값 | 배 | IDM a |
| `comfortDecel` | 평소 감속 | m/s² | IDM b |
| `politeness` | 차로를 바꿀 때 뒤차 피해를 얼마나 신경 쓰는지 (0 = 신경 안 씀) | 0~1 | MOBIL p |
| `changeThreshold` | 차로를 바꿀 만큼의 이득 | m/s² | MOBIL Δa_th |
| `keepRightBias` | 오른쪽 차로로 돌아가려는 성향 | m/s² | MOBIL 비대칭 |
| `safeDecel` | 끼어들 때 뒤차에게 허용하는 최대 감속 (클수록 칼치기) | m/s² | MOBIL b_safe |
| `signalUse` | 차로를 바꿀 때 방향지시등을 켜는 비율 | 0~1 | |
| `signalLead` | 방향지시등을 켜고 옮기기 시작할 때까지 | 초 | |
| `laneChangeTime` | 차로 변경에 걸리는 시간 | 초 | |
| `designatedLaneCompliance` | 지정차로(대형차 오른쪽 차로)를 지키는 비율 | 0~1 | |
| `busLaneCompliance` | 버스전용차로를 비워 두는 비율 | 0~1 | |
| `passingLaneStay` | 1차로에서 앞지르기 뒤 오른쪽으로 돌아갈 때까지 머무는 시간 | 초 | |

새 성향을 추가하려면 `profiles`에 이름을 하나 더 만들고 모든 항목을 채운다.

### 누가 어떤 성향인지 (`assignment`, `typeOverrides`)

- `assignment`: 차종 분류(승용, SUV, 전기차, 택시, 버스, 화물, 특수)마다 성향 비율. 예: `"택시": {"taxi": 0.85, "standard": 0.15}`
- `typeOverrides`: 특정 차종만 따로. 예: 1톤 트럭은 `light_commercial`, 스포츠카는 `aggressive`를 더 많이.
  차종 id는 `vehicles.json` 또는 차량 도감(`/play/garage.html`)에서 확인한다.

비율은 합이 1이 아니어도 된다 (상대 비율로 뽑는다).

### 데이터로 채울 때 참고할 곳 (예시)

- 차간 시간 간격, 속도 분포: 도로공사 VDS 개별 차량 자료, 고속도로 교통량 조사
- 방향지시등 사용률: 교통안전공단·도로교통공단 교통문화지수 조사
- 지정차로·버스전용차로 위반: 경찰청 단속 통계
- 차종별 속도·급가감속: 운행기록장치(DTG) 분석 보고서 (화물·버스·택시)

값을 바꾸면 `status`와 `note`에 출처와 날짜를 적는다.

## 교통량 (`traffic_defaults.json`)

- `presets`: 메뉴의 한산/보통/혼잡/정체. 차로 1개, 1km당 차 대수.
- `hourlyFactor`: 0~23시. 메뉴에서 "시간대 반영"을 고르면 `보통 × 이 값`.
- `composition`: 차종 분류 비율. 분류 안에서 어떤 차종이 나올지는 `vehicles.json`의 `share`로 정한다.
- `oppositeDensityFactor`: 반대편 차로 교통량 비율.

`traffic/latest.json`(수집기가 만든 전날 실제 교통)이 있으면 메뉴에 "실제 교통 (전날)"이 생기고, 그 주행선의 시간대별 밀도·차종 구성을 쓴다. 형식은 `src/sim/config.ts`의 `RealTraffic`.

## 법규 (`rules_kr.json`)

규칙마다 `enabled`로 끄고 켤 수 있고, 기준값과 근거(`source`)가 있다.
판정 결과는 주행 중에는 보여 주지 않고 결과 화면과 데이터셋에만 남긴다 (알려 주면 평소 습관이 기록되지 않는다).

| 규칙 | 기준 |
|---|---|
| 과속 | 제한속도 + `toleranceKmh`를 `minDurationSec` 넘게 |
| 최저속도 | 앞이 막히지 않았는데 최저속도 미만 |
| 방향지시등 | 차로 변경 `leadDistanceM`(100m) 전에 켜지 않음 |
| 안전거리 | 앞차와 `thresholdSec`(2초) 미만인 시간 비율, `criticalSec`(1초) 미만이 이어지면 기록 |
| 급가속·급감속 | 1초에 `kmhPerSec` 이상 (확인 필요) |
| 1차로 계속 주행 | `maxDistanceM` 넘게 1차로 |
| 터널 안 차로 변경, 갓길 주행, 버스전용차로 | 있으면 기록 |
| 아차사고 | 충돌까지 `ttcSec` 미만, 옆 간격 `lateralGapM` 미만, 또는 내 차 때문에 다른 차가 `inducedBrakeMs2` 넘게 제동 |

버스전용차로 구간은 `busLane.sections`에 노선 번호·시작/끝 나들목 이름·요일·시간·차로로 적는다. 나들목 이름이 주행선 밖에 있으면 `fromPlace`/`toPlace` 도시 쪽 끝을 쓴다.

## 차종 (`vehicles.json`)

| 항목 | 뜻 |
|---|---|
| `body` | 3D 모양 (`src/render/vehicleModels.ts`에 있는 것 중 하나) |
| `length`, `width`, `height`, `wheelbase` | m |
| `paint` | 팔레트 이름 또는 색 목록 |
| `plate` | `white`(비사업용), `yellow`(사업용), `ev`(전기·수소) |
| `heavy` | 대형차 (지정차로, 화물차 제한속도, 후부 반사판) |
| `extras`, `sign`, `livery`, `cargo`, `axles` | 택시 표시등, 경광등, 도색, 적재물, 축 수 |
| `maxSpeed`, `accel` | km/h, m/s² |
| `share` | 같은 분류 안에서 나오는 비율 |
