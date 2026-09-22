"""한국도로공사 고속도로 공공데이터 포털(data.ex.co.kr) Open API 클라이언트.

키: .env의 EX_API_KEY (포털 회원가입 → 인증키 신청, 메일로 온다).
포털 설명서의 예시 키 `test`도 실제 자료를 주지만 시험용이다. 매일 수집은 본인 키로 한다.

응답 모양: {"code": "SUCCESS"|"ERROR", "message": ..., "count": N, "list"(또는 API별 이름): [...]}
값은 대부분 문자열이고 앞뒤에 공백이 붙어 올 때가 있어 모두 strip한다. 한 쪽은 최대 99행.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://data.ex.co.kr/openapi/"
PAGE_ROWS = 99


class ExApiError(RuntimeError):
    pass


def api_key(override: str | None = None) -> str:
    if override:
        return override
    load_dotenv(ROOT / ".env")
    key = os.environ.get("EX_API_KEY", "").strip()
    if not key:
        raise SystemExit(".env(또는 환경 변수)에 EX_API_KEY를 채워 주세요. 시험만 하려면 --key test")
    return key


def _clean(v: Any) -> Any:
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean(x) for x in v]
    return v


class ExApi:
    def __init__(self, key: str | None = None, pause: float = 0.15, retries: int = 3):
        self.key = api_key(key)
        self.pause = pause
        self.retries = retries
        self.calls = 0

    def get(self, path: str, **params) -> dict:
        q = {"key": self.key, "type": "json", **{k: v for k, v in params.items() if v is not None}}
        url = BASE + path + "?" + urllib.parse.urlencode(q)
        last: Exception | None = None
        for attempt in range(self.retries):
            try:
                with urllib.request.urlopen(url, timeout=120) as res:
                    body = res.read().decode("utf-8")
                self.calls += 1
                data = json.loads(body)
                if data.get("code") != "SUCCESS":
                    raise ExApiError(f"{path}: {data.get('message')}")
                time.sleep(self.pause)
                return _clean(data)
            except ExApiError:
                raise
            except Exception as e:  # 네트워크·일시 오류는 잠깐 쉬고 다시
                last = e
                time.sleep(2 * (attempt + 1))
        raise ExApiError(f"{path}: {last}")

    @staticmethod
    def rows(data: dict) -> list[dict]:
        """목록 키 이름이 API마다 달라서, 딕셔너리 목록인 값을 찾는다."""
        if isinstance(data.get("list"), list):
            return data["list"]
        for v in data.values():
            if isinstance(v, list) and (not v or isinstance(v[0], dict)):
                return v
        return []

    def all_pages(self, path: str, **params) -> list[dict]:
        first = self.get(path, numOfRows=PAGE_ROWS, pageNo=1, **params)
        out = self.rows(first)
        pages = int(first.get("pageSize") or 1)
        for p in range(2, pages + 1):
            out += self.rows(self.get(path, numOfRows=PAGE_ROWS, pageNo=p, **params))
        return out

    # ---- 자주 쓰는 API ----

    def routes(self) -> list[dict]:
        """노선 목록: routeCd(4자리, 예 0010) ↔ routeNo(노선 번호, 예 1), routeNm(경부선)"""
        return self.rows(self.get("roadEtcInfo/spinRouteList", useYn="Y"))

    def vds_list(self) -> list[dict]:
        """VDS 위치: vdsId, routeNo(4자리), directionCode(S/E), shift('105.30km'), grs80x/y(EPSG:5186)"""
        return self.all_pages("vdsinfo/vdsList")

    def avc_list(self) -> list[dict]:
        """AVC(차종 분류기) 위치: avcId, routeNo(4자리), shift, latitude/longitude"""
        return self.all_pages("avcinfo/avcList")

    def avc_15min(self, date: str, route_cd: str | None = None, hhmm: str | None = None) -> list[dict]:
        """AVC 15분 원시자료 (전날까지). 차로별·차종 12종별 교통량 trfv1~12, 속도 avgSped1~12"""
        return self.rows(self.get("avcinfo/avcOg15DataList", totlDates=date, routeNo=route_cd, totlHhmm=hhmm))

    def vds_realtime(self) -> list[dict]:
        """전국 VDS 실시간 속도·교통량 (1분마다 갱신)"""
        return self.rows(self.get("odtraffic/trafficAmountByRealtime"))
