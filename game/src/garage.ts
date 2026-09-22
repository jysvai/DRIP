// 차량 도감: 게임에 나오는 모든 차종을 전시장 회전판에 올려 하나씩 살펴본다. 모델 검수용.
// ?id=차종 으로 바로 열고, ?sheet=front|rear|side&cols=10&cat=분류 로 모든 차를 한 화면에 모아 본다.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import "./ui/style.css";
import { setLampLevels, vehicleUniforms } from "./render/carMaterials";
import { buildVehicleModel, createVehicleObject, loadCatalog, paletteFor, type VehicleModel, type VehicleType } from "./render/vehicleModels";

const CATEGORY_ORDER = ["승용", "SUV", "전기차", "택시", "버스", "화물", "특수"];

// 도감에서만 쓰는 모양 (공용 style.css는 건드리지 않는다)
const GARAGE_CSS = `
.gswatch{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.gswatch button{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.22);padding:0;cursor:pointer;box-shadow:inset 0 -3px 6px rgba(0,0,0,.35)}
.gswatch button.on{border-color:#7fd6a8;box-shadow:0 0 0 2px rgba(127,214,168,.35),inset 0 -3px 6px rgba(0,0,0,.35)}
`;

interface Entry {
  type: VehicleType;
  model: VehicleModel | null;
  colorIdx: number;
}

