/* =========================================================
 * 数学风格 3D 背景
 * - 流动的正弦曲面（点云，数学坐标网格）
 * - 环面纽结线框（拓扑学）
 * - 漂浮的数学公式精灵
 * 全部低饱和浅色，不干扰正文阅读。
 * 关闭方式：设置页「背景数学动画」，或 localStorage['coursehub-bg']='off'
 * ========================================================= */

const BG_KEY = 'coursehub-bg';
const bgEnabled = () => { try { return localStorage.getItem(BG_KEY) !== 'off'; } catch (e) { return true; } };

const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let api = { enable() {}, disable() {}, ready: false };

(async function init() {
  let THREE = null;
  /* 优先本地 vendor（国内网络必成），失败再试 CDN */
  const SOURCES = [
    './vendor/three.module.min.js',
    './three.module.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js',
    'https://unpkg.com/three@0.160.0/build/three.module.min.js'
  ];
  for (const url of SOURCES) {
    try { THREE = await import(url); break; } catch (e) { /* 换下一个源 */ }
  }
  if (!THREE) return; // 全部不可用时保持纯 CSS 背景

  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 2.4, 7.2);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  const group = new THREE.Group();
  scene.add(group);

  /* ---------- 1. 流动数学曲面（点云） ---------- */
  const COLS = 44, ROWS = 30, SEP = 0.3;
  const COUNT = COLS * ROWS;
  const pos = new Float32Array(COUNT * 3);
  const base = new Float32Array(COUNT * 2);
  let k = 0;
  for (let i = 0; i < COLS; i++) {
    for (let j = 0; j < ROWS; j++) {
      const x = (i - COLS / 2) * SEP;
      const z = (j - ROWS / 2) * SEP;
      pos[k * 3] = x; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = z;
      base[k * 2] = x; base[k * 2 + 1] = z;
      k++;
    }
  }
  const surfGeo = new THREE.BufferGeometry();
  surfGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const surf = new THREE.Points(surfGeo, new THREE.PointsMaterial({
    color: 0x9db3e4, size: 0.032, transparent: true, opacity: 0.5,
    sizeAttenuation: true, depthWrite: false
  }));
  surf.position.set(0, -1.9, 0);
  group.add(surf);

  /* ---------- 2. 环面纽结线框（拓扑） ---------- */
  const knot = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.TorusKnotGeometry(1.55, 0.42, 110, 10)),
    new THREE.LineBasicMaterial({ color: 0x6b8cc7, transparent: true, opacity: 0.12, depthWrite: false })
  );
  knot.position.set(2.7, 0.5, -2.2);
  knot.rotation.set(0.5, 0.2, 0);
  group.add(knot);

  /* ---------- 2b. 坐标球（黄铜色经纬线框，呼应铜金主色） ---------- */
  const sphere = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(1.35, 12, 8)),
    new THREE.LineBasicMaterial({ color: 0xa07a3f, transparent: true, opacity: 0.11, depthWrite: false })
  );
  sphere.position.set(-3.6, 0.7, -2.4);
  group.add(sphere);

  /* ---------- 2c. 三维坐标轴（极淡） ---------- */
  const axisGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-7, 0, 0), new THREE.Vector3(7, 0, 0),
    new THREE.Vector3(0, -2.4, 0), new THREE.Vector3(0, 3.2, 0),
    new THREE.Vector3(0, 0, -6), new THREE.Vector3(0, 0, 4)
  ]);
  const axesMat = new THREE.LineBasicMaterial({ color: 0x8a7a5c, transparent: true, opacity: 0.09, depthWrite: false });
  group.add(new THREE.LineSegments(axisGeo, axesMat));

  /* ---------- 2d. 上浮微粒（少量，增强空气感） ---------- */
  const DUST = 40;
  const dustPos = new Float32Array(DUST * 3);
  const dustSeed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 13;
    dustPos[i * 3 + 1] = (Math.random() - 0.5) * 5;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 5 - 1;
    dustSeed[i] = Math.random() * Math.PI * 2;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0xa07a3f, size: 0.045, transparent: true, opacity: 0.35,
    sizeAttenuation: true, depthWrite: false
  }));
  group.add(dust);

  /* ---------- 3. 漂浮公式精灵 ---------- */
  const FORMULAS = [
    'e^{i\u03c0} + 1 = 0',
    '\u222b\u2080^\u221e e^{\u2212x\u00b2} dx = \u221a\u03c0/2',
    '\u2211 1/n\u00b2 = \u03c0\u00b2/6',
    '\u2207 \u00d7 B = \u03bc\u2080J',
    'x\u00b2 + y\u00b2 + z\u00b2 = r\u00b2',
    'lim (1+1/n)\u207f = e',
    '\u03b4\u1d62\u2c7c = \u2211 a\u1d62\u2c7c x\u2c7c',
    'd/dx [f\u2032(x)\u00b2] = 2f\u2032f\u2033'
  ];

  function makeFormulaTexture(text, dark) {
    const c = document.createElement('canvas');
    let ctx = c.getContext('2d');
    const font = 'italic 34px "Times New Roman", "Cambria Math", "STIX Two Math", serif';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) || 120;
    c.width = w + 48; c.height = 84;
    ctx = c.getContext('2d');
    ctx.font = font;
    ctx.fillStyle = dark ? 'rgba(216,200,160,0.9)' : 'rgba(48,74,138,0.9)';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 24, 44);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  function makeFormulaSprite(text, dark) {
    const tex = makeFormulaTexture(text, dark);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0.15, depthWrite: false
    }));
    const h = 0.72;
    sp.scale.set((sp.material.map.image.width / sp.material.map.image.height) * h, h, 1);
    return sp;
  }

  const PLACES = [
    [-3.4, 1.5, -1.8], [3.6, -0.9, -1.2], [-2.2, -0.4, -2.6],
    [1.9, 1.9, -3.0], [-4.2, -1.2, -1.0], [4.4, 1.2, -2.4], [0.2, 1.1, -3.4], [-0.8, -1.4, -2.0]
  ];
  const sprites = FORMULAS.map((f, i) => {
    const sp = makeFormulaSprite(f);
    const p = PLACES[i % PLACES.length];
    sp.position.set(p[0], p[1], p[2]);
    sp.userData = { baseY: p[1], phase: i * 1.1, speed: 0.18 + (i % 3) * 0.06 };
    group.add(sp);
    return sp;
  });

  /* ---------- 主题切换（与页面深浅色联动） ---------- */

  const THEMES = {
    light: { points: 0x9db3e4, pointsOp: .5, knot: 0x6b8cc7, knotOp: .12, sphere: 0xa07a3f, sphereOp: .11, dust: 0xa07a3f, dustOp: .35, axes: 0x8a7a5c, axesOp: .09, formulaOp: .15 },
    dark: { points: 0xa8bce6, pointsOp: .5, knot: 0x9db4e0, knotOp: .18, sphere: 0xd4b478, sphereOp: .16, dust: 0xd4b478, dustOp: .34, axes: 0xa89a72, axesOp: .12, formulaOp: .2 }
  };

  function isDark() {
    return document.documentElement.dataset.theme === 'dark';
  }

  function applyBgTheme() {
    const T = THEMES[isDark() ? 'dark' : 'light'];
    surf.material.color.setHex(T.points);
    surf.material.opacity = T.pointsOp;
    knot.material.color.setHex(T.knot);
    knot.material.opacity = T.knotOp;
    sphere.material.color.setHex(T.sphere);
    sphere.material.opacity = T.sphereOp;
    dust.material.color.setHex(T.dust);
    dust.material.opacity = T.dustOp;
    axesMat.color.setHex(T.axes);
    axesMat.opacity = T.axesOp;
    sprites.forEach((sp, i) => {
      sp.material.map.dispose();
      sp.material.map = makeFormulaTexture(FORMULAS[i], isDark());
      sp.material.opacity = T.formulaOp;
      sp.material.needsUpdate = true;
    });
  }

  window.addEventListener('coursehub-theme', () => { try { applyBgTheme(); } catch (e) { /* 忽略 */ } });
  applyBgTheme();

  /* ---------- 动画循环 ---------- */
  const clock = new THREE.Clock();
  let running = false;
  let rafId = 0;
  let mx = 0, my = 0, tx = 0, ty = 0;
  window.addEventListener('pointermove', (e) => {
    tx = (e.clientX / window.innerWidth) - 0.5;
    ty = (e.clientY / window.innerHeight) - 0.5;
  }, { passive: true });

  /* 30fps 节流即可（不做低帧自杀：背景是页面标识，卡就卡在 30fps，用户可在设置关闭） */
  let lastFrameTs = 0;

  function frame(ts) {
    rafId = 0;
    if (!running) return;

    if (ts - lastFrameTs < 33) { rafId = requestAnimationFrame(frame); return; }
    lastFrameTs = ts;

    const t = clock.getElapsedTime();

    const attr = surfGeo.attributes.position;
    const arr = attr.array;
    for (let n = 0; n < COUNT; n++) {
      const x = base[n * 2], z = base[n * 2 + 1];
      arr[n * 3 + 1] = Math.sin(x * 1.05 + t * 0.55) * 0.30
        + Math.cos(z * 1.35 - t * 0.42) * 0.26
        + Math.sin((x + z) * 0.55 + t * 0.3) * 0.14;
    }
    attr.needsUpdate = true;

    knot.rotation.y = t * 0.075;
    knot.rotation.x = 0.5 + Math.sin(t * 0.13) * 0.16;

    sphere.rotation.y = -t * 0.05;
    sphere.rotation.x = Math.sin(t * 0.09) * 0.2;

    const da = dustGeo.attributes.position.array;
    for (let i = 0; i < DUST; i++) {
      da[i * 3 + 1] += 0.0035 + (i % 3) * 0.0012;
      if (da[i * 3 + 1] > 2.8) da[i * 3 + 1] = -2.8;
      da[i * 3] += Math.sin(t * 0.2 + dustSeed[i]) * 0.0008;
    }
    dustGeo.attributes.position.needsUpdate = true;

    sprites.forEach((sp) => {
      sp.position.y = sp.userData.baseY + Math.sin(t * sp.userData.speed + sp.userData.phase) * 0.22;
      sp.position.x += Math.cos(t * 0.06 + sp.userData.phase) * 0.0006;
    });

    // 相机：缓慢漂移 + 鼠标视差（阻尼）
    mx += (tx - mx) * 0.045;
    my += (ty - my) * 0.045;
    const bx = Math.sin(t * 0.05) * 0.5;
    const by = 2.4 + Math.sin(t * 0.07) * 0.18;
    camera.position.x += ((bx + mx * 1.5) - camera.position.x) * 0.06;
    camera.position.y += ((by - my * 0.9) - camera.position.y) * 0.06;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running || REDUCED) return;
    running = true;
    canvas.style.opacity = '1';
    clock.start();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    canvas.style.opacity = '0';
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } running = false; }
    else if (api.on) start();
  });

  api = {
    ready: true,
    on: bgEnabled() && !REDUCED,
    enable() { this.on = true; start(); },
    disable() { this.on = false; stop(); }
  };
  window.CourseHubBg = api;

  if (api.on) start(); else canvas.style.opacity = '0';
})();
