"""시내·국도 도로 높이 다듬기 (osm_city.py가 부른다).

교차점 높이는 30m 지형 격자에서 읽어 건물·비탈이 섞이고, 다리·터널 가운데 점은 강 바닥·산 속 높이를 읽는다.
입체 교차(고가·지하차도)는 OSM에 높이가 없어 두 길이 같은 높이로 겹친다. 도로 토막마다 10m 점을 두고 다음 차례로 고친다.

1) 다리·터널 안의 점(가운데 점과 다리·터널만 만나는 교차점)은 지형을 버리고 양 끝(들어가는 곳) 높이 사이를 거리로 잇는다
2) 기울기 상한: 이웃 점 사이 높이 차가 (등급별 기울기 × 거리)를 넘지 않게, 솟은 점을 깎는다 (상한을 지키면서 원래 높이를 넘지 않는 가장 높은 면).
   30m 지형은 빌딩 숲에서 건물 높이가 섞여 솟는다 (여의도·종로의 교차점이 이웃보다 20~50m 높게 읽힌다). 솟은 점을 이웃 쪽으로 내리고, 이웃을 올리지 않는다.
   다리·터널 안 점은 이때 빼고(강 바닥·산 속 높이가 이웃을 끌어내리지 않게) 1)을 한 뒤 다시 한 번
   교차로(도로 셋 이상 만나는 점) 앞 LANDING m는 LANDING_GRADE로 눕힌다 (교차로 접근부: 비탈 교차로에서 오르는 길과 내리는 길의
   정지선 모서리가 몇 m씩 어긋나 교차로 바닥이 크게 기운다)
   게임이 한 교차로로 묶는 교차점들(game/src/city/net.ts cluster와 같은 규칙)끼리는 PLATE_GRADE로 더 평평하게 (교차로 바닥이 한 면이다)
3) 입체 교차: 교차점 없이 겹쳐 지나가는 두 길은 위(다리·layer가 높은 쪽)와 아래(터널·layer가 낮은 쪽) 차도 사이를 CLEAR m 벌린다.
   다리는 올리고 터널은 내리며(둘 다면 반씩), 오르내리는 비탈은 기울기 상한대로 이어진 길을 따라 퍼진다.
   나란히 가며 차도가 겹치는 다리·터널과 땅 위 길(국회대로 밑 신월여의지하도로, 정릉로 위 내부순환로)도 같다.
   다리·터널 안 높이는 1)에서 양 끝 사이를 이어 땅 위 길 높이와 같아진다. 갈라져 내려가는 비탈처럼 길 따라 이어진 두 점은
   그 길의 기울기 상한으로 벌어질 수 있는 높이(교차로 앞 눕힌 곳은 작다)가 OVERLAP_DZ m 안이면 뺀다 (벌리려고 내리면 이어진 길도 끌려 내려간다)
"""

from __future__ import annotations

import heapq
import math
from collections import defaultdict

import numpy as np

SAMPLE = 10.0  # 토막 안 점 간격 (m)
CLEAR = 6.5  # 입체 교차의 위·아래 차도 높이 차 (m): 높이 제한 4.5m + 상판
GRADE = {"m": 0.07, "t": 0.08, "p": 0.08, "s": 0.1, "r": 0.13}
LINK_GRADE = 0.08
LANDING = 25.0  # 교차로 앞 눕히는 거리 (m)
LANDING_GRADE = 0.025
PLATE_GRADE = 0.04  # 한 교차로 안 교차점 사이 기울기 상한
CLUSTER_EDGE = 42.0  # net.ts와 같게: 이보다 짧은 토막으로 이어진 교차점(도로 셋 이상)을 묶는다
CLUSTER_SPAN = 95.0  # 묶음 경계 상자 대각선 한도
OVERLAP_DZ = 2 * CLEAR  # 나란한 겹침에서 길 따라 이만큼 높이 차밖에 못 벌어지는 두 점은 벌리지 않는다 (m)
OUT_STEP = 40.0  # 높이 굴곡을 적는 간격 (m). 이 간격으로 줄여 0.3m 넘게 어긋나는 토막(고가 봉우리 등)은 SAMPLE 간격으로


def grade_of(cls: str) -> float:
    return LINK_GRADE if cls.endswith("l") else GRADE.get(cls[0], 0.1)


