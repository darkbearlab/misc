#!/usr/bin/env node
/**
 * 第四輪:官方規格車的物理健全性驗證與輪武器對照組。
 *
 *   npx tsx tools/official-vehicle.ts
 *
 * 兩組完全相同的投擲,只差輪武器是否參與地面碰撞:
 *   - `official`                          輪武器參與（本輪的設計選擇）
 *   - `official-no-ground-wheel-weapon`   輪武器不與地板/圍欄碰撞（對照組）
 *
 * 目的是回答「輪武器的穩定效果是否真實存在」,而不是預設它存在。
 *
 * 車體常數未改動,`PHYSICS_VERSION` 未升版 —— 新車體以 `vehiclePreset` 覆寫載入。
 */

import { THROW_LIMITS, TIRE_FRICTION_COEF } from '../src/data/constants.js';
import { minThrowSeparation, resolveArena, stadiumDistanceIn } from '../src/sim/arena.js';
import { Rng } from '../src/sim/rng.js';
import { checkSeparation } from '../src/sim/separation.js';
import type { BattleInput, PhysicsOverride, VehiclePresetName } from '../src/sim/types.js';
import { assertVehicleGeometry } from '../src/sim/vehicle.js';
import { partCorners, resolveVehicle, type VehiclePart } from '../src/sim/vehicle-shape.js';
import { initPhysics } from '../src/sim/world.js';
import {
  BATTLE_COUNT,
  measureSingleVehicle,
  measureSweep,
  SWEEP_SEED,
  type SweepMeasurement,
} from './measure.js';

const MIN_CLEARANCE = 0.005;

/** 官方部件上限（mm），用於車檢合規對照表。 */
const LIMITS: Record<string, [number, number, number]> = {
  base: [100, 140, 55],
  shell: [140, 90, 50],
  'front-weapon': [65, 55, 70],
  'rear-weapon': [65, 50, 25],
};

function partExtent(part: VehiclePart): { l: number; w: number; h: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, y, z] of partCorners(part)) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { l: (maxZ - minZ) * 1000, w: (maxX - minX) * 1000, h: (maxY - minY) * 1000 };
}

/**
 * 以 §7.1 範圍與 §7.2 多邊形分離取樣合法對戰。
 *
 * 兩組共用同一批投擲 —— 對照組只改碰撞設定，不改輸入，否則差異會混入取樣噪音。
 */
function sampleBattles(physics: PhysicsOverride): {
  battles: BattleInput[];
  separationRejects: number;
  attempts: number;
  prefilterHits: number;
} {
  const arena = resolveArena(physics);
  const shape = resolveVehicle(physics.vehicle, physics.vehiclePreset);
  const rng = new Rng(SWEEP_SEED);
  const maxZ = arena.throwMaxStadiumDistance + arena.halfSegment;
  const battles: BattleInput[] = [];
  let separationRejects = 0;
  let attempts = 0;
  let prefilterHits = 0;

  const point = (): { x: number; z: number } => {
    for (;;) {
      const x = rng.nextRange(-arena.throwMaxStadiumDistance, arena.throwMaxStadiumDistance);
      const z = rng.nextRange(-maxZ, maxZ);
      if (stadiumDistanceIn(arena.halfSegment, x, z) <= arena.throwMaxStadiumDistance) {
        return { x, z };
      }
    }
  };
  const L = THROW_LIMITS;
  const rest = (): { y: number; yaw: number; pitch: number; speed: number; spin: number } => ({
    y: rng.nextRange(L.y.min, L.y.max),
    yaw: rng.nextRange(L.yaw.min, L.yaw.max),
    pitch: rng.nextRange(L.pitch.min, L.pitch.max),
    speed: rng.nextRange(L.speed.min, L.speed.max),
    spin: rng.nextRange(L.spin.min, L.spin.max),
  });

  while (battles.length < BATTLE_COUNT && attempts < BATTLE_COUNT * 2000) {
    attempts += 1;
    const pa = point();
    const ra = rest();
    const pb = point();
    const rb = rest();
    const result = checkSeparation(
      shape,
      { x: pa.x, z: pa.z, yaw: ra.yaw },
      { x: pb.x, z: pb.z, yaw: rb.yaw },
      MIN_CLEARANCE,
    );
    if (!result.ok) {
      separationRejects += 1;
      continue;
    }
    if (result.viaPrefilter) prefilterHits += 1;
    battles.push({
      seed: 1000 + battles.length,
      throwA: { x: pa.x, z: pa.z, ...ra },
      throwB: { x: pb.x, z: pb.z, ...rb },
    });
  }
  return { battles, separationRejects, attempts, prefilterHits };
}

function fmt(n: number, d = 3): string {
  return n.toFixed(d);
}

