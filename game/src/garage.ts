// 차량 도감: 게임에 나오는 모든 차종을 전시장에 늘어놓고 하나씩 살펴본다. 모델 검수용.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import "./ui/style.css";
import { buildVehicleModel, loadCatalog, paletteFor, type VehicleModel, type VehicleType } from "./render/vehicleModels";

const CATEGORY_ORDER = ["승용", "SUV", "전기차", "택시", "버스", "화물", "특수"];

async function main() {
  const catalog = await loadCatalog();
  const app = document.getElementById("app")!;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2b3134);
  scene.fog = new THREE.Fog(0x2b3134, 80, 260);
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xdfe8ef, 0x3a3a34, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(40, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, far: 300 });
  scene.add(sun);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x4a5053, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.35 });
  const fixedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });

  // 종류별로 줄을 맞춰 배치
  const types = [...catalog.types].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.length - b.length,
  );
  const entries: { type: VehicleType; model: VehicleModel; group: THREE.Group; paint: THREE.Mesh; colorIdx: number }[] = [];
  // 주차장처럼: 종류마다 한 줄, 차는 앞을 카메라 쪽(+Z)으로 두고 폭 간격으로 나란히
  const rowZ: Record<string, number> = {};
  let z = 0;
  for (const cat of CATEGORY_ORDER) {
    const longest = Math.max(...catalog.types.filter((t) => t.category === cat).map((t) => t.length), 4);
    rowZ[cat] = z + longest / 2;
    z += longest + 5;
  }
  const rowX: Record<string, number> = {};
  for (const t of types) {
    const model = buildVehicleModel(t, t.id.length);
    const group = new THREE.Group();
    const paint = new THREE.Mesh(model.paint, paintMat.clone());
    const colors = paletteFor(t, catalog);
    (paint.material as THREE.MeshStandardMaterial).color.set(colors[0]);
    const fixed = new THREE.Mesh(model.fixed, fixedMat);
    for (const m of [paint, fixed]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    group.add(paint, fixed);
    // 등화 위치 표시 (제동등 빨강, 방향지시등 주황)
    const dot = new THREE.SphereGeometry(model.lightSize * 0.5, 8, 6);
    const marker = (p: THREE.Vector3, color: number) => {
      const m = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ color }));
      m.position.copy(p);
      group.add(m);
    };
    for (const p of model.brakeLights) marker(p, 0xff2020);
    for (const p of [...model.signalLeft, ...model.signalRight]) marker(p, 0xffa000);

    const x = rowX[t.category] ?? 0;
    group.position.set(x + t.width / 2, 0, rowZ[t.category]);
    group.rotation.y = -Math.PI / 2;
    rowX[t.category] = x + t.width + 1.8;
    scene.add(group);
    entries.push({ type: t, model, group, paint, colorIdx: 0 });
  }

  // 목록 패널
  const panel = document.createElement("aside");
  panel.className = "gpanel";
  panel.innerHTML = `
    <header><h1>DRIP 차량 도감</h1><p>게임에 나오는 차종 ${types.length}종. 목록을 누르면 그 차로 이동합니다.</p></header>
    <div class="filters"></div>
    <ul></ul>
    <footer><button id="recolor">색 바꾸기</button><button id="spin">회전</button><a href="./">← 주행</a></footer>`;
  document.body.appendChild(panel);
  const info = document.createElement("div");
  info.className = "ginfo";
  document.body.appendChild(info);

  const list = panel.querySelector("ul")!;
  const filters = panel.querySelector(".filters")!;
  let filter = "전체";
  let selected = entries[0];
  let spinning = false;

  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.type.category] = (counts[e.type.category] ?? 0) + 1;
  for (const cat of ["전체", ...CATEGORY_ORDER]) {
    const b = document.createElement("button");
    b.textContent = cat === "전체" ? `전체 ${entries.length}` : `${cat} ${counts[cat] ?? 0}`;
    b.onclick = () => {
      filter = cat;
      filters.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderList();
    };
    if (cat === "전체") b.classList.add("on");
    filters.appendChild(b);
  }

  function renderList() {
    list.innerHTML = "";
    for (const e of entries) {
      if (filter !== "전체" && e.type.category !== filter) continue;
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.innerHTML = `<span>${e.type.name}</span><small>${e.type.length.toFixed(1)}m</small>`;
      b.classList.toggle("on", e === selected);
      b.onclick = () => select(e);
      li.appendChild(b);
      list.appendChild(li);
    }
  }

  function select(e: (typeof entries)[number]) {
    selected = e;
    const t = e.type;
    const target = e.group.position.clone().add(new THREE.Vector3(0, t.height / 2, 0));
    const dist = Math.max(6, t.length * 1.25);
    controls.target.copy(target);
    camera.position.copy(target).add(new THREE.Vector3(dist * 0.75, dist * 0.35, dist * 0.9));
    const plate = t.plate === "yellow" ? "노란색 (사업용)" : t.plate === "ev" ? "파란색 (전기·수소)" : "흰색 (비사업용)";
    const tris = (e.model.paint.getAttribute("position")?.count ?? 0) / 3 + e.model.fixed.getAttribute("position").count / 3;
    info.innerHTML = `<b>${t.name}</b><dl>
      <dt>분류</dt><dd>${t.category}${t.heavy ? " · 대형" : ""}</dd>
      <dt>크기</dt><dd>${t.length} × ${t.width} × ${t.height} m</dd>
      <dt>번호판</dt><dd>${plate}</dd>
      <dt>최고속도</dt><dd>${t.maxSpeed} km/h${t.heavy ? " (속도제한장치)" : ""}</dd>
      <dt>축</dt><dd>${t.axles ?? 2}축</dd>
      <dt>삼각형</dt><dd>${Math.round(tris).toLocaleString()}</dd>
      <dt>ID</dt><dd>${t.id}</dd></dl>`;
    renderList();
  }

  panel.querySelector<HTMLButtonElement>("#recolor")!.onclick = () => {
    const colors = paletteFor(selected.type, catalog);
    selected.colorIdx = (selected.colorIdx + 1) % colors.length;
    (selected.paint.material as THREE.MeshStandardMaterial).color.set(colors[selected.colorIdx]);
  };
  panel.querySelector<HTMLButtonElement>("#spin")!.onclick = () => (spinning = !spinning);

  select(entries[0]);
  const params = new URLSearchParams(location.search);
  const want = params.get("id");
  if (want) {
    const e = entries.find((x) => x.type.id === want);
    if (e) select(e);
  }

  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });
  const loop = () => {
    if (spinning) selected.group.rotation.y += 0.01;
    controls.update();
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(loop);

  /** 모아보기: 모든 차를 같은 각도로 한 화면에 격자로 그린다 (검수용). view = front(앞 3/4) | rear(뒤 3/4) | side */
  function sheet(view: "front" | "rear" | "side" = "front", cols = 10, category = "") {
    const list = category ? entries.filter((e) => e.type.category === category) : entries;
    renderer.setAnimationLoop(null);
    panel.style.display = "none";
    info.style.display = "none";
    document.querySelector(".sheet")?.remove();
    const W = innerWidth;
    const H = innerHeight;
    const rows = Math.ceil(list.length / cols);
    const cw = W / cols;
    const ch = H / rows;
    const cam = new THREE.PerspectiveCamera(28, cw / ch, 0.1, 500);
    const labels = document.createElement("div");
    labels.className = "sheet";
    labels.style.cssText = `position:fixed;inset:0;display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);pointer-events:none;font-size:11px;color:#fff`;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.clear();
    list.forEach((e, i) => {
      for (const o of entries) o.group.visible = o === e;
      const t = e.type;
      const target = e.group.position.clone().add(new THREE.Vector3(0, t.height * 0.45, 0));
      const dist = Math.max(t.length, t.height * 1.6) * 2.1;
      const dir = view === "front" ? new THREE.Vector3(0.75, 0.42, 1) : view === "rear" ? new THREE.Vector3(-0.75, 0.42, -1) : new THREE.Vector3(1, 0.15, 0);
      cam.position.copy(target).addScaledVector(dir.normalize(), dist);
      cam.lookAt(target);
      const x = (i % cols) * cw;
      const y = H - (Math.floor(i / cols) + 1) * ch;
      renderer.setViewport(x, y, cw, ch);
      renderer.setScissor(x, y, cw, ch);
      renderer.clear();
      renderer.render(scene, cam);
      const l = document.createElement("div");
      l.style.cssText = "padding:2px 4px;text-shadow:0 1px 2px #000;border:1px solid rgba(255,255,255,.08)";
      l.textContent = `${entries.indexOf(e) + 1}. ${t.name}`;
      labels.appendChild(l);
    });
    document.body.appendChild(labels);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
  }

  const sheetParam = params.get("sheet");
  if (sheetParam) sheet(sheetParam as "front" | "rear" | "side", Number(params.get("cols") ?? 10), params.get("cat") ?? "");
  (window as unknown as { __garage: unknown }).__garage = { entries, select, sheet };
}

main().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f66;padding:20px">${e}</pre>`;
});
