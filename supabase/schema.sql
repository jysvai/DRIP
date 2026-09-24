-- DRIP 주행 기록 테이블. 게임(브라우저)은 publishable 키(anon 역할)로 "넣기"만 할 수 있고 읽을 수는 없다 (적재를 켰을 때만).
-- 분석·데이터셋 공개는 secret 키나 DB 직접 연결로 한다.
-- 적용: .venv\Scripts\python pipeline\apply_schema.py

create table if not exists public.drip_sessions (
  id uuid primary key,
  participant_id uuid not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  app_version text,
  road_id text not null,
  road_ref text,
  road_name text,
  direction text,
  start_s real,
  traffic_preset text,
  sim_hour smallint,
  seed bigint,
  input_mode text,
  camera text,
  device jsonb,
  check (pg_column_size(device) < 4000)
);

-- 출발지·도착지 경로 주행 (2026-09): 고른 차종과, 여러 주행선을 이어 붙인 경로의 조각들.
-- route는 [원래 주행선 id, 경로 s0, s1, 원래 주행선 src0, src1, 지난 분기점] 목록. 한 주행선만 달리면 null이고 s는 그 주행선의 s다.
alter table public.drip_sessions add column if not exists vehicle text;
alter table public.drip_sessions add column if not exists route jsonb;
alter table public.drip_sessions drop constraint if exists drip_sessions_route_size;
alter table public.drip_sessions add constraint drip_sessions_route_size check (pg_column_size(route) < 8000);

-- 날씨 (2026-09): clear·cloudy·rain·heavy_rain·fog. 비·안개는 제한속도 판정(법정 감속)과 노면 마찰이 달라진다.
alter table public.drip_sessions add column if not exists weather text;

-- 주행 방식 (2026-09): {pace: digest|full, windows: [[s0, s1], ...], lka: bool, pedal, steerHold: bool, steerSens: slow|normal|fast, device: keyboard|mouse|pad|wheel, wheelRange, wheelCal: bool}.
-- digest(요약 주행)는 windows 구간만 실제 시간으로 달리고 사이는 건너뛴다. 건너뛴 길에는 1초 기록이 없어 노출 시간에 들어가지 않는다.
alter table public.drip_sessions add column if not exists drive jsonb;
alter table public.drip_sessions drop constraint if exists drip_sessions_drive_size;
alter table public.drip_sessions add constraint drip_sessions_drive_size check (pg_column_size(drive) < 4000);

create table if not exists public.drip_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.drip_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  t real not null,
  type text not null,
  s real,
  lane smallint,
  speed_kmh real,
  limit_kmh smallint,
  detail jsonb,
  check (pg_column_size(detail) < 4000),
  check (char_length(type) < 40)
);
create index if not exists drip_events_session on public.drip_events(session_id);
create index if not exists drip_events_type on public.drip_events(type);

-- 1초 간격 주행 기록을 30초씩 묶어 한 줄로
create table if not exists public.drip_samples (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.drip_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  t0 real not null,
  columns text[] not null,
  data jsonb not null,
  check (pg_column_size(data) < 60000)
);
create index if not exists drip_samples_session on public.drip_samples(session_id);

create table if not exists public.drip_summaries (
  session_id uuid primary key references public.drip_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  ended_reason text,
  summary jsonb not null,
  check (pg_column_size(summary) < 8000)
);

-- 행 보안: anon은 넣기만
alter table public.drip_sessions enable row level security;
alter table public.drip_events enable row level security;
alter table public.drip_samples enable row level security;
alter table public.drip_summaries enable row level security;

revoke all on public.drip_sessions, public.drip_events, public.drip_samples, public.drip_summaries from anon, authenticated;
-- 넣기 권한은 여기서 주지 않는다 (이 파일을 다시 적용해도 적재가 켜지지 않게). 연구를 공개할 때
-- python pipeline/collection.py on 으로 켜고, 그 전에는 off로 둔다. 정책은 권한이 있을 때만 쓰인다.

drop policy if exists drip_sessions_insert on public.drip_sessions;
create policy drip_sessions_insert on public.drip_sessions for insert to anon, authenticated with check (true);
drop policy if exists drip_events_insert on public.drip_events;
create policy drip_events_insert on public.drip_events for insert to anon, authenticated with check (true);
drop policy if exists drip_samples_insert on public.drip_samples;
create policy drip_samples_insert on public.drip_samples for insert to anon, authenticated with check (true);
drop policy if exists drip_summaries_insert on public.drip_summaries;
create policy drip_summaries_insert on public.drip_summaries for insert to anon, authenticated with check (true);