async function main(): Promise<void> {
  await initPhysics();

  const base: PhysicsOverride = {
    vehiclePreset: 'official',
    vehicleDerivedThrowMargin: true,
    enforceMinThrowSeparation: true,
  };
  const shape = resolveVehicle(undefined, 'official');
  assertVehicleGeometry(shape);

  const out: string[] = [];
  out.push('# 第四輪:官方規格車');
  out.push('');
  out.push(
    `μ = ${String(TIRE_FRICTION_COEF)},懸吊 k / c / restLength / maxTravel 全部維持不變。` +
      '`constants.ts` 未改動,未升版 —— 新車體以 `vehiclePreset` 覆寫載入。',
  );

  // ── 車檢合規 ──
  out.push('');
  out.push('## 車檢合規對照');
  out.push('');
  out.push('| 部件 | 長 mm | 上限 | 寬 mm | 上限 | 高 mm | 上限 | 質量 g |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const part of shape.parts) {
    const e = partExtent(part);
    const lim = LIMITS[part.name];
    const cell = (v: number, l: number | undefined): string =>
      l === undefined ? '—' : `${String(l)}${v <= l + 1e-9 ? '' : ' ✗'}`;
    out.push(
      `| ${part.name} | ${fmt(e.l, 1)} | ${cell(e.l, lim?.[0])} | ${fmt(e.w, 1)} | ` +
        `${cell(e.w, lim?.[1])} | ${fmt(e.h, 1)} | ${cell(e.h, lim?.[2])} | ` +
        `${fmt(part.mass * 1000, 1)} |`,
    );
  }
  out.push(
    `| **全車** | ${fmt(shape.totalLength * 1000, 1)} | 200 | ` +
      `${fmt(shape.totalWidth * 1000, 1)} | 140 | ${fmt(shape.totalHeight * 1000, 1)} | ` +
      `80（垂直範圍；離地頂 ${fmt(shape.totalHeight * 1000 + 12, 1)}） | ` +
      `**${fmt(shape.totalMass * 1000, 1)}** |`,
  );

  // ── 幾何衍生量 ──
  out.push('');
  out.push('## 幾何衍生量');
  out.push('');
  out.push('| 量 | 值 |');
  out.push('|---|---|');
  out.push(`| 輪距 / 軸距 | ${fmt(shape.trackWidth * 1000, 1)} / ${fmt(shape.wheelbase * 1000, 1)} mm |`);
  out.push(`| 車體最低點（局部 y） | ${fmt(shape.lowestY * 1000, 3)} mm |`);
  out.push(`| VEHICLE_MAX_RADIUS | ${fmt(shape.maxRadius * 1000, 3)} mm |`);
  out.push(`| §7.1 投擲餘裕 | ${fmt((shape.maxRadius + 0.02) * 1000, 3)} mm |`);
  out.push(`| §7.2 外接圓預篩門檻 | ${fmt(minThrowSeparation(shape) * 1000, 3)} mm |`);
  out.push(`| §7.2 實際要求 | 多邊形最小間距 ≥ ${String(MIN_CLEARANCE * 1000)} mm |`);

  // ── 單車量測 ──
  const single = measureSingleVehicle(base);
  out.push('');
  out.push('## 單車靜態量測');
  out.push('');
  out.push('| 量 | 值 |');
  out.push('|---|---|');
  out.push(`| 靜態行駛高度 | ${fmt(single.rideHeight * 1000, 3)} mm |`);
  out.push(`| 離地高 | ${fmt(single.groundClearance * 1000, 3)} mm |`);
  out.push(`| 重心高（接地面起） | ${fmt(single.cogHeight * 1000, 3)} mm |`);
  out.push(`| localCom (y, z) | ${fmt(single.localCom.y * 1000, 3)}, ${fmt(single.localCom.z * 1000, 3)} mm |`);
  out.push(`| I_xx / I_yy / I_zz | ${fmt(single.inertia.x * 1000, 5)} / ${fmt(single.inertia.y * 1000, 5)} / ${fmt(single.inertia.z * 1000, 5)} g·m² |`);
  out.push(`| **翻覆臨界 μ** | **${fmt(single.rolloverMu, 4)}** |`);
  out.push(`| K heave / pitch / roll | ${fmt(single.modeK.heave, 5)} / ${fmt(single.modeK.pitch, 5)} / ${fmt(single.modeK.roll, 5)} |`);
  out.push(`| **r heave / pitch / roll** | **${fmt(single.modes.heave, 4)} / ${fmt(single.modes.pitch, 4)} / ${fmt(single.modes.roll, 4)}** |`);
  out.push(`| 自由加速 | ${fmt(single.freeAccel, 3)} m/s |`);

  const worst = (['heave', 'pitch', 'roll'] as const).filter(
    (m) => Math.abs(single.modes[m]) >= 1,
  );
  if (worst.length > 0) {
    out.push('');
    for (const m of worst) {
      out.push(
        `⚠ **${m} 模態 r = ${fmt(single.modes[m], 4)},|r| ≥ 1**。K = ${fmt(single.modeK[m], 5)},` +
          `需要 c < ${fmt(2 / single.modeK[m], 4)}（現行 c = 2）。依指示不自行調整。`,
      );
    }
  } else {
    out.push('');
    out.push('✓ 懸吊三模態全部 |r| < 1,無須調整 c。');
  }

  // ── 取樣 ──
  const sampling = sampleBattles(base);
  out.push('');
  out.push('## §7.2 取樣');
  out.push('');
  out.push(`| 量 | 值 |`);
  out.push('|---|---|');
  out.push(`| 產出合法對戰 | ${String(sampling.battles.length)} |`);
  out.push(`| 嘗試次數 | ${String(sampling.attempts)} |`);
  out.push(
    `| §7.2 拒絕率 | ${fmt((100 * sampling.separationRejects) / sampling.attempts, 1)}% |`,
  );
  out.push(
    `| 外接圓預篩直接通過 | ${fmt((100 * sampling.prefilterHits) / sampling.battles.length, 1)}%（其餘走多邊形） |`,
  );

  // ── 兩組戰鬥 ──
  const groups: { name: string; preset: VehiclePresetName }[] = [
    { name: '輪武器參與地面碰撞', preset: 'official-ground-wheel-weapon' },
    { name: '不參與（裁決 1 採用）', preset: 'official' },
  ];
  const rows: string[] = [];
  rows.push('| 指標 | ' + groups.map((g) => g.name).join(' | ') + ' |');
  rows.push('|---|---|---|');
  const results: SweepMeasurement[] = [];
  for (const g of groups) {
    process.stderr.write(`  ${g.name} …\n`);
    const sweep = await measureSweep(sampling.battles, { ...base, vehiclePreset: g.preset });
    results.push(sweep);
  }
  const row = (label: string, get: (s: SweepMeasurement) => string): void => {
    rows.push(`| ${label} | ${results.map(get).join(' | ')} |`);
  };
  const pct = (n: number, total: number): string => `${fmt((100 * n) / total, 1)}%`;
  row('OUT', (s) => `${String(s.reasons.OUT)} (${pct(s.reasons.OUT, s.battles)})`);
  row('FLIP', (s) => `${String(s.reasons.FLIP)} (${pct(s.reasons.FLIP, s.battles)})`);
  row('TIMEOUT', (s) => `${String(s.reasons.TIMEOUT)} (${pct(s.reasons.TIMEOUT, s.battles)})`);
  row('0–120 幀', (s) => pct(s.histogram[0]?.count ?? 0, s.battles));
  row('120–7199 幀', (s) =>
    pct(
      s.histogram
        .filter((b) => b.label !== '0-120' && b.label !== '7200 (timeout)')
        .reduce((a, b) => a + b.count, 0),
      s.battles,
    ),
  );
  row('角速度 p50 / p99 / max', (s) =>
    `${fmt(s.angularSpeed.p50, 1)} / ${fmt(s.angularSpeed.p99, 1)} / ${fmt(s.angularSpeed.max, 1)}`,
  );
  row('**clamp 線 / 角**', (s) => `**${String(s.clampHits.linear)} / ${String(s.clampHits.angular)}**`);
  row('線速度峰值', (s) => fmt(s.maxLinearSpeed, 3));
  row('**質心 y 峰值**', (s) => `**${fmt(s.maxComY, 4)}**`);
  row('總幀數', (s) => String(s.totalFrames));

  out.push('');
  out.push(`## 500 場對照（同一批投擲，只差輪武器是否參與地面碰撞）`);
  out.push('');
  out.push(rows.join('\n'));

  // ── 健全性結論 ──
  out.push('');
  out.push('## 物理健全性');
  out.push('');
  for (let i = 0; i < groups.length; i += 1) {
    const s = results[i];
    const g = groups[i];
    if (s === undefined || g === undefined) continue;
    const checks = [
      ['clamp 觸發為 0', s.clampHits.linear === 0 && s.clampHits.angular === 0],
      ['無爆飛（質心 y ≤ 0.5）', s.maxComY <= 0.5],
      ['翻覆可觸發', s.reasons.FLIP > 0],
      ['出界可觸發', s.reasons.OUT > 0],
    ] as const;
    out.push(
      `- **${g.name}**：` +
        checks.map(([label, ok]) => `${ok ? '✓' : '✗'} ${label}`).join('　'),
    );
  }

  process.stdout.write(`${out.join('\n')}\n`);
}

void main();
