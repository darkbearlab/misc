/**
 * §11 驗收條件 2 ~ 7（條件 1 決定性另見 determinism.test.ts）。SPEC v1.1。
 *
 *   2. 無爆飛：500 組隨機合法投擲，不得出現 y > 0.5 或速度觸及 clamp 上限
 *   3. 翻覆可觸發
 *   4. 出界可觸發
 *   5. 效能：500 場模擬於 30 秒內完成
 *   6. 無渲染碼
 *   7. ESLint 通過（由 `npm run lint` 驗證，此處驗證原始碼層面的禁令）
 *
 * 另含 v1.1 新幾何的結構性驗證：質量屬性由幾何衍生、懸吊三模態穩定、圍欄無縫隙。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DT,
  FIELD_HALF_SEGMENT,
  FIELD_RADIUS,
  MAX_ANGULAR_SPEED,
  MAX_LINEAR_SPEED,
  SUSPENSION_DAMPING,
  SUSPENSION_RAY_LENGTH,
  THROW_LIMITS,
  THROW_MAX_STADIUM_DISTANCE,
  TOTAL_MASS,
  TRACK_WIDTH,
  VEHICLE_LOWEST_Y,
  WHEELBASE,
  WHEEL_ANCHORS,
} from '../src/data/constants.js';
import { PHYSICS_CONSTANTS_SHA256 } from '../src/data/version.js';
import { stadiumDistance } from '../src/sim/judge.js';
import { Rng } from '../src/sim/rng.js';
import { simulate } from '../src/sim/simulate.js';
import type { BattleInput, SimResult, ThrowParams } from '../src/sim/types.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { createWorld, initPhysics } from '../src/sim/world.js';
import { runBattles } from '../tools/pool.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 在 stadium 內均勻取樣（拒絕取樣，seeded RNG 因此仍完全決定性）。 */
function randomThrow(rng: Rng): ThrowParams {
  const maxZ = THROW_MAX_STADIUM_DISTANCE + FIELD_HALF_SEGMENT;
  let x = 0;
  let z = 0;
  do {
    x = rng.nextRange(-THROW_MAX_STADIUM_DISTANCE, THROW_MAX_STADIUM_DISTANCE);
    z = rng.nextRange(-maxZ, maxZ);
  } while (stadiumDistance(x, z) > THROW_MAX_STADIUM_DISTANCE);

  const L = THROW_LIMITS;
  return {
    x,
    z,
    y: rng.nextRange(L.y.min, L.y.max),
    yaw: rng.nextRange(L.yaw.min, L.yaw.max),
    pitch: rng.nextRange(L.pitch.min, L.pitch.max),
    speed: rng.nextRange(L.speed.min, L.speed.max),
    spin: rng.nextRange(L.spin.min, L.spin.max),
  };
}

function randomBattles(seed: number, count: number): BattleInput[] {
  const rng = new Rng(seed);
  const battles: BattleInput[] = [];
  for (let i = 0; i < count; i += 1) {
    battles.push({ seed: 1000 + i, throwA: randomThrow(rng), throwB: randomThrow(rng) });
  }
  return battles;
}

const BATTLE_COUNT = 500;

/** §11.5b 量的是每 car-frame 的成本，與批次規模無關，取子集即可。 */
const SINGLE_THREAD_SAMPLE = 60;

type Sweep = { results: SimResult[]; elapsedMs: number; workers: number };

let sweep: Sweep;

beforeAll(async () => {
  await initPhysics();
  const battles = randomBattles(20260817, BATTLE_COUNT);
  const workers = availableParallelism();
  const started = performance.now();
  const results = await runBattles(battles, workers);
  sweep = { results, elapsedMs: performance.now() - started, workers };
}, 600_000);

// ──────────────────────────────────────────────────────────────────────────
// §6 新幾何的結構性驗證
// ──────────────────────────────────────────────────────────────────────────

