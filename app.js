import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// 실행 중 오류를 삼키지 않는다 — 화면과 제목에 남긴다. data.json fetch 실패도
// 여기로 잡히므로 먼저 등록한다.
addEventListener('error', e => {
  const msg = `${e.message} @ ${(e.filename||'').split('/').pop()}:${e.lineno}`;
  console.error(msg);
  document.title = 'ERROR ' + msg;
  const b = document.getElementById('boot');
  if (b) { b.classList.remove('done'); b.textContent = '오류: ' + msg; }
});

// 커넥톰 데이터는 따로 받는다 — 코드는 자주 바뀌고 이건 거의 안 바뀌므로,
// 나눠 둬야 브라우저가 이걸 다시 받지 않고 캐시에서 쓴다.
const DATA = await fetch('data.json').then(r => r.json());
const G = DATA.grid;                   // 눈 하나당 격자 변 길이
const NBIN = G * G;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const HEADLESS = location.search.includes('headless');

/* ══════════════════════════════════════════════════════════════
   모델 상수 — 커넥톰에 없는 값. 전부 여기 모아 두어 구분을 분명히 한다.
   ══════════════════════════════════════════════════════════════ */
const M = {
  tau: 0.045,          // 뉴런 시간상수 (s)
  flowGain: 0.9,       // 광학흐름 -> T4/T5 이득
  loomGain: 1.25,      // 루밍 -> LC 이득
  sight: 420,          // 루밍이 잡히는 최대 거리 (mm). 초파리 겹눈은 해상도가
                       // 낮아 먼 것을 잘 못 본다 — 이 한계가 없으면 벽처럼 크고
                       // 평평한 면이 저 멀리서부터 계속 루밍을 만들어, 파리가
                       // 책상 한가운데서만 맴돈다.
  yawGain: 3.4,        // DNa02 좌우 비대칭 -> 요 토크
  avoidGain: 14.0,     // 루밍 DN 비대칭 -> 회피 토크
  brakeGain: 4.5,      // 정면 하행뉴런 활성 -> 감속
  frontThresh: 0.045,  // 정면 회피가 걸리는 하행뉴런 활성 문턱
  cruise: 320,         // 순항 속도 (mm/s) — 초파리 실측 대역
  yawDamp: 2.6,        // 각속도 감쇠
  wander: 0.8,        // 자발적 진로 변동 (모델: 실제 파리의 자발 사카드 대용)
  hold: 285,           // 기준 고도 (mm) — 190 에서 50% 인상. 순항 고도를 정하는 건
                       // 이 값이다 (BOUND.y 는 배경 안전망일 뿐, 평소엔 다가가지 않는다) —
                       // 그래서 천장만 올리는 게 아니라 여기도 같이 올려야 체감이 바뀐다.
  bob: 140,            // 자발적 오르내림 폭 (모델) — 70 에서 올림. 순항 고도(hold) 자체를
                       // 더 올리면 낮은 물건(책·마우스 등)엔 못 앉게 되므로, 대신 오르내림
                       // 폭을 넓혀 이따금 모니터 꼭대기(470mm)까지도 닿게 한다.
  climbGain: 520,      // 루밍 상하 비대칭 -> 오르내림
  perchAfter: [15, 25],// 이만큼 날면 앉을 자리를 찾기 시작한다 (s)
  perchFor:   [3, 5],  // 앉아 쉬는 시간 (s)
  perchH: 9,           // 앉았을 때 몸 중심이 표면에서 뜨는 높이 (mm, 다리 길이)
  eyeAz: [10, 170],    // 눈 하나가 덮는 방위각 (도)
  eyeEl: [-55, 55],    // 고도각 (도)
};

/* ══════════════════════════════════════════════════════════════
   1. 책상 — 실제 축척 (mm). 파리 몸길이 약 3mm.
   ══════════════════════════════════════════════════════════════ */
// box: 중심 + 반크기 / cyl: 중심(바닥) + 반지름 + 높이
const DESK = { w: 2000, d: 1000 };
// 책상 가장자리의 보이지 않는 벽. 파리가 나갈 수 없는 실제 경계이자,
// castRay 가 맞히는 면이기도 하다 — 위치를 잘라내는 것과 눈에 보이는 것이
// 같은 값에서 나와야 파리가 '벽이 어디 있는지' 를 실제 경계와 똑같이 본다.
const BOUND = { x: DESK.w / 2, z: DESK.d / 2, y: 1050 };  // y: 보이지 않는 천장 — 700 에서 50% 인상
// 비행 중에는 항상 켜져 있다. 자체 검사의 대조 실험에서만 끈다 — 벽은 시야
// 양옆을 통째로 덮어서, 장애물 하나가 만드는 좌우 차이를 묻어버리기 때문이다.
let seesWalls = true;
const OBJECTS = [
  { k:'box', name:'모니터 패널',   p:[0,295,-395],    h:[300,175,11], c:0x14171c },
  { k:'box', name:'모니터 목',     p:[0,65,-388],     h:[22,55,20],   c:0x2b3038 },
  { k:'box', name:'모니터 받침',   p:[0,7,-358],      h:[118,7,80],   c:0x2b3038 },
  { k:'box', name:'키보드',        p:[0,13,-95],      h:[220,13,64],  c:0x1d2128 },
  { k:'box', name:'키 영역',       p:[0,27,-95],      h:[205,3,52],   c:0x353b45 },
  { k:'cyl', name:'텀블러',        p:[430,0,-120],    r:40, ht:152,   c:0x8c98a4 },
  { k:'cyl', name:'머그',          p:[-446,0,96],     r:45, ht:96,    c:0x9c6a4e },
  { k:'box', name:'책 1',          p:[-660,13,-250],  h:[105,13,75],  c:0x7d4a55 },
  { k:'box', name:'책 2',          p:[-654,39,-246],  h:[103,13,74],  c:0x3f5f7a },
  { k:'box', name:'책 3',          p:[-666,64,-254],  h:[100,12,72],  c:0x5f7048 },
  { k:'box', name:'마우스',        p:[316,18,40],     h:[33,18,55],   c:0x1e232a },
  { k:'cyl', name:'펜꽂이',        p:[556,0,-300],    r:35, ht:104,   c:0x272e37 },
  { k:'cyl', name:'펜 A',          p:[548,104,-308],  r:4,  ht:62,    c:0xc4a24a },
  { k:'cyl', name:'펜 B',          p:[564,104,-292],  r:4,  ht:70,    c:0x4a7fd0 },
  { k:'cyl', name:'램프 기둥',     p:[-854,0,-352],   r:11, ht:398,   c:0x39424d },
  { k:'box', name:'램프 갓',       p:[-854,424,-300], h:[70,30,62],   c:0x46505c },
  { k:'box', name:'서류',          p:[176,2,236],     h:[105,2,148],  c:0xcfc8ba },
  // 넓어진 책상을 채우는 물건들 — 빈 공간만 날면 루밍 회로가 할 일이 없다
  { k:'box', name:'노트북 본체',   p:[-236,7,300],    h:[160,7,112],  c:0x6b727d },
  { k:'box', name:'노트북 화면',   p:[-236,108,196],  h:[160,100,8],  c:0x2a3038 },
  { k:'cyl', name:'화분',          p:[820,0,-330],    r:58, ht:96,    c:0x9c6247 },
  { k:'cyl', name:'화분 잎',       p:[820,96,-330],   r:78, ht:150,   c:0x3f6b48 },
  { k:'cyl', name:'물병',          p:[-560,0,-40],    r:33, ht:224,   c:0x6d8fa8 },
  { k:'box', name:'휴대폰',        p:[470,4,150],     h:[36,4,74],    c:0x15181d },
  { k:'box', name:'외장 하드',     p:[700,9,120],     h:[55,9,38],    c:0x2e353f },
  // 위아래로 날 이유를 만드는 것들 — 머리 위 선반과 기둥, 낮은 지형
  { k:'box', name:'선반 상판',     p:[700,430,-300],  h:[300,11,110], c:0x5a4632 },
  { k:'box', name:'선반 다리 L',   p:[408,215,-300],  h:[11,215,100], c:0x5a4632 },
  { k:'box', name:'선반 다리 R',   p:[992,215,-300],  h:[11,215,100], c:0x5a4632 },
  { k:'box', name:'선반 위 책',    p:[560,478,-300],  h:[70,36,88],   c:0x6b4a52 },
  { k:'box', name:'선반 위 상자',  p:[850,468,-300],  h:[80,26,80],   c:0x4a5a6b },
  { k:'cyl', name:'스피커 L',      p:[-470,0,-330],   r:38, ht:186,   c:0x2a3038 },
  { k:'cyl', name:'스피커 R',      p:[470,0,-330],    r:38, ht:186,   c:0x2a3038 },
  { k:'box', name:'팜레스트',      p:[0,8,20],        h:[220,8,46],   c:0x3a3f48 },
  { k:'box', name:'스테이플러',    p:[-40,14,150],    h:[28,14,70],   c:0x8c3a3a },
  { k:'box', name:'정리함',        p:[772,42,96],     h:[70,42,92],   c:0x3a424e },
  { k:'cyl', name:'머그 2',        p:[-620,0,256],    r:42, ht:88,    c:0x4a6b7d },
  { k:'box', name:'세운 책',       p:[-900,92,330],   h:[18,92,122],  c:0x7a5f3a },
  { k:'cyl', name:'USB 허브',      p:[588,0,74],      r:26, ht:24,    c:0x22272e },
];

/* 광선 하나에 대한 최근접 거리. three.js Raycaster 는 512방향 x 매 프레임에 과하다. */
function castRay(ox, oy, oz, dx, dy, dz) {
  let best = 4000;
  // 보이지 않는 벽 — 그리지는 않지만 파리 눈에는 잡혀야 한다.
  // 이게 없으면 루밍 회로가 볼 대상이 없어 파리는 벽에 닿아서야 위치가 잘리고,
  // 그대로 벽에 붙어 미끄러진다. 안쪽에서 밖으로 나가는 광선이므로 진행 방향
  // 쪽 면까지의 거리 중 가까운 쪽이 곧 벽까지의 거리다.
  if (seesWalls) {
    if (dx > 1e-9)       { const t = ( BOUND.x - ox) / dx; if (t > 0 && t < best) best = t; }
    else if (dx < -1e-9) { const t = (-BOUND.x - ox) / dx; if (t > 0 && t < best) best = t; }
    if (dz > 1e-9)       { const t = ( BOUND.z - oz) / dz; if (t > 0 && t < best) best = t; }
    else if (dz < -1e-9) { const t = (-BOUND.z - oz) / dz; if (t > 0 && t < best) best = t; }
    if (dy > 1e-9)       { const t = (BOUND.y - oy) / dy; if (t > 0 && t < best) best = t; }
  }
  if (dy < -1e-6) {                                  // 책상 상판 (y = 0 평면)
    const t = -oy / dy;
    if (t > 0 && t < best) {
      const hx = ox + dx * t, hz = oz + dz * t;
      if (Math.abs(hx) < DESK.w / 2 && Math.abs(hz) < DESK.d / 2) best = t;
    }
  }
  for (const o of OBJECTS) {
    if (o.k === 'box') {
      // 축정렬 상자 슬래브 검사
      let t0 = 0, t1 = best;
      const p = o.p, h = o.h, od = [dx, dy, dz], oo = [ox, oy, oz];
      let hit = true;
      for (let a = 0; a < 3; a++) {
        const lo = p[a] - h[a], hi = p[a] + h[a];
        if (Math.abs(od[a]) < 1e-9) { if (oo[a] < lo || oo[a] > hi) { hit = false; break; } continue; }
        let ta = (lo - oo[a]) / od[a], tb = (hi - oo[a]) / od[a];
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { hit = false; break; }
      }
      if (hit && t0 > 0 && t0 < best) best = t0;
    } else {
      // 수직 원기둥: xz 평면에서 원, y 는 [p.y, p.y+ht] 로 자름
      const ex = ox - o.p[0], ez = oz - o.p[2];
      const a = dx * dx + dz * dz;
      if (a < 1e-12) continue;
      const b = 2 * (ex * dx + ez * dz), c = ex * ex + ez * ez - o.r * o.r;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t > 0 && t < best) {
          const hy = oy + dy * t;
          if (hy >= o.p[1] && hy <= o.p[1] + o.ht) { best = t; break; }
        }
      }
    }
  }
  return best;
}

/* ══════════════════════════════════════════════════════════════
   2. 겹눈 — 격자 칸마다 방향 벡터와 접선 기저를 미리 계산
   ══════════════════════════════════════════════════════════════ */