def level_of(ed: dict) -> int:
    if ed["layer"]:
        return ed["layer"]
    return 1 if ed["bridge"] else -1 if ed["tunnel"] else 0


def clusters(node_xy, edges, degree) -> list[list[int]]:
    """게임(net.ts CityNet.cluster)이 한 교차로로 묶는 교차점들"""
    parent = list(range(len(node_xy)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    box = {}

    def box_of(n):
        r = find(n)
        if r in box:
            return box[r]
        x, y = node_xy[n]
        return (x, y, x, y)

    short = [ed for ed in edges if round(ed["len"], 1) < CLUSTER_EDGE and ed["a"] != ed["b"] and degree[ed["a"]] >= 3 and degree[ed["b"]] >= 3 and ed["cls"] != "m"]
    short.sort(key=lambda ed: round(ed["len"], 1))
    for ed in short:
        ra, rb = find(ed["a"]), find(ed["b"])
        if ra == rb:
            continue
        A, B = box_of(ed["a"]), box_of(ed["b"])
        u = (min(A[0], B[0]), min(A[1], B[1]), max(A[2], B[2]), max(A[3], B[3]))
        if math.hypot(u[2] - u[0], u[3] - u[1]) > CLUSTER_SPAN:
            continue
        parent[ra] = rb
        box[find(rb)] = u
    groups = defaultdict(list)
    for n in range(len(node_xy)):
        if degree[n] >= 3:
            groups[find(n)].append(n)
    return [g for g in groups.values() if len(g) > 1]


class Samples:
    """교차점(0..N-1)과 토막 안 점(N..)을 한 줄로 두고, 이웃 점 사이 (거리, 허용 높이 차)를 잇는다"""

    def __init__(self, node_xy, edges, grade_scale: float, junction):
        self.N = len(node_xy)
        self.x = [p[0] for p in node_xy]
        self.y = [p[1] for p in node_xy]
        self.adj: list[list[tuple[int, float, float]]] = [[] for _ in range(self.N)]
        self.of_edge: list[tuple[list[int], np.ndarray]] = []
        for ed in edges:
            L = ed["len"]
            n = max(1, math.ceil(L / SAMPLE - 1e-6))
            u = np.linspace(0.0, L, n + 1)
            pts = ed["pts"]
            cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
            px = np.interp(u, cum, pts[:, 0])
            py = np.interp(u, cum, pts[:, 1])
            ids = [ed["a"]]
            for i in range(1, n):
                ids.append(len(self.x))
                self.x.append(float(px[i]))
                self.y.append(float(py[i]))
                self.adj.append([])
            ids.append(ed["b"])
            g = grade_of(ed["cls"]) * grade_scale
            # 일반 도로(대로·로·길)만: 고가로 오르내리는 연결로·다리·터널·도시고속도로는 비탈이 교차로까지 이어진다
            surface = ed["cls"] in ("p", "s", "r") and not ed["bridge"] and not ed["tunnel"]
            flat = min(g, LANDING_GRADE * grade_scale) if surface else g
            ds = L / n
            for i in range(n):
                near = (junction[ed["a"]] and u[i] < LANDING) or (junction[ed["b"]] and u[i + 1] > L - LANDING)
                c = (flat if near else g) * ds
                self.adj[ids[i]].append((ids[i + 1], ds, c))
                self.adj[ids[i + 1]].append((ids[i], ds, c))
            self.of_edge.append((ids, u))

    def __len__(self):
        return len(self.x)


def lipschitz_below(z0: list[float], adj) -> list[float]:
    """이웃 사이 높이 차 상한을 지키며 z0를 넘지 않는 가장 높은 면 (솟은 점만 깎는다)"""
    up = list(z0)
    heap = [(v, i) for i, v in enumerate(up) if v < math.inf]
    heapq.heapify(heap)
    while heap:
        v, i = heapq.heappop(heap)
        if v > up[i]:
            continue
        for j, _, c in adj[i]:
            if v + c < up[j] - 1e-9:
                up[j] = v + c
                heapq.heappush(heap, (up[j], j))
    return up


def push(z: list[float], seeds: dict[int, float], adj, sign: int) -> int:
    """sign=+1: z[i] >= seeds[i]로 올리고 기울기 상한대로 이웃을 따라 올린다. -1: 내린다. 옮긴 점 수"""
    heap = []
    for i, v in seeds.items():
        if sign * (v - z[i]) > 1e-6:
            z[i] = v
            heap.append((-sign * v, i))
    heapq.heapify(heap)
    moved = set(i for _, i in heap)
    while heap:
        key, i = heapq.heappop(heap)
        v = -sign * key
        if sign * (z[i] - v) > 1e-9:
            continue
        for j, _, c in adj[i]:
            w = v - sign * c
            if sign * (w - z[j]) > 1e-6:
                z[j] = w
                moved.add(j)
                heapq.heappush(heap, (-sign * w, j))
    return len(moved)


def fill_free(z: list[float], free: list[bool], adj) -> int:
    """다리·터널 안 점: 묶음마다 경계(지형을 쓰는 점)에서 길 따라 잰 거리의 역수로 섞는다 (한 줄이면 양 끝 사이를 곧게)"""
    seen = [False] * len(z)
    count = 0
    for s in range(len(z)):
        if not free[s] or seen[s]:
            continue
        comp = []
        bound = set()
        stack = [s]
        seen[s] = True
        while stack:
            i = stack.pop()
            comp.append(i)
            for j, _, _ in adj[i]:
                if free[j]:
                    if not seen[j]:
                        seen[j] = True
                        stack.append(j)
                else:
                    bound.add(j)
        if not bound:
            continue
        member = set(comp)
        sw = defaultdict(float)
        sz = defaultdict(float)
        for b in bound:
            dist = {b: 0.0}
            heap = [(0.0, b)]
            while heap:
                d, i = heapq.heappop(heap)
                if d > dist.get(i, math.inf):
                    continue
                for j, ds, _ in adj[i]:
                    if j in member and d + ds < dist.get(j, math.inf):
                        dist[j] = d + ds
                        heapq.heappush(heap, (d + ds, j))
            for i, d in dist.items():
                if i in member and d > 0:
                    sw[i] += 1.0 / d
                    sz[i] += z[b] / d
        for i in comp:
            if sw[i] > 0:
                z[i] = sz[i] / sw[i]
                count += 1
    return count


def crossings(edges) -> list[tuple[int, int, float, float, float, float]]:
    """교차점을 나누지 않고 겹쳐 지나가는 토막 쌍: (e, f, e 위 거리, f 위 거리, x, y)"""
    segs = []
    grid = defaultdict(list)
    for k, ed in enumerate(edges):
        p = ed["pts"]
        acc = 0.0
        for i in range(len(p) - 1):
            ax, ay = p[i]
            bx, by = p[i + 1]
            L = math.hypot(bx - ax, by - ay)
            sid = len(segs)
            segs.append((k, ax, ay, bx, by, acc, L))
            acc += L
            for gx in range(int(min(ax, bx) // 50), int(max(ax, bx) // 50) + 1):
                for gy in range(int(min(ay, by) // 50), int(max(ay, by) // 50) + 1):
                    grid[(gx, gy)].append(sid)
    out = {}
    for cell in grid.values():
        for ii in range(len(cell)):
            e, ax, ay, bx, by, ae, Le = segs[cell[ii]]
            for jj in range(ii + 1, len(cell)):
                f, cx, cy, dx, dy, af, Lf = segs[cell[jj]]
                if e == f:
                    continue
                E, F = edges[e], edges[f]
                if E["a"] in (F["a"], F["b"]) or E["b"] in (F["a"], F["b"]):
                    continue
                den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
                if abs(den) < 1e-9:
                    continue
                t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den
                s = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den
                if not (0 <= t <= 1 and 0 <= s <= 1):
                    continue
                key = (min(e, f), max(e, f))
                if key in out:
                    continue
                ue, uf = ae + t * Le, af + s * Lf
                x, y = ax + (bx - ax) * t, ay + (by - ay) * t
                out[key] = (e, f, ue, uf, x, y) if e < f else (f, e, uf, ue, x, y)
    return list(out.values())


def half_width(ed: dict) -> float:
    return ed["lanes"] * (3.2 if ed["oneway"] else 6.4) / 2 + 1.5


def overlaps(edges, S: Samples) -> list[tuple[int, int, float, float, float, float]]:
    """다리·터널 토막 안 점 가운데 땅 위 길(layer 0, 연결로 빼고: 나들목 연결로는 본선 옆을 오르내리며 나란히 간다) 차도와 겹치는 것:
    (다리·터널 토막, 땅 위 토막, 각 토막 위 거리, x, y).
    다리는 차도가 1m 넘게 겹칠 때 (땅 위 길 바로 옆 다리는 흔하다), 터널은 차도 가장자리 사이가 6m 안일 때
    (땅 밑 도로는 윗길 옆으로 몇 m 비껴 그려지기도 하고, 땅 위 길 옆에서 그 높이로 드러난 터널은 없다).
    길 따라 벌어질 수 있는 높이가 OVERLAP_DZ 안에 (이 점이나 다른 점과) 겹친 땅 위 길이 있으면 뺀다: 갈라져 오르내리는 연결로이거나,
    이 점을 내리면(올리면) 그 길이 끌려 내려가(올라가) 다른 점이 따라 내려가는 되풀이가 된다"""
    segs = []
    grid = defaultdict(list)
    for k, ed in enumerate(edges):
        if ed["bridge"] or ed["tunnel"] or ed["layer"] or ed["cls"].endswith("l"):
            continue
        ids, u = S.of_edge[k]
        for i in range(len(ids) - 1):
            a, b = ids[i], ids[i + 1]
            sid = len(segs)
            segs.append((k, a, b, u[i], u[i + 1]))
            for gx in range(int(min(S.x[a], S.x[b]) // 50), int(max(S.x[a], S.x[b]) // 50) + 1):
                for gy in range(int(min(S.y[a], S.y[b]) // 50), int(max(S.y[a], S.y[b]) // 50) + 1):
                    grid[(gx, gy)].append(sid)
    cands = []
    touched = {True: set(), False: set()}  # 터널(True)·다리와 겹친 땅 위 길 점
    for k, ed in enumerate(edges):
        if not (ed["bridge"] or ed["tunnel"]):
            continue
        he = half_width(ed) - 1.5 + (6.0 if ed["tunnel"] else -1.0)
        ids, u = S.of_edge[k]
        for i in range(1, len(ids) - 1):
            p = ids[i]
            x, y = S.x[p], S.y[p]
            best = {}
            cx, cy = int(x // 50), int(y // 50)
            for gx in (cx - 1, cx, cx + 1):
                for gy in (cy - 1, cy, cy + 1):
                    for sid in grid.get((gx, gy), ()):
                        f, a, b, ua, ub = segs[sid]
                        ax, ay, bx, by = S.x[a], S.y[a], S.x[b], S.y[b]
                        L2 = (bx - ax) ** 2 + (by - ay) ** 2
                        t = 0.0 if L2 < 1e-9 else max(0.0, min(1.0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2))
                        d = math.hypot(ax + (bx - ax) * t - x, ay + (by - ay) * t - y)
                        if d < he + half_width(edges[f]) - 1.5 and d < best.get(f, (math.inf,))[0]:
                            best[f] = (d, ua + (ub - ua) * t, a, b)
            if best:
                cands.append((k, float(u[i]), p, x, y, best))
                for _, _, a, b in best.values():
                    touched[bool(ed["tunnel"])].update((a, b))
    out = []
    for k, uk, p, x, y, best in cands:
        near = touched[bool(edges[k]["tunnel"])]
        # 길 따라 벌어질 수 있는 높이가 OVERLAP_DZ 안인 점
        dist = {p: 0.0}
        heap = [(0.0, p)]
        coupled = False
        while heap and not coupled:
            dd, j = heapq.heappop(heap)
            if dd > dist.get(j, math.inf):
                continue
            coupled = j in near
            for m, _, c in S.adj[j]:
                nd = dd + c
                if nd <= OVERLAP_DZ and nd < dist.get(m, math.inf):
                    dist[m] = nd
                    heapq.heappush(heap, (nd, m))
        if not coupled:
            out.extend((k, f, uk, uf, x, y) for f, (_, uf, _, _) in best.items())
    return out


def settle(node_xy, z_node: np.ndarray, edges: list[dict], profiles: dict[int, list[int]], profile_step: float, degree, grade_scale: float = 1.0):
    """교차점 높이(z_node)와 토막 높이 굴곡(profiles, 0.1m 정수)을 고쳐 돌려준다.
    grade_scale: 기울기 상한 배수. 국도는 지형이 산·골짜기 그대로라(빌딩이 섞이지 않는다) 1.5로 두어 지형 잡음(터널 입구 비탈 등)만 깎는다"""
    # 입체 교차 150m 안의 교차로는 눕히지 않는다 (나들목: 고가로 오르는 비탈이 바로 옆 교차로까지 온다)
    X = crossings(edges)
    near_x = set()
    grid = defaultdict(list)
    for _, _, _, _, x, y in X:
        grid[(int(x // 150), int(y // 150))].append((x, y))
    for v, (x, y) in enumerate(node_xy):
        if degree[v] < 3:
            continue
        cx, cy = int(x // 150), int(y // 150)
        if any((px - x) ** 2 + (py - y) ** 2 < 150**2 for dx in (-1, 0, 1) for dy in (-1, 0, 1) for px, py in grid.get((cx + dx, cy + dy), ())):
            near_x.add(v)
    S = Samples(node_xy, edges, grade_scale, [d >= 3 and v not in near_x for v, d in enumerate(degree)])
    n = len(S)
    z = [0.0] * n
    for k in range(S.N):
        z[k] = float(z_node[k])
    for k, (ids, u) in enumerate(S.of_edge):
        ed = edges[k]
        prof = profiles.get(k)
        if prof:
            pu = np.linspace(0.0, ed["len"], len(prof))
            zi = np.interp(u, pu, np.asarray(prof, float) / 10)
        else:
            zi = z[ed["a"]] + (z[ed["b"]] - z[ed["a"]]) * (u / max(ed["len"], 1e-9))
        for i in range(1, len(ids) - 1):
            z[ids[i]] = float(zi[i])
    # 1) 다리·터널 안
    free = [False] * n
    touch = defaultdict(list)
    for k, ed in enumerate(edges):
        touch[ed["a"]].append(k)
        touch[ed["b"]].append(k)
        if ed["bridge"] or ed["tunnel"]:
            for i in S.of_edge[k][0][1:-1]:
                free[i] = True
    for v, ks in touch.items():
        if all(edges[k]["bridge"] or edges[k]["tunnel"] for k in ks):
            free[v] = True
    # 한 교차로로 묶이는 교차점끼리 (다리·터널에 닿은 점은 빼고: 고가 위 점과 그 밑 길이 묶이기도 한다)
    plates = 0
    for grp in clusters(node_xy, edges, degree):
        grp = [v for v in grp if not any(edges[k]["bridge"] or edges[k]["tunnel"] for k in touch[v])]
        for i in range(len(grp)):
            for j in range(i + 1, len(grp)):
                a, b = grp[i], grp[j]
                d = math.hypot(node_xy[a][0] - node_xy[b][0], node_xy[a][1] - node_xy[b][1])
                S.adj[a].append((b, d, PLATE_GRADE * d))
                S.adj[b].append((a, d, PLATE_GRADE * d))
                plates += 1
    z_in = list(z)
    # 2) 기울기 상한 (다리·터널 안은 빼고) → 1) 다리·터널 안 → 한 번 더 (다리·터널 줄에도 상한)
    z = lipschitz_below([math.inf if free[i] else z[i] for i in range(n)], S.adj)
    z = [z_in[i] if z[i] == math.inf else z[i] for i in range(n)]  # 땅에 닿지 않는 다리·터널 묶음은 그대로
    filled = fill_free(z, free, S.adj)
    z = lipschitz_below(z, S.adj)
    # 3) 입체 교차

    def at(k: int, u: float) -> float:
        ids, uu = S.of_edge[k]
        i = min(len(uu) - 2, int(np.searchsorted(uu, u, side="right") - 1))
        t = (u - uu[i]) / max(uu[i + 1] - uu[i], 1e-9)
        return z[ids[i]] * (1 - t) + z[ids[i + 1]] * t

    def near(k: int, u: float, w: float) -> list[int]:
        ids, uu = S.of_edge[k]
        pick = [ids[i] for i in range(len(uu)) if abs(uu[i] - u) <= w]
        if not pick:
            i = int(np.argmin(np.abs(uu - u)))
            pick = [ids[i]]
        return pick

    pairs = []
    for e, f, ue, uf, x, y in X:
        le, lf = level_of(edges[e]), level_of(edges[f])
        if le == lf:
            # 둘 다 다리(또는 둘 다 터널)인데 layer가 없으면 지금 높은 쪽을 위로 (둘 다 땅 위 길이면 OSM에 교차점이 빠진 평면 교차일 수 있어 그대로)
            E, F = edges[e], edges[f]
            if not ((E["bridge"] and F["bridge"]) or (E["tunnel"] and F["tunnel"])):
                continue
            le, lf = (1, 0) if at(e, ue) >= at(f, uf) else (0, 1)
        up, lo, uu, ul = (e, f, ue, uf) if le > lf else (f, e, uf, ue)
        pairs.append((up, lo, uu, ul, x, y))
    n_cross = len(pairs)
    O = overlaps(edges, S)
    for e, f, ue, uf, x, y in O:
        pairs.append((e, f, ue, uf, x, y) if level_of(edges[e]) > 0 else (f, e, uf, ue, x, y))
    dragged: set[int] = set()  # 벌리는 만큼 짝도 끌려가는 나란한 겹침 (다음 차례부터 뺀다)
    moved = 0
    rounds = 0
    for rounds in range(1, 13):
        lift: dict[int, float] = {}
        sink: dict[int, float] = {}
        short = 0
        before: dict[int, float] = {}
        for q, (up, lo, uu, ul, _, _) in enumerate(pairs):
            if q in dragged:
                continue
            gap = at(up, uu) - at(lo, ul)
            need = CLEAR - gap
            if need <= 0.05:
                continue
            short += 1
            if q >= n_cross:
                before[q] = gap
            U, D = edges[up], edges[lo]
            can_up = U["bridge"] or U["layer"] > 0 or not (D["tunnel"] or D["layer"] < 0)
            can_down = D["tunnel"] or D["layer"] < 0
            du = need if not can_down else need / 2 if can_up else 0.0
            dd = need - du
            if du > 0:
                zt = at(up, uu) + du
                for i in near(up, uu, half_width(D) + 3):
                    lift[i] = max(lift.get(i, -math.inf), zt)
            if dd > 0:
                zt = at(lo, ul) - dd
                for i in near(lo, ul, half_width(U) + 3):
                    sink[i] = min(sink.get(i, math.inf), zt)
        if not short:
            break
        moved += push(z, sink, S.adj, -1)
        moved += push(z, lift, S.adj, +1)
        for q, gap in before.items():
            up, lo, uu, ul, _, _ = pairs[q]
            if at(up, uu) - at(lo, ul) < gap + (CLEAR - gap) / 2:
                dragged.add(q)
    left = 0
    for up, lo, uu, ul, _, _ in pairs:
        if at(up, uu) - at(lo, ul) < CLEAR - 0.5:
            left += 1

    # 적기: 교차점 높이, 굴곡 (곧은 선에서 0.15m 넘게 벗어나는 토막만. OUT_STEP으로 줄여 0.3m 넘게 어긋나면 SAMPLE 간격)
    z_out = np.array(z[: S.N])
    new_prof: dict[int, list[int]] = {}
    for k, (ids, u) in enumerate(S.of_edge):
        ed = edges[k]
        L = ed["len"]
        zz = np.array([z[i] for i in ids])
        lin = zz[0] + (zz[-1] - zz[0]) * (u / max(L, 1e-9))
        if k not in profiles and np.max(np.abs(zz - lin)) <= 0.15:
            continue
        m = max(2, int(round(L / profile_step)) + 1)
        pu = np.linspace(0.0, L, m)
        pz = np.interp(pu, u, zz)
        if np.max(np.abs(np.interp(u, pu, pz) - zz)) > 0.3:
            pz = zz
        new_prof[k] = [int(round(v * 10)) for v in pz]
    dz = np.abs(np.array(z) - np.array(z_in))
    stats = {
        "samples": n,
        "plate_pairs": plates,
        "free": int(sum(free)),
        "filled": filled,
        "moved_1m": int((dz > 1).sum()),
        "moved_max": float(dz.max()) if n else 0.0,
        "crossings": len(X),
        "overlaps": len(O),
        "dragged": len(dragged),
        "separated": len(pairs),
        "lifted": moved,
        "rounds": rounds,
        "short_left": left,
    }
    return z_out, new_prof, stats