describe('§6.2 質量、重心、慣量全部由幾何衍生', () => {
  it('總質量恰為兩個 collider 的質量和，重心與慣量由 Rapier 合成', () => {
    const world = createWorld();
    try {
      const car = new Vehicle(world, {
        x: 0,
        z: 0,
        y: 0.1,
        yaw: 0,
        pitch: 0,
        speed: 0,
        spin: 0,
      });
      expect(car.body.mass()).toBeCloseTo(TOTAL_MASS, 5);

      // 重心應略偏前（+Z，前武器）與略偏上，且完全對稱於 X。
      const com = car.body.localCom();
      expect(com.x).toBeCloseTo(0, 6);
      expect(com.y).toBeGreaterThan(0);
      expect(com.z).toBeGreaterThan(0.01);

      const inertia = car.body.principalInertia();
      expect(inertia.x).toBeGreaterThan(0);
      expect(inertia.y).toBeGreaterThan(0);
      expect(inertia.z).toBeGreaterThan(0);
      // 底盤窄而長 → roll 慣量明顯小於 pitch / yaw 慣量
      expect(inertia.z).toBeLessThan(inertia.x);
      expect(inertia.z).toBeLessThan(inertia.y);
    } finally {
      world.free();
    }
  });
});

describe('§6.3 輪位幾何與懸吊數值穩定性', () => {
  it('所有錨點都在底盤水平投影內，且嚴格高於車體最低點', () => {
    for (const anchor of WHEEL_ANCHORS) {
      expect(Math.abs(anchor[0])).toBeLessThan(0.035);
      expect(Math.abs(anchor[2])).toBeLessThan(0.05);
      expect(anchor[1]).toBeGreaterThan(VEHICLE_LOWEST_Y);
    }
  });

  it('顯式阻尼在 heave / pitch / roll 三個模態都滿足 |1 - c·K| < 1', () => {
    const world = createWorld();
    try {
      const car = new Vehicle(world, {
        x: 0,
        z: 0,
        y: 0.1,
        yaw: 0,
        pitch: 0,
        speed: 0,
        spin: 0,
      });
      const I = car.body.principalInertia();
      const ratios = {
        heave: 1 - SUSPENSION_DAMPING * ((4 * DT) / TOTAL_MASS),
        pitch: 1 - SUSPENSION_DAMPING * ((4 * (WHEELBASE / 2) ** 2 * DT) / I.x),
        roll: 1 - SUSPENSION_DAMPING * ((4 * (TRACK_WIDTH / 2) ** 2 * DT) / I.z),
      };
      for (const [mode, r] of Object.entries(ratios)) {
        expect(Math.abs(r), `${mode} damping ratio ${r}`).toBeLessThan(1);
      }
    } finally {
      world.free();
    }
  });

  it('靜態行駛高度落在 §7 的 y 下界之下，車體不刮地', () => {
    const world = createWorld();
    try {
      const car = new Vehicle(world, {
        x: 0,
        z: 0,
        y: 0.06,
        yaw: 0,
        pitch: 0,
        speed: 0,
        spin: 0,
      });
      for (let f = 0; f < 400; f += 1) {
        car.applyWheelForces(world, DT);
        world.step();
        car.readState();
        car.clampVelocities();
      }
      const rideHeight = car.body.translation().y;
      expect(rideHeight).toBeGreaterThan(0.027);
      expect(rideHeight).toBeLessThan(THROW_LIMITS.y.min);
      // 車體最低點必須明顯離地
      expect(rideHeight + VEHICLE_LOWEST_Y).toBeGreaterThan(0.015);
    } finally {
      world.free();
    }
  });
});

