// 시내 도로망은 한 번만 불러와 만든다 (메뉴에서 장소를 찾을 때와 주행을 만들 때 같이 쓴다).

import { CityGraph } from "./graph";
import { CityNet } from "./net";

const cache = new Map<string, Promise<CityGraph>>();
const nets = new Map<CityGraph, CityNet>();

/** 지역 도로망 파일 (public/city/{region}.json) */
export function loadCityGraph(region: string): Promise<CityGraph> {
  let p = cache.get(region);
  if (!p) {
    p = CityGraph.load(region);
    // 실패하면 다음에 다시 받는다
    p.catch(() => cache.delete(region));
    cache.set(region, p);
  }
  return p;
}

/** 달릴 수 있는 모양 (교차로·링크·이동). 처음 한 번 만드는 데 1초쯤 걸린다 */
export async function loadCity(region: string): Promise<{ graph: CityGraph; net: CityNet }> {
  const graph = await loadCityGraph(region);
  let net = nets.get(graph);
  if (!net) nets.set(graph, (net = new CityNet(graph)));
  return { graph, net };
}