const RAD = Math.PI / 180;
// 눈 좌표계: +x = 앞→뒤 (T4/T5 'a' 아형 방향), +y = 위 ('c' 아형)
// 몸 좌표계: 전진 = -Z, 오른쪽 = +X, 위 = +Y
function buildEye(sideSign) {
  const dir = new Float32Array(NBIN * 3);
  const eA = new Float32Array(NBIN * 3);   // 방위각 증가 방향 (앞→뒤)
  const eE = new Float32Array(NBIN * 3);   // 고도각 증가 방향 (위)
  for (let by = 0; by < G; by++) {
    for (let bx = 0; bx < G; bx++) {
      const i = by * G + bx;
      const a = (M.eyeAz[0] + (bx + 0.5) / G * (M.eyeAz[1] - M.eyeAz[0])) * RAD;
      const e = (M.eyeEl[0] + (by + 0.5) / G * (M.eyeEl[1] - M.eyeEl[0])) * RAD;
      const sa = Math.sin(a), ca = Math.cos(a), se = Math.sin(e), ce = Math.cos(e);
      dir[i*3] = sideSign * sa * ce;  dir[i*3+1] = se;  dir[i*3+2] = -ca * ce;
      eA[i*3]  = sideSign * ca;       eA[i*3+1]  = 0;   eA[i*3+2]  = sa;
      eE[i*3]  = -sideSign * sa * se; eE[i*3+1]  = ce;  eE[i*3+2]  = ca * se;
    }
  }
  return { dir, eA, eE };
}
const EYE = { R: buildEye(1), L: buildEye(-1) };

/* ══════════════════════════════════════════════════════════════
   3. 세포 — 커넥톰에서 받아온 수용장·방향·부호·연결
   ══════════════════════════════════════════════════════════════ */
const cells = DATA.cells.map((c, i) => ({
  ...c, idx: i,
  // src = 어느 눈의 신호를 읽는가, side = 어느 하행뉴런으로 보내는가.
  // 이 둘의 대응이 곧 편측 배선이므로 따로 둔다 (대조 실험에서 끊어봐야 한다).
  src: c.side,
}));
const byGroup = g => cells.filter(c => c.group === g);
const LPTC = byGroup('LPTC'), LOOM = byGroup('LOOM'), DN = byGroup('DN');

// 하행뉴런으로 들어오는 연결을 미리 모아둔다 (부호는 시냅스전 세포의 predictedNt)
const incoming = new Map();
for (const [a, b, w] of DATA.syn) {
  if (!incoming.has(b)) incoming.set(b, []);
  incoming.get(b).push([a, w]);
}
for (const d of DN) {
  const list = incoming.get(d.idx) || [];
  d.inputs = d.inputs0 = list.map(([a, w]) => [a, w * (cells[a].nt || 1)]);
  d.norm = list.reduce((s, [, w]) => s + w, 0) || 1;
}
// 수용장의 세로 중심 (0 = 시야 아래, 1 = 위). 컬럼 ROI 에서 온 값이다.
for (const c of LOOM) {
  let sy = 0, sw = 0;
  for (const [b, w] of c.rf) { sy += Math.floor(b / G) * w; sw += w; }
  c.rfY = sw ? (sy / sw + 0.5) / G : 0.5;
}
const LOOM_LOW  = LOOM.filter(c => c.rfY < 0.42);   // 아래쪽 시야 담당
const LOOM_HIGH = LOOM.filter(c => c.rfY > 0.58);   // 위쪽 시야 담당
// 수용장의 가로 중심 (0 = 정면, 1 = 후방) — 검사에서 국소성을 확인할 때 쓴다
for (const c of LOOM) {
  let sx = 0, sw = 0;
  for (const [b, w] of c.rf) { sx += (b % G) * w; sw += w; }
  c.rfX = sw ? (sx / sw + 0.5) / G : 0.5;
}

// 각 하행뉴런이 '어느 눈에서 얼마나 듣는가' 를 입력 시냅스 가중치에서 계산한다.
// 세포체가 오른쪽이라고 오른쪽 눈을 듣는 게 아니다 — 도피 DN 은 반대쪽에서
// 받는 경우가 많다. 가정하지 말고 커넥톰이 말하게 한다.
// lat = +1 이면 오른쪽 눈 주도, -1 이면 왼쪽 눈 주도.
function computeLaterality() {
  for (const d of DN) {
    let l = 0, r = 0;
    for (const [a, w] of d.inputs) {
      const c = cells[a];
      if (c.group === 'DN') continue;
      (c.src === 'L' ? (l += Math.abs(w)) : (r += Math.abs(w)));
    }
    d.lat = (l + r) ? (r - l) / (r + l) : 0;
  }
}

const namedDN = t => DN.filter(d => d.type === t);
const STEER = namedDN('DNa02').length ? namedDN('DNa02') : namedDN('DNa01');
const ESCAPE = DN.filter(d => /^DNp(01|02|03|04|103)$/.test(d.type));
computeLaterality();

// 편측성 가중 합 — 커넥톰이 정한 편측성으로 활성을 모은다
const lateral = (F, list) => {
  let t = 0;
  for (const d of list) t += F.act[d.idx] * d.lat;
  return t / (list.length || 1);
};

/* ── 파리 한 마리 = 몸 하나 + 자기 뇌 하나 ──────────────────
   세포의 배선·수용장·가중치는 세 마리가 공유하지만(같은 커넥톰),
   활성은 각자 자기 눈으로 본 것에서 나오므로 파리마다 따로 가진다. */
const N_FLIES = 3;
const FLY_STYLE = [
  { name: '파리 1', color: '#e0b04a', start: [-560, 120,  260], yaw:  0.6, phase: 0.0 },
  { name: '파리 2', color: '#7fe0a0', start: [ 420, 150, -40], yaw: -2.1, phase: 2.1 },
  { name: '파리 3', color: '#e88bd0', start: [  60, 90,  330], yaw:  2.6, phase: 4.3 },
];

const rand = (a, b) => a + Math.random() * (b - a);

function makeFly(i) {
  const st = FLY_STYLE[i];
  const f = {
    i, ...st,
    pos: new THREE.Vector3(...st.start),
    quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), st.yaw),
    vel: new THREE.Vector3(),
    yawRate: 0, hits: 0, speed: 0, contact: false, wingPhase: st.phase * 3,
    // perchT > 0 이면 앉아 있는 중, flyT <= 0 이면 앉을 자리를 찾는 중.
    // 세 마리가 한꺼번에 앉지 않도록 처음부터 제각각 다른 값에서 시작한다.
    perchT: 0, flyT: rand(M.perchAfter[0], M.perchAfter[1]),
    act:   new Float32Array(cells.length),
    input: new Float32Array(cells.length),
    depthL: new Float32Array(NBIN), depthR: new Float32Array(NBIN),
    loomL:  new Float32Array(NBIN), loomR:  new Float32Array(NBIN),
    flowL:  new Float32Array(NBIN * 2), flowR: new Float32Array(NBIN * 2),
  };
  return f;
}
const flies = Array.from({ length: N_FLIES }, (_, i) => makeFly(i));

const lesion = { circuit: true, loom: true, lptc: true };
let paused = false;

const _m3 = new THREE.Matrix3();
const _m4 = new THREE.Matrix4();

/* ── 한 눈의 깊이 · 광학흐름 · 루밍 (모델) ──────────────── */
function sampleEye(F, eye, depth, loom, flow, R, omega) {
  const { pos, vel } = F;
  for (let i = 0; i < NBIN; i++) {
    // 몸 좌표계 방향을 월드로
    const lx = eye.dir[i*3], ly = eye.dir[i*3+1], lz = eye.dir[i*3+2];
    const dx = R[0]*lx + R[3]*ly + R[6]*lz;
    const dy = R[1]*lx + R[4]*ly + R[7]*lz;
    const dz = R[2]*lx + R[5]*ly + R[8]*lz;

    const Z = castRay(pos.x, pos.y, pos.z, dx, dy, dz);
    depth[i] = Z;

    // 접근 속도 / 거리 = 1 / (충돌까지 남은 시간)
    const closing = vel.x*dx + vel.y*dy + vel.z*dz;
    const near = Math.max(0, 1 - Z / M.sight);          // 멀수록 흐려지다 sight 에서 0
    loom[i] = closing > 0 ? Math.min(6, closing / Math.max(Z, 8)) * near : 0;

    // 운동장: 병진 성분은 거리에 반비례, 회전 성분은 거리와 무관
    const vd = closing / Math.max(Z, 8);
    const tx = -(vel.x / Math.max(Z, 8) - vd * dx);
    const ty = -(vel.y / Math.max(Z, 8) - vd * dy);
    const tz = -(vel.z / Math.max(Z, 8) - vd * dz);
    const rx = -(omega.y * dz - omega.z * dy);
    const ry = -(omega.z * dx - omega.x * dz);
    const rz = -(omega.x * dy - omega.y * dx);
    const fx = tx + rx, fy = ty + ry, fz = tz + rz;

    // 눈 접선 기저에 투영 (기저도 월드로 회전시켜야 한다)
    const ax = eye.eA[i*3], ay = eye.eA[i*3+1], az = eye.eA[i*3+2];
    const bx = eye.eE[i*3], by = eye.eE[i*3+1], bz = eye.eE[i*3+2];
    const wax = R[0]*ax + R[3]*ay + R[6]*az, way = R[1]*ax + R[4]*ay + R[7]*az, waz = R[2]*ax + R[5]*ay + R[8]*az;
    const wbx = R[0]*bx + R[3]*by + R[6]*bz, wby = R[1]*bx + R[4]*by + R[7]*bz, wbz = R[2]*bx + R[5]*by + R[8]*bz;
    flow[i*2]     = fx*wax + fy*way + fz*waz;
    flow[i*2 + 1] = fx*wbx + fy*wby + fz*wbz;
  }
}

/* ── 세포 구동: 여기서부터 커넥톰 가중치가 쓰인다 ───────── */
function driveCells(F) {
  for (const c of LPTC) {
    const flow = c.src === 'L' ? F.flowL : F.flowR;
    const [px, py] = c.dir || [0, 0];
    let sum = 0;
    // 수용장 = 이 세포의 수상돌기가 덮는 시각 컬럼 (커넥톰)
    // 선호 방향 = T4/T5 아형별 시냅스 가중치 합 (커넥톰)
    for (const [b, w] of c.rf) {
      const r = flow[b*2] * px + flow[b*2 + 1] * py;
      if (r > 0) sum += w * r;
    }
    F.input[c.idx] = lesion.lptc ? M.flowGain * sum : 0;
  }
  for (const c of LOOM) {
    const loom = c.src === 'L' ? F.loomL : F.loomR;
    let sum = 0;
    for (const [b, w] of c.rf) sum += w * loom[b];
    F.input[c.idx] = lesion.loom ? M.loomGain * sum : 0;
  }
  for (const d of DN) {
    let sum = 0;
    for (const [a, w] of d.inputs) sum += w * F.act[a];
    F.input[d.idx] = sum / d.norm;
  }
}

/* ── 누설 적분 + 포화 (모델) ────────────────────────────── */
function integrate(F, dt) {
  const k = 1 - Math.exp(-dt / M.tau);
  for (let i = 0; i < cells.length; i++) {
    const inp = F.input[i];
    const target = inp > 0 ? inp / (1 + inp) : 0;     // 부드러운 포화
    F.act[i] += (target - F.act[i]) * k;
  }
}

/* ══════════════════════════════════════════════════════════════
   대조 실험 — 커넥톰에서 온 값만 망가뜨린다.
   세포 수, 총 시냅스량, 수용장 크기, 모델 상수는 전부 그대로 두고
   "어느 세포가 어느 눈을 보는가 / 어디를 보는가 / 어떤 가중치로 연결되는가"
   만 무작위화한다. 이래도 성능이 같다면 커넥톰은 장식이라는 뜻이다.
   ══════════════════════════════════════════════════════════════ */
for (const c of cells) { c.src0 = c.src; c.rf0 = c.rf; c.dir0 = c.dir; }
let scramble = 'none';

function setScramble(mode) {
  scramble = mode;
  let seed = 20260903;                                  // 재현 가능한 난수
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const shuffled = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  for (const c of cells) { c.src = c.src0; c.rf = c.rf0; c.dir = c.dir0; }
  for (const d of DN) d.inputs = d.inputs0;

  if (mode === 'halfmirror') {
    // 세포의 절반만 무작위로 반대쪽 눈을 읽게 한다.
    // 전부 뒤집으면 그건 좌우 이름 바꾸기(대칭 변환)라 파리는 거울상으로
    // 똑같이 잘 난다 — 반증이 되지 않는다. 절반만 깨야 편측성이 무너진다.
    for (const c of [...LPTC, ...LOOM])
      if (rnd() < 0.5) c.src = (c.src === 'L' ? 'R' : 'L');
  } else if (mode === 'rf') {
    // 수용장과 그것이 속한 눈을 함께 뒤섞는다 — 세포 수와 수용장 크기 분포는
    // 그대로, "누가 어디를 보는가" 만 무작위가 된다.
    for (const grp of [LPTC, LOOM]) {
      const pool = shuffled(grp.map(c => [c.rf0, c.src0]));
      grp.forEach((c, i) => { c.rf = pool[i][0]; c.src = pool[i][1]; });
    }
    for (const c of LOOM) {          // 상/하 분류도 새 수용장 기준으로
      let sx = 0, sy = 0, sw = 0;
      for (const [b, w] of c.rf) { sx += (b % G) * w; sy += Math.floor(b / G) * w; sw += w; }
      c.rfX = sw ? (sx / sw + 0.5) / G : 0.5;
      c.rfY = sw ? (sy / sw + 0.5) / G : 0.5;
    }
  } else if (mode === 'rewire') {
    // 하행뉴런의 입력 세포를 무작위로 다시 잇는다. 연결 개수와 가중치 분포는
    // 그대로 두고 "루밍 세포가 도피 DN 으로, HS 가 조향 DN 으로" 라는
    // 특이성만 없앤다.
    const pool = [...LPTC, ...LOOM].map(c => c.idx);
    for (const d of DN) {
      const pick = shuffled(pool);
      d.inputs = d.inputs0.map(([, w], i) => {
        const src = pick[i % pick.length];
        return [src, Math.abs(w) * (cells[src].nt || 1)];
      });
    }
  }
  computeLaterality();
  for (const F of flies) { F.act.fill(0); F.input.fill(0); }
}