async function main() {
  const catalog = await loadCatalog();
  const app = document.getElementById("app")!;
  const params = new URLSearchParams(location.search);
  const css = document.createElement("style");
  css.textContent = GARAGE_CSS;
  document.head.appendChild(css);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.03).texture;
  scene.environmentIntensity = 0.9;
  room.dispose();
  scene.background = gradientBackground();
  scene.fog = new THREE.Fog(0x15181b, 40, 90);

  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 2.5;
  controls.maxDistance = 60;

  // 조명: 위에서 부드러운 주광 + 뒤쪽 테두리 빛
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(6, 14, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0003;
  Object.assign(key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 1.1);
  rim.position.set(-10, 6, -8);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xdfe8ef, 0x202224, 0.35));

  // 바닥과 회전판
  const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 64), new THREE.MeshStandardMaterial({ color: 0x1b1e21, roughness: 0.55, metalness: 0.2 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const table = new THREE.Group();
  scene.add(table);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.06, 96), new THREE.MeshPhysicalMaterial({ color: 0x2a2e33, roughness: 0.3, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.15 }));
  disc.position.y = 0.03;
  disc.receiveShadow = true;
  table.add(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 128), new THREE.MeshBasicMaterial({ color: 0x7fd6a8 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.062;
  table.add(ring);
  const carHolder = new THREE.Group();
  carHolder.position.y = 0.06;
  table.add(carHolder);

  const types = [...catalog.types].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.length - b.length);
  const entries: Entry[] = types.map((t) => ({ type: t, model: null, colorIdx: 0 }));
  const modelOf = (e: Entry) => (e.model ??= buildVehicleModel(e.type, e.type.id.length));

  // 목록 패널
  const panel = document.createElement("aside");
  panel.className = "gpanel";
  panel.innerHTML = `
    <header><h1>DRIP 차량 도감</h1><p>게임에 나오는 차종 ${types.length}종. 목록을 누르면 전시대에 올립니다.</p></header>
    <div class="filters"></div>
    <ul></ul>
    <footer><button id="spin" class="on">회전</button><button id="lamps">등화</button><button id="night">밤</button><a href="./">← 주행</a></footer>`;
  document.body.appendChild(panel);
  const info = document.createElement("div");
  info.className = "ginfo";
  document.body.appendChild(info);

  const list = panel.querySelector("ul")!;
  const filters = panel.querySelector(".filters")!;
  let filter = "전체";
  let selected = entries[0];
  let current: THREE.Group | null = null;
  let spinning = true;
  let lamps = false;
  let night = false;

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

  function applyLamps() {
    if (!current) return;
    const mat = current.userData.material as THREE.Material;
    setLampLevels(mat, lamps || night ? 1 : 0, 0);
    vehicleUniforms(mat).uLampState.value.set(lamps ? 1 : 0, 0, 0, 0);
  }

  function place(e: Entry) {
    if (current) {
      carHolder.remove(current);
      current.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.material) (m.material as THREE.Material).dispose();
      });
    }
    const t = e.type;
    const colors = paletteFor(t, catalog);
    current = createVehicleObject(t, colors[e.colorIdx % colors.length], { model: modelOf(e) });
    carHolder.add(current);
    const R = Math.max(t.length, t.width) * 0.62;
    disc.scale.set(R, 1, R);
    ring.scale.set(R, R, 1);
    applyLamps();
  }

  function select(e: Entry) {
    selected = e;
    const t = e.type;
    place(e);
    const target = new THREE.Vector3(0, t.height * 0.45, 0);
    const dist = Math.max(6.5, t.length * 1.35);
    controls.target.copy(target);
    camera.position.copy(target).add(new THREE.Vector3(dist * 0.72, dist * 0.28, dist * 0.78));
    const plate = t.plate === "yellow" ? "노란색 (사업용)" : t.plate === "ev" ? "파란색 (전기·수소)" : "흰색 (비사업용)";
    const m = modelOf(e);
    const tris = m.body.getAttribute("position").count / 3;
    const midTris = m.mid.getAttribute("position").count / 3;
    const colors = paletteFor(t, catalog);
    info.innerHTML = `<b>${t.name}</b><dl>
      <dt>분류</dt><dd>${t.category}${t.heavy ? " · 대형" : ""}</dd>
      <dt>크기</dt><dd>${t.length} × ${t.width} × ${t.height} m</dd>
      <dt>번호판</dt><dd>${plate}</dd>
      <dt>최고속도</dt><dd>${t.maxSpeed} km/h${t.heavy ? " (속도제한장치)" : ""}</dd>
      <dt>축</dt><dd>${t.axles ?? 2}축 · 바퀴 ${m.wheels.length}개</dd>
      <dt>삼각형</dt><dd>${Math.round(tris).toLocaleString()} (중간 ${Math.round(midTris).toLocaleString()})</dd>
      <dt>ID</dt><dd>${t.id}</dd></dl>
      <div class="gswatch">${colors.map((c, i) => `<button data-i="${i}" style="background:${c}" class="${i === e.colorIdx % colors.length ? "on" : ""}" aria-label="색 ${i + 1}"></button>`).join("")}</div>`;
    info.querySelectorAll<HTMLButtonElement>(".gswatch button").forEach((b) => {
      b.onclick = () => {
        e.colorIdx = Number(b.dataset.i);
        if (current) vehicleUniforms(current.userData.material as THREE.Material).uPaint.value.set(colors[e.colorIdx]);
        info.querySelectorAll(".gswatch button").forEach((x) => x.classList.toggle("on", x === b));
      };
    });
    renderList();
  }

  const btn = (id: string) => panel.querySelector<HTMLButtonElement>(id)!;
  btn("#spin").onclick = () => {
    spinning = !spinning;
    btn("#spin").classList.toggle("on", spinning);
  };
  btn("#lamps").onclick = () => {
    lamps = !lamps;
    btn("#lamps").classList.toggle("on", lamps);
    applyLamps();
  };
  btn("#night").onclick = () => {
    night = !night;
    btn("#night").classList.toggle("on", night);
    scene.environmentIntensity = night ? 0.12 : 0.9;
    key.intensity = night ? 0.15 : 2.2;
    rim.intensity = night ? 0.3 : 1.1;
    applyLamps();
  };

  const want = params.get("id");
  select(entries.find((x) => x.type.id === want) ?? entries[0]);

  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (spinning) table.rotation.y += dt * 0.25;
    controls.update();
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(loop);

  /** 모아보기: 모든 차를 같은 각도로 한 화면에 격자로 그린다 (검수용). view = front(앞 3/4) | rear(뒤 3/4) | side */
  function sheet(view: "front" | "rear" | "side" = "front", cols = 10, category = "") {
    const pick = category ? entries.filter((e) => e.type.category === category) : entries;
    renderer.setAnimationLoop(null);
    panel.style.display = "none";
    info.style.display = "none";
    document.querySelector(".sheet")?.remove();
    table.rotation.y = 0;
    const W = innerWidth;
    const H = innerHeight;
    const rows = Math.ceil(pick.length / cols);
    const cw = W / cols;
    const ch = H / rows;
    const cam = new THREE.PerspectiveCamera(28, cw / ch, 0.1, 500);
    const labels = document.createElement("div");
    labels.className = "sheet";
    labels.style.cssText = `position:fixed;inset:0;display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);pointer-events:none;font-size:11px;color:#fff`;
    renderer.setScissorTest(true);
    renderer.autoClear = false;
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.clear();
    pick.forEach((e, i) => {
      place(e);
      const t = e.type;
      const target = new THREE.Vector3(0, t.height * 0.45, 0);
      const dist = Math.max(t.length, t.height * 1.6) * 2.1;
      const dir = view === "front" ? new THREE.Vector3(0.75, 0.42, 1) : view === "rear" ? new THREE.Vector3(-0.75, 0.42, -1) : new THREE.Vector3(0, 0.15, 1);
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
  (window as unknown as { __garage: unknown }).__garage = { entries, select, sheet, camera, controls, scene, renderer };
}

/** 위는 밝고 아래는 어두운 전시장 배경 */
function gradientBackground(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#3a4046");
  grd.addColorStop(0.55, "#23272b");
  grd.addColorStop(1, "#121416");
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

main().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f66;padding:20px">${e?.stack ?? e}</pre>`;
});