describe('§5 圍欄無縫隙', () => {
  it('自場內朝各方向射出的射線，全部在圍欄內緣附近命中', () => {
    const world = createWorld();
    try {
      let misses = 0;
      let worstError = 0;
      const angles = 1440;
      for (let i = 0; i < angles; i += 1) {
        const t = (i / angles) * Math.PI * 2;
        const originZ = FIELD_HALF_SEGMENT * Math.sin(t);
        const dir = { x: Math.cos(t), y: 0, z: Math.sin(t) };
        for (const h of [0.005, 0.02, 0.04, 0.055]) {
          const ray = new RAPIER.Ray({ x: 0, y: h, z: originZ }, dir);
          const hit = world.castRay(ray, 1, true);
          if (hit === null) {
            misses += 1;
            continue;
          }
          const px = dir.x * hit.timeOfImpact;
          const pz = originZ + dir.z * hit.timeOfImpact;
          worstError = Math.max(worstError, Math.abs(stadiumDistance(px, pz) - FIELD_RADIUS));
        }
      }
      expect(misses).toBe(0);
      // 平面段近似圓弧造成的外凸誤差，應遠小於車體尺寸
      expect(worstError).toBeLessThan(0.005);
    } finally {
      world.free();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §11 驗收
// ──────────────────────────────────────────────────────────────────────────

describe('§11.2 無爆飛', () => {
  it('沒有任何一幀車體質心 y > 0.5', () => {
    const worst = Math.max(...sweep.results.map((r) => r.stats.maxComY));
    expect(worst).toBeLessThanOrEqual(0.5);
  });

  it('線速度從未觸及 clamp 上限', () => {
    const worst = Math.max(...sweep.results.map((r) => r.stats.maxLinearSpeed));
    const hits = sweep.results.reduce((sum, r) => sum + r.stats.linearClampHits, 0);
    expect(worst).toBeLessThan(MAX_LINEAR_SPEED);
    expect(hits).toBe(0);
  });

  it('角速度從未觸及 clamp 上限', () => {
    const worst = Math.max(...sweep.results.map((r) => r.stats.maxAngularSpeed));
    const hits = sweep.results.reduce((sum, r) => sum + r.stats.angularClampHits, 0);
    expect(worst).toBeLessThan(MAX_ANGULAR_SPEED);
    expect(hits).toBe(0);
  });

  /** 迴歸偵測基線（與 clamp 分工：clamp 只攔數值發散，這裡鎖統計上界）。 */
  it('角速度統計基線未退化', () => {
    const speeds = sweep.results.map((r) => r.stats.maxAngularSpeed).sort((a, b) => a - b);
    const p90 = speeds[Math.floor(speeds.length * 0.9)] as number;
    const peak = speeds[speeds.length - 1] as number;
    expect(p90).toBeLessThan(80); // 實測 53.7
    expect(peak).toBeLessThan(140); // 實測 84.2
  });
});

describe('§11.3 / §11.4 結局可觸發', () => {
  it('隨機掃描中同時出現 FLIP 與 OUT 判定', () => {
    const reasons = sweep.results.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'FLIP').length).toBeGreaterThan(0);
    expect(reasons.filter((r) => r === 'OUT').length).toBeGreaterThan(0);
  });

  it('存在一組投擲參數穩定產生 FLIP', async () => {
    const battle: BattleInput = {
      seed: 20260817,
      throwA: {
        x: 0.0829,
        z: -0.275,
        y: 0.0608,
        yaw: 0.5039,
        pitch: -0.1776,
        speed: 3.9655,
        spin: 13.2095,
      },
      throwB: {
        x: -0.2251,
        z: 0.1421,
        y: 0.0712,
        yaw: 4.7028,
        pitch: -0.2754,
        speed: 1.5321,
        spin: -6.966,
      },
    };
    for (let i = 0; i < 10; i += 1) {
      const r = await simulate(battle);
      expect(r.reason).toBe('FLIP');
      expect(r.result).toBe('B_WINS');
    }
  }, 60_000);

  it('存在一組投擲參數穩定產生 OUT', async () => {
    const battle: BattleInput = {
      seed: 20260817,
      throwA: {
        x: -0.1288,
        z: 0.1,
        y: 0.0607,
        yaw: 4.0095,
        pitch: 0.0563,
        speed: 2.4741,
        spin: 4.3775,
      },
      throwB: {
        x: 0.1442,
        z: 0.2273,
        y: 0.1261,
        yaw: 5.357,
        pitch: 0.2666,
        speed: 0.1488,
        spin: 10.7551,
      },
    };
    for (let i = 0; i < 10; i += 1) {
      const r = await simulate(battle);
      expect(r.reason).toBe('OUT');
      expect(r.result).toBe('A_WINS');
    }
  }, 60_000);
});

describe('§11.5a 批次吞吐（工程指標）', () => {
  it(`${BATTLE_COUNT} 場以 worker pool 平行執行於 30 秒內完成`, () => {
    expect(sweep.workers).toBeGreaterThan(1);
    expect(sweep.elapsedMs).toBeLessThan(30_000);
  });
});

describe('§11.5b 單場成本（迴歸指標）', () => {
  it('單執行緒模式下每 car-frame 的平均成本不超過 50 µs', async () => {
    const battles = randomBattles(20260817, BATTLE_COUNT).slice(0, SINGLE_THREAD_SAMPLE);
    const started = performance.now();
    const results = await runBattles(battles, 1);
    const elapsedMs = performance.now() - started;

    const carFrames = results.reduce((sum, r) => sum + r.frames * 2, 0);
    const usPerCarFrame = (elapsedMs * 1000) / carFrames;
    expect(carFrames).toBeGreaterThan(10_000); // 樣本要夠大才有意義
    expect(usPerCarFrame).toBeLessThan(50); // 實測約 20.4 µs
  }, 300_000);
});

// ──────────────────────────────────────────────────────────────────────────
// §11.6 / §11.7 靜態檢查
// ──────────────────────────────────────────────────────────────────────────

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const RENDERING_PATTERN =
  /\b(getContext|WebGLRenderingContext|WebGL2RenderingContext|requestAnimationFrame|HTMLCanvasElement|OffscreenCanvas|THREE|BABYLON|PIXI)\b/;
const BROWSER_PATTERN = /(^|[^.\w])(window|document|performance|navigator|localStorage)\s*\./;

/**
 * §11.6 於 Phase 1 重新界定範圍。
 *
 * Phase 0 的條文是「全專案不含任何渲染相關依賴或程式碼」，而 Phase 1 §P0.1
 * 明確指定採用 three.js —— 兩者字面上直接衝突，原本的「相依套件不含渲染函式庫」
 * 測試在 three.js 進入相依樹後必然失敗。
 *
 * 條文的**意圖**是「物理核心不得被渲染污染」，這一點在 Phase 1 依然成立而且更重要，
 * 因此改為驗證**邊界**而非全域缺席，並在原地加強：
 *   - `src/sim/`、`src/data/`、`src/replay/`、`tools/` 都不得出現渲染 API 或 import three
 *   - three 與 Rapier 同規則，必須精確版本鎖定
 *   - 只有 `src/render/` 與 `src/ui/` 允許碰渲染
 *
 * 此調整需經設計方追認（見交付報告）。
 */
describe('§11.6 渲染與物理核心的邊界', () => {
  /** 唯二允許使用渲染 API 的目錄。 */
  const RENDER_ALLOWED = [join(REPO_ROOT, 'src', 'render'), join(REPO_ROOT, 'src', 'ui')];

  const headlessSources = [
    ...collectSourceFiles(join(REPO_ROOT, 'src')),
    ...collectSourceFiles(join(REPO_ROOT, 'tools')),
  ].filter((file) => !RENDER_ALLOWED.some((dir) => file.startsWith(dir)));

  it('headless 部分（sim / data / replay / tools）不含任何渲染 API', () => {
    const offenders = headlessSources.filter((file) =>
      RENDERING_PATTERN.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });

  it('headless 部分不 import three 或任何渲染函式庫', () => {
    const offenders = headlessSources.filter((file) =>
      /from\s+'(three|babylonjs|@babylonjs|pixi\.js|regl|twgl|ogl|p5|phaser)/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });

  it('three.js 與 Rapier 同規則，以精確版本號鎖定', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['three']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * §P1.4.2 的提示性測試：constants.ts 的內容改了但 physicsVersion 沒動就失敗。
   *
   * 這是**提醒**而非阻止 —— 純註解變更也會觸發，此時只需把新雜湊蓋回
   * `src/data/version.ts` 的 `PHYSICS_CONSTANTS_SHA256`，不必升版。
   * 若改的是會影響物理的數值，則兩者都要更新。
   */
  it('physicsVersion 與 constants.ts 的內容同步（§P1.4.2）', async () => {
    const { createHash } = await import('node:crypto');
    const source = readFileSync(join(REPO_ROOT, 'src', 'data', 'constants.ts'));
    const actual = createHash('sha256').update(source).digest('hex');
    expect(
      actual,
      `src/data/constants.ts 改變了。若是影響物理的變更，請把 src/data/version.ts 的 ` +
        `PHYSICS_VERSION +1；無論如何都要把 PHYSICS_CONSTANTS_SHA256 更新為 ${actual}`,
    ).toBe(PHYSICS_CONSTANTS_SHA256);
  });

  it('Rapier 版本以精確版本號鎖定', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const version = pkg.dependencies['@dimforge/rapier3d-compat'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('§2 / §3 專案級禁令', () => {
  const simSources = [
    ...collectSourceFiles(join(REPO_ROOT, 'src', 'sim')),
    ...collectSourceFiles(join(REPO_ROOT, 'src', 'data')),
  ];

  it('src/sim 與 src/data 不使用任何瀏覽器 API', () => {
    const offenders = simSources.filter((file) => BROWSER_PATTERN.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });

  it('src/sim 與 src/data 不做任何 I/O、不輸出到主控台', () => {
    const offenders = simSources.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /\bconsole\s*\./.test(text) || /from\s+'node:(fs|http|https|child_process)'/.test(text);
    });
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });

  // 測試名稱刻意不寫出被禁的字面 API 名稱，否則本檔會把自己掃成違例。
  it('模擬核心不使用未受控的隨機來源或牆上時間(§3.1 / §3.2)', () => {
    // §3 禁令保護的是**模擬**的決定性，因此檢查範圍是 src/sim 與 src/data。
    //
    // src/ui 明確排除：UI 的「隨機產生」是使用者輸入的來源，不是模擬過程。
    // 隨機的是輸入，任何一組輸入送進 simulate() 之後仍完全可重現
    // ——由 tests/random-throw.test.ts 驗證。設計方 2026-08-18 裁決此範圍。
    // src/render 也排除：它需要 performance.now() 量測產生耗時與 fps。
    const all = [
      ...collectSourceFiles(join(REPO_ROOT, 'src', 'sim')),
      ...collectSourceFiles(join(REPO_ROOT, 'src', 'data')),
    ];
    const offenders = all.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /Math\s*\.\s*random\s*\(/.test(text) || /Date\s*\.\s*now\s*\(/.test(text);
    });
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });

  it('不使用 Rapier 的內建車輛控制器，也不對動態物體用 trimesh', () => {
    const all = [
      ...collectSourceFiles(join(REPO_ROOT, 'src')),
      ...collectSourceFiles(join(REPO_ROOT, 'tools')),
    ];
    const offenders = all.filter((file) => {
      const text = readFileSync(file, 'utf8')
        // 註解中提到禁令名稱是允許的，只檢查實際程式碼
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return /createVehicleController|DynamicRayCastVehicleController|ColliderDesc\s*\.\s*trimesh/.test(
        text,
      );
    });
    expect(offenders.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });
});

describe('§7 投擲參數驗證', () => {
  const legal: ThrowParams = {
    x: 0,
    z: 0,
    y: 0.05,
    yaw: 0,
    pitch: 0,
    speed: 1,
    spin: 0,
  };

  it('投入點超出 stadium 餘裕範圍時拋出錯誤，不靜默 clamp', async () => {
    await expect(
      simulate({ seed: 1, throwA: { ...legal, x: 0.3 }, throwB: legal }),
    ).rejects.toThrow(RangeError);
    await expect(
      simulate({ seed: 1, throwA: { ...legal, z: 0.45 }, throwB: legal }),
    ).rejects.toThrow(RangeError);
  });

  it('y 低於 0.030 時拋出錯誤', async () => {
    await expect(
      simulate({ seed: 1, throwA: { ...legal, y: 0.02 }, throwB: legal }),
    ).rejects.toThrow(RangeError);
  });

  it('速度或自旋超出範圍時拋出錯誤', async () => {
    await expect(
      simulate({ seed: 1, throwA: legal, throwB: { ...legal, speed: 5.1 } }),
    ).rejects.toThrow(RangeError);
    await expect(
      simulate({ seed: 1, throwA: legal, throwB: { ...legal, spin: -21 } }),
    ).rejects.toThrow(RangeError);
  });

  it('stadium 邊緣的合法投入點可以通過（z 方向可到 0.42）', async () => {
    const r = await simulate({
      seed: 1,
      throwA: { ...legal, z: 0.41 },
      throwB: { ...legal, z: -0.41 },
    });
    expect(r.frames).toBeGreaterThan(0);
  });
});

describe('§8.1 stadium 距離函數', () => {
  it('中央直線段內，距離只取決於 |x|', () => {
    expect(stadiumDistance(0.2, 0)).toBeCloseTo(0.2, 9);
    expect(stadiumDistance(0.2, 0.1)).toBeCloseTo(0.2, 9);
    expect(stadiumDistance(-0.2, -0.15)).toBeCloseTo(0.2, 9);
  });

  it('兩端半圓內，距離為到半圓圓心的平面距離', () => {
    expect(stadiumDistance(0, 0.15 + FIELD_RADIUS)).toBeCloseTo(FIELD_RADIUS, 9);
    expect(stadiumDistance(0, -0.15 - FIELD_RADIUS)).toBeCloseTo(FIELD_RADIUS, 9);
    // 3-4-5 直角三角形：z 夾擠到 0.15 後餘 0.40，與 x = 0.30 合成恰為 0.50。
    // 這裡刻意寫出常數而非用 Math.hypot 當參考值（§3 禁令 7 的精神）。
    expect(stadiumDistance(0.3, 0.55)).toBeCloseTo(0.5, 9);
  });

  it('圍欄內緣恰好等於 FIELD_RADIUS', () => {
    for (let i = 0; i < 64; i += 1) {
      const t = (i / 64) * Math.PI * 2;
      const x = FIELD_RADIUS * Math.cos(t);
      const z = FIELD_HALF_SEGMENT * Math.sign(Math.sin(t)) + FIELD_RADIUS * Math.sin(t);
      expect(stadiumDistance(x, z)).toBeLessThanOrEqual(FIELD_RADIUS + 1e-9);
    }
  });
});

describe('§14.5 暖機 step 讓第 0 幀的懸吊 raycast 有效', () => {
  it('世界建好後、任何動態 step 之前，raycast 就能命中地板', () => {
    const world = createWorld();
    try {
      const ray = new RAPIER.Ray({ x: 0, y: 0.02, z: 0 }, { x: 0, y: -1, z: 0 });
      const hit = world.castRayAndGetNormal(ray, SUSPENSION_RAY_LENGTH, true);
      expect(hit).not.toBeNull();
      expect(hit?.timeOfImpact).toBeCloseTo(0.02, 5);
      expect(hit?.normal.y).toBeCloseTo(1, 5);
    } finally {
      world.free();
    }
  });
});