const meanAct = (F, list) => {
  let t = 0;
  for (const c of list) t += F.act[c.idx];
  return list.length ? t / list.length : 0;
};

const sideSum = (F, list, s) => {
  let t = 0, n = 0;
  for (const c of list) if (c.side === s) { t += F.act[c.idx]; n++; }
  return n ? t / n : 0;
};

/* ══════════════════════════════════════════════════════════════
   4. 비행 (모델) — 회로 출력을 토크와 추력으로
   ══════════════════════════════════════════════════════════════ */
const _fwd = new THREE.Vector3(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0,1,0);

function step(F, dt, t) {
  _m3.setFromMatrix4(_m4.makeRotationFromQuaternion(F.quat));
  const R = _m3.elements;
  const omega = { x: 0, y: F.yawRate, z: 0 };

  sampleEye(F, EYE.L, F.depthL, F.loomL, F.flowL, R, omega);
  sampleEye(F, EYE.R, F.depthR, F.loomR, F.flowR, R, omega);
  driveCells(F);
  integrate(F, dt);

  // 앉아 있는 동안. 눈은 뜨고 있으므로 회로는 계속 돌지만, 움직이지 않으니
  // 광학흐름도 루밍도 0 으로 잦아든다 — 그 파리의 뉴런 지도가 조용해진다.
  if (F.perchT > 0) {
    F.perchT -= dt;
    F.vel.set(0, 0, 0);
    F.yawRate = 0;
    F.speed = 0;
    if (F.perchT <= 0) F.flyT = rand(M.perchAfter[0], M.perchAfter[1]);   // 다시 이륙
    return { steer: 0, escape: meanAct(F, ESCAPE), front: 0, torque: 0 };
  }

  // 요 부호 규약: +Y 축 양의 회전 = 좌회전 (three.js 기준).
  // 조향: 오른쪽 눈이 앞→뒤 흐름을 보면(파리가 왼쪽으로 밀렸다는 뜻) 오른쪽으로 되돌린다.
  // 어느 DN 이 어느 눈을 듣는지는 커넥톰에서 계산한 lat 값이 정한다.
  const steer = lateral(F, STEER);
  let circuitTorque = -M.yawGain * steer;

  // 회피 명령은 전부 하행뉴런을 통과한다. 루밍 세포에서 바로 뽑으면
  // DN 층이 장식이 되고, 배선을 무작위로 바꿔도 성능이 그대로가 된다.
  const escape = meanAct(F, ESCAPE);
  // 오른쪽 눈 주도 DN 이 켜졌다 = 오른쪽에 뭔가 온다 -> 왼쪽(+)으로 튼다
  circuitTorque += M.avoidGain * lateral(F, ESCAPE);

  // 정면이 막혔으면 덜 막힌 쪽으로 강하게 튼다 — 이것도 DN 활성에서 뽑는다.
  const front = escape;
  if (front > M.frontThresh) {
    const bias = lateral(F, ESCAPE);
    circuitTorque += (bias >= 0 ? 1 : -1) * M.avoidGain * 1.4;
  }

  // 회로를 차단하면 파리는 직진만 한다. 자발 변동과 경계 복귀는 회로와 무관하므로 남긴다.
  let yawTorque = lesion.circuit ? circuitTorque : 0;

  // 자발적 진로 변동 (모델: 실제 파리의 자발 사카드 대용)
  const tp = t + F.phase * 7;
  yawTorque += M.wander * Math.sin(tp * 0.31) * Math.cos(tp * 0.17 + 1.3);

  // 책상 밖으로 향하면 안쪽으로 되돌린다 (충돌이 아니라 진로 편향)
  // 전진 방향은 회전행렬에서 직접 뽑는다 — 쿼터니언 대수보다 틀릴 여지가 없다
  const fwdX = -R[6], fwdZ = -R[8];
  const outX = Math.abs(F.pos.x) - DESK.w / 2;
  const outZ = Math.abs(F.pos.z) - DESK.d / 2;
  if (outX > -80 || outZ > -80) {
    const inward = Math.atan2(-F.pos.x, -F.pos.z);
    const heading = Math.atan2(fwdX, fwdZ);
    let d = inward - heading;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const urgency = Math.min(1, (Math.max(outX, outZ) + 80) / 140);
    yawTorque += d * 3.2 * urgency;
  }

  F.yawRate += (yawTorque - M.yawDamp * F.yawRate) * dt;
  F.yawRate = Math.max(-9, Math.min(9, F.yawRate));

  _q.setFromAxisAngle(_up, F.yawRate * dt);
  F.quat.multiplyQuaternions(_q, F.quat);

  // 추력: 정면이 막히면 감속
  _fwd.set(0, 0, -1).applyQuaternion(F.quat);
  let speed = M.cruise * Math.max(0.3, 1 - M.brakeGain * front);
  F.vel.copy(_fwd).multiplyScalar(speed);

  // 수직 운동
  const below = castRay(F.pos.x, F.pos.y, F.pos.z, 0, -1, 0);
  const above = castRay(F.pos.x, F.pos.y, F.pos.z, 0,  1, 0);
  // 앉을 자리 찾기 (모델). 목표를 정해 날아가는 게 아니라, 낮게 날다가
  // 마침 발밑에 물건이 있으면 그 위에 내려앉는다.
  F.flyT -= dt;
  const seeking = F.flyT <= 0;
  // 주기가 다른 두 성분을 겹쳐 기계적으로 오르내리지 않게 한다 (모델)
  const want = M.hold + M.bob * Math.sin(tp * 0.41) + M.bob * 0.7 * Math.sin(tp * 0.19 + 2.1);
  let vy = (want - F.pos.y) * 1.0;
  vy += Math.max(0, 55 - below) * 2.9;        // 바닥·물체 위에서 상승
  vy -= Math.max(0, 55 - above) * 2.9;        // 선반 아래에서 하강
  // 루밍이 시야 아래쪽에 몰리면 넘어가고, 위쪽이면 아래로 뺀다.
  // 어느 세포가 위/아래를 맡는지는 커넥톰의 컬럼 수용장에서 나온 값이다.
  if (lesion.circuit)
    vy += M.climbGain * (meanAct(F, LOOM_LOW) - meanAct(F, LOOM_HIGH));

  if (seeking) {
    const top = perchUnder(F.pos.x, F.pos.z, F.pos.y);
    if (top !== null && F.pos.y - top < 220) {
      vy = -240;                              // 내려앉는 중
      speed *= 0.18;                          // 거의 제자리에서 내려온다
      F.vel.copy(_fwd).multiplyScalar(speed);
      // 임계값 20mm: 한 프레임 하강폭(최대 dt 0.05 × 240 = 12mm)보다 넉넉히 커서
      // 그냥 지나쳐 물체 안으로 들어가는 일이 없다.
      if (F.pos.y - top < 20) {               // 착지
        F.pos.y = top + M.perchH;
        F.perchT = rand(M.perchFor[0], M.perchFor[1]);
        F.vel.set(0, 0, 0);
        F.speed = 0;
        return { steer, escape, front, torque: circuitTorque };
      }
    }
  }
  F.vel.y = Math.max(-320, Math.min(320, vy));
  F.speed = speed;

  const next = F.pos.clone().addScaledVector(F.vel, dt);

  // 장애물 충돌: 접촉이 이어지는 동안 한 번만 센다
  if (inside(next)) {
    if (!F.contact) {
      F.hits++;
      F.yawRate += (F.yawRate >= 0 ? 1 : -1) * 6.5;   // 돌던 방향으로 크게 튼다
    }
    F.contact = true;
    F.pos.addScaledVector(F.vel, -dt * 1.6);           // 확실히 떼어놓는다
    F.vel.multiplyScalar(0.3);
  } else {
    F.contact = false;
    F.pos.copy(next);
  }
  // 벽을 넘지 못하게 하는 최후의 안전망. 평소에는 루밍 회로가 벽을 보고 미리
  // 틀기 때문에 여기까지 오지 않는다 — 회로를 차단했을 때만 걸린다.
  F.pos.x = Math.max(-BOUND.x, Math.min(BOUND.x, F.pos.x));
  F.pos.z = Math.max(-BOUND.z, Math.min(BOUND.z, F.pos.z));
  F.pos.y = Math.min(BOUND.y + 40, F.pos.y);   // 안전망 — 평소엔 위 천장 인지가 먼저 막는다
  F.pos.y = Math.max(14, F.pos.y);
  return { steer, escape, front, torque: circuitTorque };
}

/* (x,z) 바로 아래에 있는 물건들 중 가장 높은 윗면. 없으면 null.
   책상 상판(y=0)은 세지 않는다 — 파리는 '장애물 위'에 앉는다.
   castRay 로 아래를 쏘지 않는 이유: 수직 광선은 원기둥 옆면 방정식에서
   a = dx²+dz² = 0 이 되어 곧바로 건너뛰어진다. 즉 텀블러·머그·화분 같은
   원기둥의 윗면을 통째로 놓친다. 여기서는 윗면만 필요하므로 직접 본다. */
function perchUnder(x, z, y) {
  let top = null;
  for (const o of OBJECTS) {
    let t = null;
    if (o.k === 'box') {
      if (Math.abs(x - o.p[0]) < o.h[0] && Math.abs(z - o.p[2]) < o.h[2]) t = o.p[1] + o.h[1];
    } else {
      const dx = x - o.p[0], dz = z - o.p[2];
      if (dx * dx + dz * dz < o.r * o.r) t = o.p[1] + o.ht;
    }
    if (t !== null && t < y && (top === null || t > top)) top = t;
  }
  return top;
}

function inside(p) {
  for (const o of OBJECTS) {
    if (o.k === 'box') {
      if (Math.abs(p.x - o.p[0]) < o.h[0] + 6 && Math.abs(p.y - o.p[1]) < o.h[1] + 6 &&
          Math.abs(p.z - o.p[2]) < o.h[2] + 6) return true;
    } else {
      const dx = p.x - o.p[0], dz = p.z - o.p[2];
      if (dx*dx + dz*dz < (o.r + 6) ** 2 && p.y > o.p[1] - 6 && p.y < o.p[1] + o.ht + 6) return true;
    }
  }
  return false;
}

// 렌더링은 boot() 안에 가둔다 — ?headless 자체 검사는 WebGL 없이 돌아야 한다
function boot() {
  /* ══════════════════════════════════════════════════════════════
     5. 렌더 — 한 렌더러를 뷰포트 둘로 나눠 쓴다
     ══════════════════════════════════════════════════════════════ */
  const stage = document.getElementById('stage');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      // Windows 듀얼 GPU 노트북은 이 힌트가 없으면 보통 내장 GPU 를 고른다.
      // NVIDIA/AMD 외장 GPU 를 쓰게 하는 결정적인 한 줄.
      powerPreference: 'high-performance',
      // 렌더 루프가 매 프레임 전체를 다시 그리므로 보존할 필요가 없다
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,   // 소프트웨어 폴백도 일단 허용
    });
  } catch (err) {
    document.getElementById('boot').outerHTML =
      `<div id="boot" style="padding:24px;text-align:center;line-height:1.8">` +
      `WebGL 을 초기화하지 못했습니다.<br>브라우저의 하드웨어 가속을 켜고 다시 열어주세요.` +
      `<br><span style="color:var(--ink-faint)">${err.message}</span></div>`;
    throw err;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setScissorTest(true);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  stage.appendChild(renderer.domElement);

  // 어떤 GPU 로 그리고 있는지 읽어 둔다 (드라이버가 가리면 unknown)
  let gpuName = 'unknown';
  {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) gpuName = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    gpuName = gpuName.replace(/^ANGLE \(|\)$/g, '').split(',').slice(-2)[0] || gpuName;
  }

  // GPU 컨텍스트가 날아가도(탭 전환·드라이버 리셋) 페이지가 죽지 않게 한다
  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    document.getElementById('boot').classList.remove('done');
    document.getElementById('boot').textContent = 'GPU 컨텍스트 복구 중';
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    document.getElementById('boot').classList.add('done');
  });

  /* ── 책상 장면 ────────────────────────────────────────────
     OBJECTS 는 물리(레이캐스트·충돌) 프록시다. 아래 장식 메시는
     그 프록시 안/위에만 얹어 보이는 것과 파리가 '보는' 것이 어긋나지 않게 한다. */
  const world = new THREE.Scene();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  world.add(new THREE.HemisphereLight(0x9fb8d8, 0x2e2519, 1.35));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.9);
  key.position.set(-700, 1150, 560);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  {
    const c = key.shadow.camera;
    c.left = -1250; c.right = 1250; c.top = 980; c.bottom = -980; c.near = 100; c.far = 3000;
  }
  world.add(key);
  const rim = new THREE.DirectionalLight(0x7d9ad8, 1.05);
  rim.position.set(600, 260, -700);
  world.add(rim);

  const mat = (color, rough = 0.75, metal = 0.0, extra = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });

  const place = (mesh, x, y, z, cast = true) => {
    mesh.position.set(x, y, z);
    mesh.castShadow = cast; mesh.receiveShadow = true;
    world.add(mesh);
    return mesh;
  };

  // 책상 상판 — 나뭇결 느낌의 따뜻한 갈색
  const top = new THREE.Mesh(new THREE.BoxGeometry(DESK.w, 20, DESK.d), mat(0x4a3a2a, 0.85));
  top.position.y = -10; top.receiveShadow = true;
  world.add(top);
  {  // 결 방향 줄무늬
    const g = new THREE.BufferGeometry(); const v = [];
    for (let x = -DESK.w/2 + 20; x < DESK.w/2; x += 30)
      v.push(x, 0.6, -DESK.d/2, x + 8, 0.6, DESK.d/2);
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    world.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial(
      { color: 0x2a2018, transparent: true, opacity: 0.55 })));
  }

  /* 모니터 */
  place(new THREE.Mesh(new THREE.BoxGeometry(600, 350, 22), mat(0x14171c, 0.55)), 0, 295, -395);
  // 화면 — 파리가 자기 뇌 데이터를 띄운 모니터 주위를 난다.
  // 수치는 전부 지금 구동 중인 커넥톰에서 가져온 실제 값이고, 막대는 실시간이다.
  const scr = document.createElement('canvas');
  scr.width = 768; scr.height = 448;
  const sc = scr.getContext('2d');
  const scrTex = new THREE.CanvasTexture(scr);
  scrTex.colorSpace = THREE.SRGBColorSpace;
  {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(566, 330),
      new THREE.MeshBasicMaterial({ map: scrTex }));
    screen.position.set(0, 297, -383.4);
    world.add(screen);
    const glow = new THREE.PointLight(0x5fa8e8, 0.6, 1000, 2);
    glow.position.set(0, 290, -300);
    world.add(glow);
  }

  // 화면에 띄울 실제 수치
  const SCREEN_ROWS = (() => {
    const pick = (t, side) => cells.find(c => c.type === t && c.side === side);
    const rows = [];
    for (const [t, side, tag] of [['HSE', 'R', '수평 →'], ['HSN', 'L', '수평 →'],
                                  ['VS', 'R', '수직 ↓'], ['VST2', 'L', '수직 ↓']]) {
      const c = pick(t, side);
      if (c && c.drive) rows.push([`${t}_${side}`, c.drive, tag, c.rf.length]);
    }
    return rows;
  })();
  const SCREEN_COUNT = {
    cells: cells.length, syn: DATA.syn.length,
    lptc: LPTC.length, loom: LOOM.length, dn: DN.length,
  };

  function drawScreen(act) {
    const W = scr.width, H = scr.height;
    sc.fillStyle = '#0d1420'; sc.fillRect(0, 0, W, H);
    // 창 상단 바
    sc.fillStyle = '#18222f'; sc.fillRect(0, 0, W, 34);
    sc.fillStyle = '#7fd1ff'; sc.font = '600 17px ui-monospace, Menlo, monospace';
    sc.fillText('neuPrint', 16, 23);
    sc.fillStyle = '#8fa3b8'; sc.font = '15px ui-monospace, Menlo, monospace';
    sc.fillText('male-cns:v1.0  —  Drosophila male CNS connectome', 96, 23);
    for (let k = 0; k < 3; k++) {
      sc.fillStyle = ['#e05f56', '#e0b04a', '#5fc47a'][k];
      sc.beginPath(); sc.arc(W - 24 - k * 22, 17, 5.5, 0, 7); sc.fill();
    }

    // Cypher 질의
    sc.font = '15px ui-monospace, Menlo, monospace';
    let y = 62;
    for (const [txt, col] of [
      ['MATCH (a:Neuron)-[w:ConnectsTo]->(b:Neuron)', '#c8d6e6'],
      ['WHERE a.type =~ "T4.|T5."', '#c8d6e6'],
      ['RETURN b.type, sum(w.weight) AS syn', '#c8d6e6'],
      ['  → 방향 선택성이 시냅스 가중치에서 그대로 나온다', '#5f7a95'],
    ]) { sc.fillStyle = col; sc.fillText(txt, 16, y); y += 21; }

    // 실제 세포별 수치
    y += 12;
    sc.fillStyle = '#3a4a5e'; sc.fillRect(16, y - 16, W - 32, 1);
    y += 8;
    sc.font = '15px ui-monospace, Menlo, monospace';
    sc.fillStyle = '#5f7a95';
    sc.fillText('세포        T4/T5 입력      수용장      선호 방향', 16, y); y += 22;
    for (const [name, drive, tag, rf] of SCREEN_ROWS) {
      sc.fillStyle = '#9fd2ff'; sc.fillText(name.padEnd(11), 16, y);
      sc.fillStyle = '#e0e8f2'; sc.fillText(String(drive).padStart(6) + ' 시냅스', 122, y);
      sc.fillStyle = '#8fa3b8'; sc.fillText(String(rf).padStart(4) + ' 칸', 290, y);
      sc.fillStyle = '#7fd1ff'; sc.fillText(tag, 400, y);
      y += 21;
    }

    // 실시간 활성 막대
    y += 18;
    sc.fillStyle = '#3a4a5e'; sc.fillRect(16, y - 16, W - 32, 1);
    y += 6;
    sc.fillStyle = '#5f7a95'; sc.fillText('실시간 활성', 16, y); y += 24;
    for (const [label, v, col] of [
      ['자세 · 진로  HS/VS', act.lptc, '#55c7f5'],
      ['루밍  LPLC2/LC4',   act.loom, '#dd7de6'],
      ['하행 명령  DN',      act.dn,   '#ff6f61'],
    ]) {
      sc.fillStyle = '#8fa3b8'; sc.fillText(label, 16, y + 13);
      sc.fillStyle = '#1a2431'; sc.fillRect(230, y, 400, 16);
      sc.fillStyle = col; sc.fillRect(230, y, Math.min(400, v * 560), 16);
      sc.fillStyle = '#c8d6e6'; sc.fillText(v.toFixed(2), 644, y + 13);
      y += 26;
    }

    // 하단 상태줄
    sc.fillStyle = '#18222f'; sc.fillRect(0, H - 30, W, 30);
    sc.fillStyle = '#5f7a95'; sc.font = '14px ui-monospace, Menlo, monospace';
    sc.fillText(`뉴런 ${SCREEN_COUNT.cells} · 연결 ${SCREEN_COUNT.syn.toLocaleString()} · ` +
      `LPTC ${SCREEN_COUNT.lptc} · 루밍 ${SCREEN_COUNT.loom} · DN ${SCREEN_COUNT.dn}`, 16, H - 10);
    scrTex.needsUpdate = true;
  }
  drawScreen({ lptc: 0, loom: 0, dn: 0 });
  place(new THREE.Mesh(new THREE.CylinderGeometry(16, 26, 110, 16), mat(0x2b3038, 0.5, 0.6)), 0, 65, -388);
  place(new THREE.Mesh(new THREE.CylinderGeometry(118, 128, 14, 28), mat(0x2b3038, 0.45, 0.7)), 0, 7, -358);

  /* 키보드 — 키캡은 InstancedMesh 한 번에 */
  place(new THREE.Mesh(new THREE.BoxGeometry(440, 26, 128), mat(0x1d2128, 0.7)), 0, 13, -95);
  {
    const rows = 5, cols = 15, kw = 24, gap = 3.6;
    const keys = new THREE.InstancedMesh(
      new THREE.BoxGeometry(kw, 7, kw), mat(0x353b45, 0.85), rows * cols);
    keys.castShadow = true;
    const m4 = new THREE.Matrix4(); let n = 0;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        m4.makeTranslation(
          -((cols - 1) / 2) * (kw + gap) + c * (kw + gap) + (r === 4 ? 0 : r * 2.5),
          29.5, -95 - ((rows - 1) / 2) * (kw + gap) + r * (kw + gap)),
        keys.setMatrixAt(n++, m4);
    world.add(keys);
    // 스페이스바
    place(new THREE.Mesh(new THREE.BoxGeometry(150, 7, 22), mat(0x353b45, 0.85)), 0, 29.5, -38);
  }

  /* 텀블러 — 아래로 갈수록 좁아지는 형태 + 뚜껑 + 실리콘 밴드 */
  place(new THREE.Mesh(new THREE.CylinderGeometry(40, 33, 140, 26), mat(0x8c98a4, 0.28, 0.85)), 430, 70, -120);
  place(new THREE.Mesh(new THREE.CylinderGeometry(41, 41, 14, 26), mat(0x20252c, 0.6)), 430, 147, -120);
  place(new THREE.Mesh(new THREE.TorusGeometry(38, 5, 8, 26), mat(0x3f6b5e, 0.9)), 430, 44, -120)
    .rotation.x = Math.PI / 2;

  /* 머그 + 손잡이 + 커피 */
  place(new THREE.Mesh(new THREE.CylinderGeometry(45, 40, 96, 24), mat(0x9c6a4e, 0.72)), -446, 48, 96);
  place(new THREE.Mesh(new THREE.TorusGeometry(26, 6.5, 8, 18, Math.PI * 1.25), mat(0x9c6a4e, 0.72)), -488, 52, 96)
    .rotation.set(0, Math.PI / 2, -0.35);
  place(new THREE.Mesh(new THREE.CircleGeometry(41, 24), mat(0x2b170d, 0.25)), -446, 92, 96, false)
    .rotation.x = -Math.PI / 2;

  /* 쌓인 책 — 표지 + 책배(페이지) 색 분리 */
  for (const [x, y, z, w, h, d, cover, rot] of [
    [-660, 13, -250, 210, 26, 150, 0x7d4a55, 0.05],
    [-654, 39, -246, 206, 26, 148, 0x3f5f7a, -0.09],
    [-666, 64, -254, 200, 24, 144, 0x5f7048, 0.14],
  ]) {
    place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(cover, 0.88)), x, y, z).rotation.y = rot;
    // 페이지는 표지 안쪽으로 확실히 넣는다. 간격이 몇 mm 면 이 축척에서
    // 화면상 1픽셀 미만이라 각도에 따라 면이 서로 뚫고 나온다(z-fighting).
    const pages = place(new THREE.Mesh(new THREE.BoxGeometry(w - 26, h - 9, d - 22), mat(0xd8cfbb, 0.95)),
      x + 6, y, z);
    pages.rotation.y = rot;
  }

  /* 마우스 — 눌린 구 + 버튼 분할선 */
  {
    const m = place(new THREE.Mesh(new THREE.SphereGeometry(34, 20, 14), mat(0x1e232a, 0.5)), 316, 8, 40);
    m.scale.set(1, 0.55, 1.7);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([316, 27, -8, 316, 27, 28], 3));
    world.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5a6472 })));
    place(new THREE.Mesh(new THREE.BoxGeometry(7, 4, 13), mat(0x39404b, 0.7)), 316, 28, 4);
  }

  /* 펜꽂이 + 펜 */
  place(new THREE.Mesh(new THREE.CylinderGeometry(35, 31, 104, 18), mat(0x272e37, 0.65, 0.3)), 556, 52, -300);
  for (const [dx, dz, len, tilt, col] of [
    [-8, -8, 130, 0.13, 0xc4a24a], [8, 6, 146, -0.1, 0x4a7fd0], [2, -12, 120, 0.18, 0xc4564a],
  ]) {
    const pen = place(new THREE.Mesh(new THREE.CylinderGeometry(4, 4, len, 10), mat(col, 0.5, 0.3)),
      556 + dx, 60 + len / 2 - 20, -300 + dz);
    pen.rotation.set(tilt, 0, tilt * 0.8);
    place(new THREE.Mesh(new THREE.ConeGeometry(4, 12, 10), mat(0x1c2026, 0.6)),
      556 + dx + Math.sin(tilt * 0.8) * len / 2, 60 + len - 20, -300 + dz - Math.sin(tilt) * len / 2)
      .rotation.set(tilt, 0, tilt * 0.8);
  }

  /* 데스크 램프 — 받침 · 기둥 · 관절 팔 · 갓 */
  place(new THREE.Mesh(new THREE.CylinderGeometry(62, 68, 16, 24), mat(0x2b323b, 0.5, 0.5)), -854, 8, -352);
  place(new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 398, 14), mat(0x39424d, 0.45, 0.6)), -854, 199, -352);
  place(new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 130, 12), mat(0x39424d, 0.45, 0.6)), -854, 404, -314)
    .rotation.x = Math.PI / 2.4;
  {
    const shade = place(new THREE.Mesh(new THREE.ConeGeometry(58, 74, 22, 1, true), mat(0x46505c, 0.6, 0.4)),
      -854, 420, -272);
    shade.rotation.x = 2.5;
    shade.material.side = THREE.DoubleSide;
    const bulb = new THREE.PointLight(0xffd9a0, 0.9, 700, 2);
    bulb.position.set(-828, 380, -246);
    world.add(bulb);
  }

  /* 서류 더미 + 포스트잇 */
  for (let k = 0; k < 4; k++)
    place(new THREE.Mesh(new THREE.BoxGeometry(210, 1.6, 296), mat(0xcfc8ba, 0.95)),
      176 + k * 3.5, 1 + k * 1.7, 236 + k * 2).rotation.y = 0.03 * k - 0.04;
  place(new THREE.Mesh(new THREE.BoxGeometry(56, 1.2, 56), mat(0xe2c84a, 0.95)), 96, 9, 60)
    .rotation.y = -0.4;
  place(new THREE.Mesh(new THREE.BoxGeometry(52, 1.2, 52), mat(0xa8d67a, 0.95)), 52, 9, -20)
    .rotation.y = 0.25;

  /* 노트북 — 본체 + 기울어진 화면 */
  place(new THREE.Mesh(new THREE.BoxGeometry(320, 14, 224), mat(0x767d89, 0.4, 0.6)), -236, 7, 300);
  place(new THREE.Mesh(new THREE.BoxGeometry(300, 10, 180), mat(0x2b3138, 0.6)), -236, 15, 312);
  {
    const lid = place(new THREE.Mesh(new THREE.BoxGeometry(320, 200, 12), mat(0x767d89, 0.4, 0.6)),
      -236, 106, 196);
    lid.rotation.x = -0.22;
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(296, 180),
      new THREE.MeshBasicMaterial({ color: 0x16283a }));
    scr.position.set(-236, 108, 203); scr.rotation.x = -0.22;
    world.add(scr);
  }

  /* 화분 + 잎 */
  place(new THREE.Mesh(new THREE.CylinderGeometry(58, 44, 96, 20), mat(0x9c6247, 0.85)), 820, 48, -330);
  place(new THREE.Mesh(new THREE.TorusGeometry(56, 7, 8, 22), mat(0x8a553c, 0.85)), 820, 94, -330)
    .rotation.x = Math.PI / 2;
  for (const [dx, dy, dz, r, tilt] of [
    [0, 150, 0, 46, 0], [-42, 120, 22, 36, 0.5], [40, 128, -20, 38, -0.45],
    [18, 165, 30, 30, 0.3], [-28, 172, -26, 28, -0.3],
  ]) {
    const leaf = place(new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), mat(0x3f6b48, 0.9)),
      820 + dx, dy, -330 + dz);
    leaf.scale.set(1, 0.55, 0.7); leaf.rotation.z = tilt;
  }

  /* 물병 */
  place(new THREE.Mesh(new THREE.CylinderGeometry(33, 30, 190, 22),
    mat(0x9fc4dc, 0.1, 0.0, { transparent: true, opacity: 0.55 })), -560, 95, -40);
  place(new THREE.Mesh(new THREE.CylinderGeometry(24, 22, 116, 22), mat(0x4f8fc4, 0.2)), -560, 60, -40);
  place(new THREE.Mesh(new THREE.CylinderGeometry(20, 24, 34, 18), mat(0x2f6ba0, 0.6)), -560, 207, -40);

  /* 휴대폰 · 외장 하드 */
  place(new THREE.Mesh(new THREE.BoxGeometry(72, 8, 148), mat(0x15181d, 0.35, 0.4)), 470, 4, 150);
  place(new THREE.Mesh(new THREE.PlaneGeometry(62, 134),
    new THREE.MeshBasicMaterial({ color: 0x1b2733 })), 470, 8.5, 150, false).rotation.x = -Math.PI / 2;
  place(new THREE.Mesh(new THREE.BoxGeometry(110, 18, 76), mat(0x2e353f, 0.5, 0.5)), 700, 9, 120);

  /* 머리 위 선반 — 상하 비행의 무대 */
  place(new THREE.Mesh(new THREE.BoxGeometry(600, 22, 220), mat(0x5a4632, 0.88)), 700, 430, -300);
  place(new THREE.Mesh(new THREE.BoxGeometry(22, 430, 200), mat(0x5a4632, 0.88)), 408, 215, -300);
  place(new THREE.Mesh(new THREE.BoxGeometry(22, 430, 200), mat(0x5a4632, 0.88)), 992, 215, -300);
  place(new THREE.Mesh(new THREE.BoxGeometry(140, 72, 176), mat(0x6b4a52, 0.9)), 560, 478, -300);
  place(new THREE.Mesh(new THREE.BoxGeometry(112, 58, 150), mat(0xd8cfbb, 0.95)), 570, 478, -300);
  place(new THREE.Mesh(new THREE.BoxGeometry(160, 52, 160), mat(0x4a5a6b, 0.9)), 850, 468, -300);

  /* 스피커 한 쌍 */
  for (const sx of [-1, 1]) {
    place(new THREE.Mesh(new THREE.CylinderGeometry(38, 41, 186, 20), mat(0x2a3038, 0.75)),
      sx * 470, 93, -330);
    place(new THREE.Mesh(new THREE.CircleGeometry(27, 20), mat(0x14181e, 0.6)), sx * 470, 120, -292, false);
    place(new THREE.Mesh(new THREE.CircleGeometry(13, 16), mat(0x14181e, 0.6)), sx * 470, 56, -292, false);
  }

  /* 팜레스트 · 스테이플러 · 정리함 · 머그2 · 세운 책 · USB 허브 */
  place(new THREE.Mesh(new THREE.BoxGeometry(440, 16, 92), mat(0x3a3f48, 0.85)), 0, 8, 20);
  place(new THREE.Mesh(new THREE.BoxGeometry(56, 28, 140), mat(0x8c3a3a, 0.6)), -40, 14, 150);
  place(new THREE.Mesh(new THREE.BoxGeometry(46, 12, 128), mat(0x9aa2ae, 0.4, 0.7)), -40, 30, 150);
  place(new THREE.Mesh(new THREE.BoxGeometry(140, 84, 184), mat(0x3a424e, 0.8)), 772, 42, 96);
  place(new THREE.Mesh(new THREE.BoxGeometry(112, 58, 156), mat(0x1a1f26, 0.9)), 772, 56, 96);
  place(new THREE.Mesh(new THREE.CylinderGeometry(42, 38, 88, 22), mat(0x4a6b7d, 0.75)), -620, 44, 256);
  place(new THREE.Mesh(new THREE.TorusGeometry(24, 6, 8, 16, Math.PI * 1.25), mat(0x4a6b7d, 0.75)),
    -659, 48, 256).rotation.set(0, Math.PI / 2, -0.35);
  place(new THREE.Mesh(new THREE.BoxGeometry(36, 184, 244), mat(0x7a5f3a, 0.9)), -900, 92, 330);
  place(new THREE.Mesh(new THREE.BoxGeometry(20, 156, 212), mat(0xd8cfbb, 0.95)), -894, 92, 330);
  place(new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 24, 16), mat(0x22272e, 0.6, 0.4)), 588, 12, 74);

  /* 모니터 케이블 */
  {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(60, 120, -392), new THREE.Vector3(180, 40, -430),
      new THREE.Vector3(430, 12, -462), new THREE.Vector3(800, 6, -488),
    ]);
    world.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 5, 8), mat(0x15181d, 0.9)));
  }

  /* ── 파리 ─────────────────────────────────────────────────
     몸 좌표계: 전진 = -Z, 위 = +Y. 머리가 -Z 쪽. */
  function buildFly(style) {
  const flyMesh = new THREE.Group();
  const wings = [];
  {
    const chitin = mat(0x6b5232, 0.62);
    const dark   = mat(0x241a10, 0.7);
    const eyeMat = mat(0x9e2417, 0.35);

    const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.92, 18, 14), chitin);
    thorax.scale.set(0.92, 0.88, 1.15);
    thorax.castShadow = true;
    flyMesh.add(thorax);

    // 배 — 뒤로 갈수록 가늘어지는 마디. 어두운 띠가 초파리의 특징.
    for (let k = 0; k < 4; k++) {
      const r = 0.86 - k * 0.15;
      const seg = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12),
        k % 2 ? dark : mat(0x7d5f3a, 0.66));
      seg.position.z = 0.85 + k * 0.52;
      seg.scale.set(1, 0.86, 1.05);
      seg.castShadow = true;
      flyMesh.add(seg);
    }

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.52, 16, 12), chitin);
    head.position.z = -1.0; head.castShadow = true;
    flyMesh.add(head);
    for (const sx of [-1, 1]) {       // 붉은 겹눈 — 이 시뮬레이터의 주인공
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), eyeMat);
      eye.position.set(sx * 0.36, 0.06, -1.06);
      eye.scale.set(0.9, 1.05, 0.95);
      flyMesh.add(eye);
      const ant = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.2, 4, 6), dark);
      ant.position.set(sx * 0.16, -0.2, -1.42);
      ant.rotation.x = 0.7;
      flyMesh.add(ant);
    }

    // 다리 6개 — 넓적다리 + 종아리
    for (const sx of [-1, 1])
      for (const [zi, spread, back] of [[-0.45, 0.75, -0.5], [0.15, 0.95, 0.1], [0.7, 0.85, 0.85]]) {
        const leg = new THREE.Group();
        const femur = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.75, 4, 6), dark);
        femur.position.set(sx * 0.42, -0.5, 0);
        femur.rotation.z = sx * 0.85;
        const tibia = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.85, 4, 6), dark);
        tibia.position.set(sx * 0.86, -1.0, back * 0.35);
        tibia.rotation.set(back * 0.5, 0, sx * 0.25);
        leg.add(femur, tibia);
        leg.position.set(sx * spread * 0.35, -0.35, zi);
        flyMesh.add(leg);
      }

    // 날개 — 실제 초파리 날개 윤곽 (뿌리에서 뒤로 길게, 끝이 둥글다)
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(1.1, 0.62, 2.85, 0.34);
    shape.quadraticCurveTo(3.45, 0.06, 2.85, -0.22);
    shape.quadraticCurveTo(1.1, -0.5, 0, 0);
    const wingGeo = new THREE.ShapeGeometry(shape, 18);
    const wingMat = new THREE.MeshStandardMaterial({
      color: 0xd6e4f2, roughness: 0.15, metalness: 0.1,
      transparent: true, opacity: 0.26, side: THREE.DoubleSide,
      depthWrite: false,
    });
    // 날개맥
    const veinGeo = new THREE.BufferGeometry();
    {
      const v = [];
      for (const [y0, y1] of [[0.18, 0.2], [0.02, 0.08], [-0.12, -0.04], [-0.26, -0.14]])
        for (let k = 0; k < 14; k++) {
          const t0 = k / 14, t1 = (k + 1) / 14;
          v.push(t0 * 2.8, y0 + (y1 - y0) * t0, 0.01, t1 * 2.8, y0 + (y1 - y0) * t1, 0.01);
        }
      veinGeo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    }
    const veinMat = new THREE.LineBasicMaterial(
      { color: 0x8fa6bd, transparent: true, opacity: 0.45 });

    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group();               // 날개 뿌리 = 회전축
      pivot.position.set(sx * 0.42, 0.62, -0.15);
      const wing = new THREE.Mesh(wingGeo, wingMat);
      wing.add(new THREE.LineSegments(veinGeo, veinMat));
      wing.rotation.y = sx > 0 ? 0 : Math.PI;        // 뒤쪽으로 뻗게
      pivot.add(wing);
      // 스트로크 잔상 — 빠를수록 뚜렷해진다 (실제 200Hz 는 60fps 로 못 그린다)
      const blur = new THREE.Mesh(
        new THREE.CircleGeometry(2.9, 20, -0.75, 1.5),
        new THREE.MeshBasicMaterial({ color: 0xbcd2e8, transparent: true,
          opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      blur.rotation.set(0, sx > 0 ? 0 : Math.PI, 0);
      pivot.add(blur);
      flyMesh.add(pivot);
      wings.push({ pivot, blur, sx });
    }

    // 평형곤 — 날개 뒤의 작은 곤봉. 파리목의 상징.
    for (const sx of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.28, 4, 6), mat(0xb8a06a, 0.7));
      h.position.set(sx * 0.5, 0.18, 0.75);
      h.rotation.z = sx * 0.5;
      flyMesh.add(h);
    }

    // 실제 몸길이 약 3mm 로는 화면에서 보이지 않으므로 표시용으로만 키운다
    flyMesh.scale.setScalar(9);
  }
  world.add(flyMesh);

  // 이름표 — 스프라이트라 늘 카메라를 향한다. 책상 장면에만 넣으므로
  // 가위질(scissor)된 왼쪽 뷰포트 밖으로는 새지 않는다.
  const tagCv = document.createElement('canvas');
  tagCv.width = 256; tagCv.height = 72;
  {
    const t = tagCv.getContext('2d');
    t.fillStyle = 'rgba(10,12,17,0.74)';
    t.fillRect(0, 0, 256, 72);
    t.strokeStyle = style.color; t.lineWidth = 5;
    t.strokeRect(2.5, 2.5, 251, 67);
    t.fillStyle = style.color;
    t.font = '600 40px ui-monospace, Menlo, monospace';
    t.textAlign = 'center'; t.textBaseline = 'middle';
    t.fillText(style.name, 128, 39);
  }
  const tagTex = new THREE.CanvasTexture(tagCv);
  tagTex.colorSpace = THREE.SRGBColorSpace;
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tagTex, transparent: true,
    // 책상 물건 뒤로 숨는 이름표는 이름표 구실을 못 한다 — 늘 위에 그린다
    depthTest: false, depthWrite: false,
  }));
  tag.scale.set(64, 18, 1);
  tag.renderOrder = 10;
  world.add(tag);

  // 비행 궤적 — 파리 색으로
  const TRAIL = 200;
  const trailPos = new Float32Array(TRAIL * 3);
  const trail = new THREE.Line(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(trailPos, 3)),
    new THREE.LineBasicMaterial({ color: style.color, transparent: true, opacity: 0.45 }));
  trail.frustumCulled = false;
  world.add(trail);

  return { flyMesh, wings, tag, trail, trailPos, TRAIL, n: 0 };
  }
  const rigs = FLY_STYLE.map(buildFly);

  // 날갯짓 — 실제 약 200Hz. 60fps 에서 그대로 그리면 에일리어싱으로
  // 오히려 멈춘 것처럼 보이므로, 보이는 속도로 늦추고 잔상으로 속도를 표현한다.
  const _roll = new THREE.Quaternion(), _zAxis = new THREE.Vector3(0, 0, 1);
  function flapWings(F, rig, dt, speedNorm) {
    if (F.perchT > 0) {                       // 앉아 있으면 날개를 접는다
      for (const w of rig.wings) {
        w.pivot.rotation.set(0, 0, w.sx * 0.1);
        w.blur.material.opacity = 0;
      }
      return;
    }
    F.wingPhase += dt * (9 + 7 * speedNorm) * Math.PI * 2;
    const amp = 0.55 + 0.55 * speedNorm;
    const sweep = Math.sin(F.wingPhase);
    for (const w of rig.wings) {
      w.pivot.rotation.z = w.sx * (0.25 + amp * sweep);
      w.pivot.rotation.x = 0.28 * sweep * amp;
      w.pivot.rotation.y = w.sx * 0.18 * Math.cos(F.wingPhase) * amp;
      w.blur.material.opacity = 0.05 + 0.16 * speedNorm;
    }
    // 날갯짓에 맞춰 몸이 아주 살짝 흔들린다.
    // .rotation.z 로 주면 안 된다 — three.js 는 오일러 세 축(XYZ) 전체에서
    // 쿼터니언을 다시 만드는데, 진행방향이 뒤쪽 반구(요 90°~270°)면 순수 요
    // 회전이 (x=180°, y=180°−요, z=180°) 로 분해된다. 그 z 를 덮어쓰는 순간
    // x=180° 만 남아 파리가 뒤집힌 채 난다. 몸 축 롤은 쿼터니언에 직접 곱한다.
    rig.flyMesh.quaternion.multiply(
      _roll.setFromAxisAngle(_zAxis, 0.035 * Math.sin(F.wingPhase * 0.5) * speedNorm));
  }


  const worldCam = new THREE.PerspectiveCamera(42, 1, 30, 6000);
  worldCam.position.set(760, 800, 1260);
  const worldCtl = new OrbitControls(worldCam, renderer.domElement);
  worldCtl.target.set(0, 140, 0);
  worldCtl.enableDamping = true;
  worldCtl.dampingFactor = 0.08;
  worldCtl.maxPolarAngle = Math.PI * 0.49;
  worldCtl.minDistance = 90;      // near(30mm) 보다 가까이 붙지 못하게
  worldCtl.maxDistance = 4200;

  /* 뉴런 장면 */
  const brain = new THREE.Scene();
  const brainRoot = new THREE.Group();
  brain.add(brainRoot);
  const GROUP_COLOR = { LPTC: css('--lptc'), LOOM: css('--loom'), DN: css('--dn') };

  // 세포마다 LineSegments 를 만들면 draw call 이 세포 수만큼 나온다.
  // 전부 하나의 지오메트리로 합치고, 세포별 활성은 작은 텍스처로 넘겨
  // draw call 1개로 그린다 — 내장 GPU 에서 체감 차이가 크다.
  const nCells = cells.length;
  let nVert = 0, nIdx = 0;
  for (const c of cells) { nVert += c.p.length / 3; nIdx += c.e.length; }

  const positions = new Float32Array(nVert * 3);
  const cellAttr  = new Float32Array(nVert);
  const indices   = new Uint32Array(nIdx);
  let vo = 0, io = 0;
  for (let ci = 0; ci < nCells; ci++) {
    const c = cells[ci];
    positions.set(c.p, vo * 3);
    cellAttr.fill(ci, vo, vo + c.p.length / 3);
    for (let k = 0; k < c.e.length; k++) indices[io + k] = c.e[k] + vo;
    vo += c.p.length / 3;
    io += c.e.length;
    c.base = new THREE.Color(GROUP_COLOR[c.group]);
  }

  // RGBA 픽셀 1개 = 세포 1개.  RGB = 기본색(고정), A = 활성(매 프레임 갱신)
  // 파리마다 자기 활성 텍스처를 갖는다 — 지오메트리는 셋이 공유한다
  for (const F of flies) {
    F.cellData = new Float32Array(nCells * 4);
    for (let ci = 0; ci < nCells; ci++) {
      const b = cells[ci].base;
      F.cellData[ci*4] = b.r; F.cellData[ci*4+1] = b.g; F.cellData[ci*4+2] = b.b;
    }
    F.cellTex = new THREE.DataTexture(F.cellData, nCells, 1, THREE.RGBAFormat, THREE.FloatType);
    F.cellTex.minFilter = F.cellTex.magFilter = THREE.NearestFilter;
    F.cellTex.needsUpdate = true;
  }

  const brainGeo = new THREE.BufferGeometry();
  brainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  brainGeo.setAttribute('aCell', new THREE.BufferAttribute(cellAttr, 1));
  brainGeo.setIndex(new THREE.BufferAttribute(indices, 1));

  const brainMat = new THREE.ShaderMaterial({
    uniforms: { uCells: { value: flies[0].cellTex }, uCount: { value: nCells },
               uGain: { value: 1.0 } },
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: `
      attribute float aCell;
      uniform sampler2D uCells;
      uniform float uCount;
      varying vec4 vCell;
      void main() {
        vCell = texture2D(uCells, vec2((aCell + 0.5) / uCount, 0.5));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      precision mediump float;
      uniform float uGain;
      varying vec4 vCell;
      void main() {
        float a = vCell.a;
        vec3 c = mix(vCell.rgb, vec3(1.0), min(0.75, a * 0.8));
        gl_FragColor = vec4(c * uGain, (0.055 + a * 0.9) * uGain);
      }`,
  });
  const brainMesh = new THREE.LineSegments(brainGeo, brainMat);
  brainMesh.frustumCulled = false;
  brainRoot.add(brainMesh);
  // 뷰포트 셋이 카메라 하나를 공유하면 한 단을 돌릴 때 셋이 같이 돈다.
  // 파리마다 자기 카메라와 자기 조작기를 준다.
  const brainCams = flies.map(() => new THREE.PerspectiveCamera(40, 1, 1, 20000));
  const brainCtls = brainCams.map(cam => {
    const c = new OrbitControls(cam, renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.enabled = false;              // 포인터가 내려온 단만 켠다
    return c;
  });
  {
    const box = new THREE.Box3().setFromObject(brainRoot);
    const size = box.getSize(new THREE.Vector3());
    const span = [size.x, size.y, size.z];
    const longest = span.indexOf(Math.max(...span));
    const up = new THREE.Vector3().setComponent(longest, 1);
    brainRoot.quaternion.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
    const ctr = box.getCenter(new THREE.Vector3());
    brainRoot.position.copy(ctr).applyQuaternion(brainRoot.quaternion).negate();
    const r = box.getBoundingSphere(new THREE.Sphere()).radius;
    for (let k = 0; k < brainCams.length; k++) {
      brainCams[k].position.set(r * 0.2, r * 0.35, r * 2.0);
      brainCtls[k].minDistance = r * 0.4;
      brainCtls[k].maxDistance = r * 5;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     6. UI
     ══════════════════════════════════════════════════════════════ */
  // 왼쪽: 파리마다 회로 활성 카드 하나
  const STAGES = [
    { id: 'lptc', label: '자세<br>HS/VS',  color: '--lptc', list: LPTC },
    { id: 'loom', label: '루밍<br>LPLC2',  color: '--loom', list: LOOM },
    { id: 'dn',   label: '하행<br>DN',      color: '--dn',   list: DN },
  ];
  const cardBox = document.getElementById('flyCards');
  const cards = flies.map(F => {
    const el = document.createElement('div');
    el.className = 'flyCard';
    el.style.setProperty('--fc', F.color);
    el.innerHTML = `<div class="head"><b>${F.name}</b><span class="st"></span></div>` +
      STAGES.map(st => `<div class="mrow"><span class="lbl">${st.label}</span>` +
        `<span class="meter" style="--c:var(${st.color})"><i></i><span>0</span></span></div>`).join('');
    cardBox.appendChild(el);
    return {
      stat: el.querySelector('.st'),
      bars: [...el.querySelectorAll('.meter')].map(m => ({
        bar: m.querySelector('i'), val: m.querySelector('span') })),
    };
  });

  const SCRAMBLES = [
    ['none', '정상 (커넥톰 그대로)'],
    ['halfmirror', '절반이 반대 눈을 봄'],
    ['rf', '수용장 뒤섞기'],
    ['rewire', '하행뉴런 무작위 재배선'],
  ];
  const scrambleBox = document.getElementById('scrambles');
  const scrambleBtns = SCRAMBLES.map(([mode, label]) => {
    const b = document.createElement('button');
    b.className = 'ctl'; b.type = 'button';
    if (mode !== 'none') b.dataset.danger = '1';
    b.setAttribute('aria-pressed', String(mode === 'none'));
    b.innerHTML = `<span>${label}</span><span class="sw">${mode === 'none' ? '적용' : '끔'}</span>`;
    b.onclick = () => {
      setScramble(mode);
      scrambleBtns.forEach(([bb, mm]) => {
        const on = mm === mode;
        bb.setAttribute('aria-pressed', String(on));
        bb.querySelector('.sw').textContent = on ? '적용' : '끔';
      });
      for (const F of flies) F.hits = 0;
      document.getElementById('lesionNote').textContent = mode === 'none'
        ? '회로를 끄면 파리는 직진만 하다 부딪칩니다.'
        : '커넥톰 값만 망가뜨렸습니다 — 세포 수와 총 시냅스량은 그대로입니다.';
    };
    scrambleBox.appendChild(b);
    return [b, mode];
  });

  const TOGGLES = [
    { key: 'circuit', label: '조향 회로', danger: false },
    { key: 'loom',    label: '루밍 검출 (LPLC2/LC4)', danger: true },
    { key: 'lptc',    label: '자세 회로 (HS/VS)',     danger: true },
  ];
  const toggles = document.getElementById('toggles');
  for (const t of TOGGLES) {
    const b = document.createElement('button');
    b.className = 'ctl'; b.type = 'button';
    if (t.danger) b.dataset.danger = '1';
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<span>${t.label}</span><span class="sw">정상</span>`;
    b.onclick = () => {
      lesion[t.key] = !lesion[t.key];
      const off = !lesion[t.key];
      b.setAttribute('aria-pressed', String(off));
      b.querySelector('.sw').textContent = off ? '차단' : '정상';
      document.getElementById('lesionNote').textContent = off
        ? `${t.label} 차단됨 — 충돌이 늘어나는지 보세요.`
        : '회로를 끄면 파리는 직진만 하다 부딪칩니다.';
      for (const F of flies) F.hits = 0;
    };
    toggles.appendChild(b);
  }
  // 스페이스바를 누른 동안 드래그가 회전 대신 '중심 이동'이 된다.
  // 포인터가 있는 쪽(책상/뉴런)의 중심만 움직인다.
  let panning = false;
  const setPan = on => {
    if (panning === on) return;
    panning = on;
    const btn = on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    worldCtl.mouseButtons.LEFT = btn;
    for (const c of brainCtls) c.mouseButtons.LEFT = btn;
    worldCtl.touches.ONE = on ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    for (const c of brainCtls) c.touches.ONE = on ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    renderer.domElement.style.cursor = on ? 'grab' : '';
  };
  addEventListener('keydown', e => {
    if (e.key === ' ' && !e.repeat) { e.preventDefault(); setPan(true); }
    else if (e.key === 'p' || e.key === 'P') paused = !paused;
    else if (e.key === 'r' || e.key === 'R') {        // 중심 복귀
      worldCtl.target.set(0, 140, 0);
      for (const c of brainCtls) c.target.set(0, 0, 0);
    }
  });
  addEventListener('keyup', e => { if (e.key === ' ') { e.preventDefault(); setPan(false); } });
  addEventListener('blur', () => setPan(false));      // 창을 벗어나도 눌림이 남지 않게

  // 밝기: 톤매핑 노출 + 뉴런 패널 게인 + 배경을 한 손잡이로 묶는다
  const bgWorld = new THREE.Color(), bgBrain = new THREE.Color();
  const exposure = document.getElementById('exposure');
  const exposureVal = document.getElementById('exposureVal');
  function setBrightness(v) {
    renderer.toneMappingExposure = v;
    brainMat.uniforms.uGain.value = 0.55 + v * 0.45;
    // 배경도 함께 들어올려 어두운 화면에서 형태가 묻히지 않게 한다
    bgWorld.setHex(0x0a0c11).lerp(new THREE.Color(0x1d2430), Math.max(0, (v - 1) * 0.55));
    bgBrain.setHex(0x07080c).lerp(new THREE.Color(0x171d28), Math.max(0, (v - 1) * 0.55));
    exposureVal.textContent = v.toFixed(2);
    try { localStorage.setItem('flyExposure', String(v)); } catch {}
  }
  try {
    const saved = parseFloat(localStorage.getItem('flyExposure'));
    if (saved >= 0.5 && saved <= 2.6) exposure.value = String(saved);
  } catch {}
  exposure.addEventListener('input', () => setBrightness(parseFloat(exposure.value)));
  setBrightness(parseFloat(exposure.value));

  // 오른쪽: 뉴런 지도 위에 파리 라벨과 그 파리의 겹눈 시야
  const overlayBox = document.getElementById('flyOverlays');
  const bands = flies.map(F => {
    const el = document.createElement('div');
    el.className = 'flyBand';
    el.style.setProperty('--fc', F.color);
    el.innerHTML = `<span class="tag"><span class="dot"></span>${F.name}</span>` +
      `<span class="eyes"><span class="cap">좌</span>` +
      `<canvas width="${G}" height="${G}"></canvas>` +
      `<canvas width="${G}" height="${G}"></canvas>` +
      `<span class="cap">우</span></span>`;
    overlayBox.appendChild(el);
    const [cl, cr] = el.querySelectorAll('canvas');
    return { el, ctx: { L: cl.getContext('2d'), R: cr.getContext('2d') },
             img: { L: cl.getContext('2d').createImageData(G, G),
                    R: cr.getContext('2d').createImageData(G, G) } };
  });

  function paintEye(band, side, loom, depth) {
    const img = band.img[side], d = img.data;
    for (let i = 0; i < NBIN; i++) {
      const near = Math.max(0, 1 - depth[i] / 900);
      const l = Math.min(1, loom[i] / 2.2);
      d[i*4]     = 26 + near * 60 + l * 195;
      d[i*4 + 1] = 30 + near * 52 + l * 40;
      d[i*4 + 2] = 40 + near * 70 + l * 140;
      d[i*4 + 3] = 255;
    }
    band.ctx[side].putImageData(img, 0, 0);
  }

  const statsEl = document.getElementById('stats');
  document.getElementById('ds').textContent = DATA.dataset;

  /* ══════════════════════════════════════════════════════════════
     7. 루프
     ══════════════════════════════════════════════════════════════ */
  // 뉴런 지도는 서랍이다 — 접으면 책상이 화면을 다 쓰고, 경계를 끌면 비율이 바뀐다.
  const NARROW = () => innerWidth < 900;
  const OPEN_DEFAULT = 0.63;          // 펼쳤을 때 책상 뷰가 차지하는 비율
  let openRatio = OPEN_DEFAULT;        // 사용자가 끌어서 정한 비율
  let ratio = 1, target = 1;           // 현재/목표 (1 = 뉴런 지도 접힘)
  let drawerOpen = false;

  try {
    const saved = parseFloat(localStorage.getItem('flySplit'));
    if (saved >= 0.3 && saved <= 0.9) openRatio = saved;
    drawerOpen = localStorage.getItem('flyDrawer') !== 'closed';
  } catch {}
  if (NARROW()) drawerOpen = false;
  target = ratio = drawerOpen ? openRatio : 1;

  const divider = document.getElementById('divider');
  const drawerToggle = document.getElementById('drawerToggle');
  const snap = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setDrawer(open) {
    drawerOpen = open;
    // 좁은 화면에서는 나란히 둘 자리가 없으니 뉴런 지도가 전체를 덮는다
    target = open ? (NARROW() ? 0 : openRatio) : 1;
    if (snap) { ratio = target; view = layout(); }
    drawerToggle.setAttribute('aria-pressed', String(open));
    drawerToggle.querySelector('.sw').textContent = open ? '펼침' : '접힘';
    divider.classList.toggle('closed', !open);
    document.body.classList.toggle('brain-only', open && NARROW());
    try { localStorage.setItem('flyDrawer', open ? 'open' : 'closed'); } catch {}
  }
  drawerToggle.onclick = () => setDrawer(!drawerOpen);
  addEventListener('keydown', e => {
    if (e.key === 'n' || e.key === 'N') setDrawer(!drawerOpen);
  });

  // 경계 끌기 — 접혀 있어도 오른쪽 끝에서 끌어오면 다시 펼쳐진다
  const CLOSE_AT = 0.94;
  divider.addEventListener('pointerdown', e => {
    if (NARROW()) return;
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    const move = ev => {
      ratio = target = Math.min(1, Math.max(0.28, ev.clientX / innerWidth));
      divider.classList.toggle('closed', ratio > CLOSE_AT);
      view = layout();
    };
    const up = () => {
      divider.classList.remove('dragging');
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      if (ratio > CLOSE_AT) setDrawer(false);
      else { openRatio = ratio; setDrawer(true); }
      try { localStorage.setItem('flySplit', String(openRatio)); } catch {}
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });
  divider.addEventListener('dblclick', () => { if (!NARROW()) setDrawer(!drawerOpen); });
  setDrawer(drawerOpen);

  let lastW = 0, lastH = 0;
  function layout() {
    const w = innerWidth, h = innerHeight;
    if (w !== lastW || h !== lastH) {        // 창 크기가 바뀔 때만 재할당
      renderer.setSize(w, h);
      lastW = w; lastH = h;
    }
    const split = Math.round(w * ratio);
    divider.style.left = Math.min(w - 15, split - 7) + 'px';
    return { w, h, split };
  }
  let view = layout();
  addEventListener('resize', () => {
    if (NARROW() && drawerOpen && target > 0 && target < 1) setDrawer(false);
    view = layout();
  });

  // 두 OrbitControls 가 같은 캔버스를 공유하므로, 누른 쪽만 활성화한다
  renderer.domElement.addEventListener('pointerdown', e => {
    const onWorld = e.clientX < view.split;
    worldCtl.enabled = onWorld;
    // 오른쪽이면 포인터가 놓인 단 하나만 켠다 — 그 파리의 지도만 움직인다
    const band = onWorld ? -1
      : Math.min(flies.length - 1, Math.floor(e.clientY / (view.h / flies.length)));
    brainCtls.forEach((c, k) => { c.enabled = k === band; });
  }, true);

  let last = performance.now(), clock = 0, uiTick = 0, screenTick = 0;
  renderer.setAnimationLoop(now => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    let ran = false;
    if (!paused) {
      clock += dt;
      ran = true;
      for (let k = 0; k < flies.length; k++) {
        const F = flies[k], rig = rigs[k];
        step(F, dt, clock);
        rig.flyMesh.position.copy(F.pos);
        rig.flyMesh.quaternion.copy(F.quat);
        rig.tag.position.set(F.pos.x, F.pos.y + 46, F.pos.z);   // 파리 바로 위
        flapWings(F, rig, dt, Math.min(1, F.speed / M.cruise));

        const { trailPos, TRAIL, trail } = rig;
        if (rig.n < TRAIL) {
          trailPos.set([F.pos.x, F.pos.y, F.pos.z], rig.n * 3);
          rig.n++;
          trail.geometry.setDrawRange(0, rig.n);
        } else {
          trailPos.copyWithin(0, 3);
          trailPos.set([F.pos.x, F.pos.y, F.pos.z], (TRAIL - 1) * 3);
        }
        trail.geometry.attributes.position.needsUpdate = true;

        // 활성도를 그 파리의 텍스처 알파 채널에 올린다
        const cd = F.cellData;
        for (let ci = 0; ci < nCells; ci++) cd[ci*4 + 3] = F.act[ci];
        F.cellTex.needsUpdate = true;
      }
    }

    worldCtl.update();
    for (const c of brainCtls) c.update();

    if (Math.abs(ratio - target) > 0.0005) {      // 서랍 여닫기 애니메이션
      ratio += (target - ratio) * Math.min(1, dt * 11);
      view = layout();
    }

    const { w, h, split } = view;
    if (split > 2) {
      renderer.setViewport(0, 0, split, h);
      renderer.setScissor(0, 0, split, h);
      worldCam.aspect = split / h; worldCam.updateProjectionMatrix();
      renderer.setClearColor(bgWorld, 1);
      renderer.render(world, worldCam);
    }

    if (split < w - 2) {
      // 파리마다 한 단씩 — 지오메트리는 공유하고 활성 텍스처만 바꿔 끼운다
      const bw = w - split, bh = h / flies.length;
      overlayBox.style.left = split + 'px';
      overlayBox.style.width = bw + 'px';
      overlayBox.classList.remove('hidden');
      for (let k = 0; k < flies.length; k++) {
        const y = Math.round(h - (k + 1) * bh);
        renderer.setViewport(split, y, bw, Math.round(bh));
        renderer.setScissor(split, y, bw, Math.round(bh));
        renderer.setClearColor(bgBrain, 1);
        brainMat.uniforms.uCells.value = flies[k].cellTex;
        const cam = brainCams[k];
        cam.aspect = bw / bh; cam.updateProjectionMatrix();
        renderer.render(brain, cam);
        bands[k].el.style.top = (k * 100 / flies.length) + '%';
        bands[k].el.style.height = (100 / flies.length) + '%';
      }
    } else {
      overlayBox.classList.add('hidden');
    }

    // UI 는 초당 20회만 갱신
    if (ran && now - uiTick > 50) {
      uiTick = now;
      let totalHits = 0;
      flies.forEach((F, k) => {
        const card = cards[k], band = bands[k];
        STAGES.forEach((st, si) => {
          const v = meanAct(F, st.list);
          card.bars[si].bar.style.width = Math.min(100, v * 260) + '%';
          card.bars[si].val.textContent = v.toFixed(2);
        });
        card.stat.innerHTML = `${F.perchT > 0 ? '앉음' : (F.speed / 10).toFixed(0) + 'cm/s'} · ` +
          `<span class="${F.hits ? 'hit' : ''}">충돌 ${F.hits}</span>`;
        paintEye(band, 'L', F.loomL, F.depthL);
        paintEye(band, 'R', F.loomR, F.depthR);
        totalHits += F.hits;
      });
      if (now - screenTick > 160) {          // 모니터 화면은 초당 6회면 충분하다
        screenTick = now;
        const avg = list => flies.reduce((t, F) => t + meanAct(F, list), 0) / flies.length;
        drawScreen({ lptc: avg(LPTC), loom: avg(LOOM), dn: avg(DN) });
      }
      statsEl.innerHTML =
        `파리 <b>${flies.length}</b>마리 · 뉴런 <b>${cells.length}</b>개 ×${flies.length}<br>` +
        `충돌 합계 <b class="${totalHits ? 'hit' : ''}">${totalHits}</b>회<br>` +
        `<span style="color:var(--ink-faint)">${gpuName}</span><br>` +
        `<span style="color:var(--ink-faint)">드래그 회전 · 스페이스바+드래그 중심 이동</span><br>` +
        `<span style="color:var(--ink-faint)">R 중심 복귀 · P 일시정지${paused ? ' — 정지됨' : ''} · N·경계드래그 뉴런 지도</span>`;
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   8. 자체 검사 — ?selftest 로 실행
   ══════════════════════════════════════════════════════════════ */
function selftest() {
  const out = [];
  const F0 = flies[0];          // 검사는 1번 파리로만 돌린다
  const reset = (x, y, z, yaw) => {
    F0.pos.set(x, y, z);
    F0.quat.setFromAxisAngle(_up, yaw);
    F0.vel.set(0, 0, 0); F0.yawRate = 0; F0.hits = 0; F0.contact = false;
    F0.perchT = 0; F0.flyT = Infinity;      // 검사 도중 앉아버리면 측정이 깨진다
    F0.act.fill(0); F0.input.fill(0);
  };

  // 1) Optomotor 방향성 — 좌회전(+yaw)하면 세상이 오른쪽으로 흘러
  //    우안이 앞→뒤(T4a/T5a) 운동을 보고, 조향은 그것을 되돌리는 쪽이어야 한다
  const hs = LPTC.filter(c => c.type.startsWith('HS'));
  // 실제 실험처럼 파리를 붙들어 두고 회전만 시킨다 (tethered).
  // 병진 운동이 섞이면 양쪽 눈에 같은 흐름이 들어와 차이가 묻힌다.
  const save = { cruise: M.cruise, bob: M.bob, hold: M.hold };
  M.cruise = 0; M.bob = 0; M.hold = 200;
  reset(0, 200, 200, 0);
  let torqueSign = 0;
  for (let i = 0; i < 60; i++) {
    F0.yawRate = 1.5;                       // 회전 속도를 일정하게 유지
    torqueSign = step(F0, 1/60, i/60).torque;
  }
  Object.assign(M, save);
  const hsL = sideSum(F0, hs, 'L'), hsR = sideSum(F0, hs, 'R');
  const dnaLat = STEER.map(d => d.lat.toFixed(2)).join('/');
  out.push(['Optomotor 방향성', hsR > hsL && torqueSign < 0,
    `좌회전 → HS 우 ${hsR.toFixed(3)} > 좌 ${hsL.toFixed(3)}, 보정 토크 ${torqueSign.toFixed(3)} ` +
    `(음수=우회전) · DNa02 편측성 ${dnaLat}`]);

  // 2) 루밍 국소성: 모니터로 직진하면 정면 담당 세포만 켜진다
  reset(0, 295, 120, Math.PI);   // 모니터(-z)를 향해 전진(-z)
  for (let i = 0; i < 90; i++) step(F0, 1/60, i/60);
  const frontal = [], rear = [];
  for (const c of LOOM) {
    if (!c.rf.length) continue;
    const cx = c.rf.reduce((s, [b, w]) => s + (b % G) * w, 0);
    (cx < G * 0.35 ? frontal : cx > G * 0.65 ? rear : []).push(F0.act[c.idx]);
  }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  out.push(['루밍 국소성', mean(frontal) > mean(rear) * 2,
    `정면 담당 ${mean(frontal).toFixed(3)} vs 후방 ${mean(rear).toFixed(3)}`]);

  // 3) 통제된 회피 실험 — 텀블러를 향해 정면 직진시키고 비껴가는지 본다.
  //    자유 비행으로 충돌 수를 비교하면 회로 on/off 가 서로 다른 궤적을 만들어
  //    비교가 성립하지 않는다. 같은 접근 궤적에서 결과만 달라져야 한다.
  // 3) 대조 실험 — "이 뉴런들이 정말 시각 정보를 받아 파리를 모는가"
  //    행동(충돌 여부)은 둔한 지표다. 허공의 기둥 하나는 어느 쪽으로 돌아도 통과한다.
  //    그래서 신호 자체를 잰다: 장애물을 왼쪽/오른쪽에 두고 회로가 방향을 맞히는지.
  const WALL = OBJECTS.find(o => o.name === '선반 다리 L');

  // 벽을 한쪽에 두고 지나가며, 회피 명령의 편측성 적분값을 잰다.
  // offset < 0 이면 벽이 파리의 오른쪽(+z 가 오른쪽), > 0 이면 왼쪽.
  const pass = (mode, offset) => {
    setScramble(mode);
    lesion.circuit = lesion.loom = lesion.lptc = true;
    seesWalls = false;            // 재는 것은 '장애물 하나'가 만드는 좌우 차이다
    const sv = M.wander; M.wander = 0;   // 자발 사카드는 재려는 신호가 아니다
    // 책상 한가운데의 빈 통로를 -z 로 직진하며 기둥 옆을 스쳐간다. 경계 토크가
    // 걸리는 구간(|x|>920, |z|>420)과 벽에서 멀찍이 떨어뜨려, 재는 것이 오직
    // 기둥 하나의 좌우 위치가 되게 한다.
    reset(WALL.p[0] + offset, 150, 280, 0);
    let sum = 0;
    for (let i = 0; i < 120; i++) { step(F0, 1/60, i / 60); sum += lateral(F0, ESCAPE); }
    M.wander = sv; seesWalls = true;
    return sum / 120;
  };
  // 왼쪽에 벽 -> 오른쪽으로 틀어야 하므로 음수, 오른쪽에 벽 -> 양수가 나와야 한다.
  const probe = mode => {
    const left = pass(mode, 210), right = pass(mode, -210);
    return { left, right, sep: right - left };
  };

  const P = {
    정상:        probe('none'),
    편측성절반깨기: probe('halfmirror'),
    수용장뒤섞기: probe('rf'),
    무작위재배선:  probe('rewire'),
  };
  setScramble('none');
  lesion.circuit = lesion.loom = lesion.lptc = true;
  reset(-250, M.hold, 240, 0.6);

  const base = P.정상.sep;
  // 커넥톰이 공간 정보를 나른다면, 교란한 조건은 분리도가 무너지거나 뒤집혀야 한다
  const lost = ['편측성절반깨기', '수용장뒤섞기', '무작위재배선']
    .filter(k => P[k].sep < base * 0.5);
  out.push(['대조 실험 — 커넥톰 교란', base > 0 && lost.length >= 2,
    Object.entries(P).map(([k, r]) =>
      `${k} 좌${r.left.toFixed(3)} 우${r.right.toFixed(3)} 분리${r.sep.toFixed(3)}`
    ).join(' | ') + ` → ${lost.length}/3 붕괴 (${lost.join(',') || '없음'})`]);

  // 5) 보이지 않는 벽 — 파리가 벽을 눈으로 보는가.
  //    벽을 castRay 에서 빼면 그 앞은 빈 공간이라 루밍이 0 이 되고, 파리는
  //    벽에 닿아서야 위치가 잘려 그대로 벽에 붙어 미끄러진다. 그래서 두 가지를
  //    같이 본다: 접근 중 루밍이 오르는가, 그리고 벽에 붙지 않는가.
  setScramble('none');
  lesion.circuit = lesion.loom = lesion.lptc = true;
  reset(BOUND.x - 700, 120, 0, -Math.PI / 2);      // +x 벽을 향해 정면 직진
  let wallPeak = 0, wallMaxX = -Infinity;
  for (let i = 0; i < 240; i++) {
    step(F0, 1/60, i / 60);
    wallPeak = Math.max(wallPeak, meanAct(F0, LOOM));
    wallMaxX = Math.max(wallMaxX, F0.pos.x);
  }
  out.push(['보이지 않는 벽 인지', wallPeak > 0.015 && wallMaxX < BOUND.x - 20,
    `접근 중 루밍 최대 ${wallPeak.toFixed(3)} · 최대 도달 x ${wallMaxX.toFixed(0)} (벽 ${BOUND.x})`]);
  reset(-250, M.hold, 240, 0.6);

  // 6) 보이지 않는 천장 — 벽과 같은 방식으로 검사한다. hold/bob 을 밀어붙여
  //    천장 쪽으로 계속 오르게 하고, 다가갈수록 루밍이 오르는지·실제로 뚫고
  //    나가지는 않는지를 본다.
  {
    const save = { hold: M.hold, bob: M.bob };
    M.hold = BOUND.y + 200; M.bob = 0;      // 천장 훨씬 위를 목표로 계속 오르게 한다
    reset(0, BOUND.y - 300, 0, 0);
    let ceilPeak = 0, ceilMaxY = -Infinity;
    for (let i = 0; i < 240; i++) {
      step(F0, 1/60, i / 60);
      ceilPeak = Math.max(ceilPeak, meanAct(F0, LOOM_HIGH));
      ceilMaxY = Math.max(ceilMaxY, F0.pos.y);
    }
    Object.assign(M, save);
    out.push(['보이지 않는 천장 인지', ceilPeak > 0.01 && ceilMaxY < BOUND.y - 5,
      `접근 중 위쪽 루밍 최대 ${ceilPeak.toFixed(3)} · 최대 도달 y ${ceilMaxY.toFixed(0)} (천장 ${BOUND.y})`]);
    reset(-250, M.hold, 240, 0.6);
  }

  // 6b) 모니터 위 착지 — 파리가 모니터 꼭대기(470mm)에도 앉을 수 있는가.
  //     모니터는 x[-300,300] z[-406,-384] 의 얇은 판이라, 그 아래를 나는 높이대로는
  //     '장애물'로만 마주치고 위에 있을 일이 없다. 순항 고도가 470mm 위까지 닿아야
  //     비로소 착지 후보가 된다.
  {
    // 착지 기제 자체는 발밑에 물건만 있으면 항상 통한다(위 착지와 휴식 검사가
    // 이미 증명한다) — 관건은 평소 오르내림 진폭이 모니터 윗면(470mm)까지
    // 닿느냐다. 장애물 없는 하늘에서 순항 고도의 정점만 재본다.
    reset(700, M.hold, 300, 0);        // 책상 가운데, 머리 위가 트인 자리
    F0.flyT = Infinity;                // 착지 기제와 섞이지 않게, 순수 오르내림만 본다
    let peakY = -Infinity;
    for (let i = 1; i <= 3600; i++) { step(F0, 1/60, i / 60); peakY = Math.max(peakY, F0.pos.y); }
    out.push(['모니터 위 착지', peakY > 470 + M.perchH,
      `60초 동안 최고 고도 ${peakY.toFixed(0)}mm (모니터 윗면 470 + 다리 ${M.perchH} = ${470 + M.perchH})`]);
    reset(-250, M.hold, 240, 0.6);
  }

  // 7) 착지 — 앉을 자리가 발밑에 있으면 실제로 내려앉는가.
  //    실시간으로 확인하려면 15~25초를 기다려야 하므로, 타이머만 0 으로 두고
  //    나머지는 그대로 돌린다.
  reset(0, 150, -95, 0.9);          // 키보드(윗면 26mm) 위에서 시작
  F0.flyT = 0;                      // 곧바로 앉을 자리를 찾는 상태로
  let landAt = 0, landY = 0, landSpeed = 0;
  for (let i = 1; i <= 900 && !landAt; i++) {
    step(F0, 1/60, i / 60);
    if (F0.perchT > 0) { landAt = i; landY = F0.pos.y; landSpeed = F0.speed; }
  }
  // 앉은 자리는 물건 윗면이어야 한다 — 책상 바닥(0)도, 물건 속도 아니다.
  const landTop = landAt ? perchUnder(F0.pos.x, F0.pos.z, F0.pos.y + 1e3) : null;
  out.push(['착지와 휴식', landAt > 0 && landSpeed === 0 && landTop !== null,
    landAt ? `${(landAt / 60).toFixed(1)}초 만에 높이 ${landY.toFixed(0)}mm 에 앉음 ` +
             `(발밑 윗면 ${landTop === null ? '없음' : landTop.toFixed(0)}mm, 속도 ${landSpeed})`
           : '15초 동안 앉지 못함']);
  reset(-250, M.hold, 240, 0.6);

  // 4) 모니터 시야 — 화면 앞 통로가 비어 있어야 모니터가 보인다.
  //    장애물을 옮기다 통로를 다시 막으면 여기서 실패로 드러난다.
  const LANE = { x: 380, z: [-520, -170] };
  const OWN = ['모니터 패널', '모니터 목', '모니터 받침'];
  const blockers = OBJECTS.filter(o => {
    if (OWN.includes(o.name)) return false;
    const hx = o.k === 'box' ? o.h[0] : o.r, hz = o.k === 'box' ? o.h[2] : o.r;
    return Math.abs(o.p[0]) - hx < LANE.x &&
           o.p[2] + hz > LANE.z[0] && o.p[2] - hz < LANE.z[1];
  });
  out.push(['모니터 시야 확보', blockers.length === 0,
    blockers.length ? blockers.map(o => o.name).join(', ') + ' 가 통로를 막음'
                    : `통로 x±${LANE.x} z${LANE.z[0]}~${LANE.z[1]} 비어 있음`]);

  console.log('%c자체 검사', 'font-weight:bold');
  for (const [name, ok, detail] of out)
    console.log(`  ${ok ? '통과' : '실패'}  ${name} — ${detail}`);
  // 헤드리스에서 읽을 수 있도록 제목에도 싣는다
  document.title = 'SELFTEST ' + out.map(([n, ok, d]) =>
    `${ok ? 'PASS' : 'FAIL'}[${n}: ${d}]`).join(' ');
  document.getElementById('masthead').insertAdjacentHTML('beforeend',
    `<p style="font-family:var(--mono);font-size:10px;line-height:1.7;margin:9px 0 0">` +
    out.map(([n, ok, d]) =>
      `<span style="color:${ok ? 'var(--lptc)' : 'var(--dn)'}">${ok ? '통과' : '실패'}</span> ${n}<br>` +
      `<span style="color:var(--ink-faint)">${d}</span>`).join('<br>') + `</p>`);
}
if (location.search.includes('selftest')) selftest();
if (!HEADLESS) boot();

document.getElementById('boot').classList.add('done');
