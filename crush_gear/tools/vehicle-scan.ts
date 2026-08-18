#!/usr/bin/env node
/**
 * Phase 1.5 第三輪的**靜態**分析：車體尺寸 × 場地尺寸的 9 組組合。
 *
 *   npx tsx tools/vehicle-scan.ts
 *   npx tsx tools/vehicle-scan.ts --height-reading=absolute
 *
 * 這一支**不跑 500 場戰鬥**，只算與模擬長度無關的量：
 * 質量屬性、翻覆臨界 μ、懸吊三模態、§7.2 取樣拒絕率、幾何斷言。
 * 目的是在昂貴的 9×500 掃描之前先確認每一組都站得住。
 *
 * 車體常數不變，`PHYSICS_VERSION` 未升版；覆寫只存在於記憶體中。
 */

import { THROW_LIMITS, TIRE_FRICTION_COEF } from '../src/data/constants.js';
import { minThrowSeparation, resolveArena, stadiumDistanceIn } from '../src/sim/arena.js';
import { Rng } from '../src/sim/rng.js';
import type {
  BattleInput,
  PhysicsOverride,
  ThrowParams,
  VehicleOverride,
} from '../src/sim/types.js';
import { assertVehicleGeometry } from '../src/sim/vehicle.js';
import { resolveVehicle, V1_TOTAL_HEIGHT } from '../src/sim/vehicle-shape.js';
import { initPhysics } from '../src/sim/world.js';
import { measureSingleVehicle, measureSweep, SWEEP_SEED } from './measure.js';

type ArenaSpec = { name: string; radius: number; segment: number };

const ARENAS: ArenaSpec[] = [
  { name: '基線', radius: 0.35, segment: 0.3 },
  { name: 'S1', radius: 0.3, segment: 0.257 },
  { name: 'S2', radius: 0.25, segment: 0.214 },
];

/** 車體組合。全長 / 底盤寬 / 輪距 取自裁決表格；全高的兩種讀法見 HEIGHTS。 */
type VehicleSpec = { name: string; totalLength: number; chassisWidth: number; trackWidth: number };

const VEHICLES: VehicleSpec[] = [
  { name: 'V1', totalLength: 0.15, chassisWidth: 0.07, trackWidth: 0.056 },
  { name: 'V2', totalLength: 0.175, chassisWidth: 0.082, trackWidth: 0.065 },
  { name: 'V3', totalLength: 0.2, chassisWidth: 0.093, trackWidth: 0.075 },
];

/**
 * 裁決表格的全高欄為 30 / 40 / 50 mm，但 V1 車體實際的垂直範圍是 **25 mm**
 * （底盤頂 0.015 − 底盤底 −0.010）。全長 150、底盤寬 70、輪距 56 三項與現行常數完全吻合，
 * 只有全高對不上，因此有兩種讀法：
 *
 * - `absolute`：表格是**絕對目標值**，V1 的 30 為筆誤（實為 25），V2/V3 就是 40 / 50 mm。
 *   縮放因子 sH = 1.000 / 1.600 / 2.000。
 * - `ratio`：表格的**比例**才是本意，V2/V3 相對 V1 放大 40/30 與 50/30。
 *   縮放因子 sH = 1.000 / 1.333 / 1.667，實際全高 25 / 33.3 / 41.7 mm。
 *
 * 兩者對重心高度（進而翻覆臨界 μ，本輪的主要因變數）影響顯著，故並列輸出待裁決。
 */
const HEIGHTS: Record<string, readonly [number, number, number]> = {
  absolute: [V1_TOTAL_HEIGHT, 0.04, 0.05],
  ratio: [V1_TOTAL_HEIGHT, V1_TOTAL_HEIGHT * (40 / 30), V1_TOTAL_HEIGHT * (50 / 30)],
};

// ──────────────────────────────────────────────────────────────────────────
// §7.2 拒絕取樣
// ──────────────────────────────────────────────────────────────────────────

type SamplingCheck = {
  /** 實際取到的合法對戰，供 --battles 模式使用。 */
  battles: BattleInput[];
  /** 只計 §7.2：兩點都已合法後，因距離不足而整組重抽的比例。 */
  separationRate: number;
  /** 含 §7.1 點位越界與 §7.2 距離不足的總拒絕率。 */
  rejectRate: number;
  /** 實際產出的合法對戰數；低於要求代表取樣器撞到上限。 */
  pairs: number;
};

const SAMPLE_PAIRS = 500;

/**
 * 以拒絕取樣產生 SAMPLE_PAIRS 組合法對戰，回報拒絕率。
 *
 * §7.2 規定拒絕率超過 50% 即視為該尺寸不可用，因此這裡分開計「投擲點越界」
 * 與「兩車距離不足」兩種拒絕 —— 後者才是新約束的成本。
 */
function checkSampling(physics: PhysicsOverride): SamplingCheck {
  const arena = resolveArena(physics);
  const rng = new Rng(SWEEP_SEED);
  const maxZ = arena.throwMaxStadiumDistance + arena.halfSegment;
  let pointAttempts = 0;
  let pointRejects = 0;
  let separationRejects = 0;

  const randomPoint = (): { x: number; z: number } => {
    for (;;) {
      pointAttempts += 1;
      const x = rng.nextRange(-arena.throwMaxStadiumDistance, arena.throwMaxStadiumDistance);
      const z = rng.nextRange(-maxZ, maxZ);
      if (stadiumDistanceIn(arena.halfSegment, x, z) <= arena.throwMaxStadiumDistance) {
        return { x, z };
      }
      pointRejects += 1;
    }
  };

  const withRest = (x: number, z: number): ThrowParams => {
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
  };

  const required = arena.minThrowSeparation;
  const battles: BattleInput[] = [];
  let pairAttempts = 0;
  // 上限保護：拒絕率趨近 1 時不能無限迴圈。
  const LIMIT = SAMPLE_PAIRS * 2000;
  while (battles.length < SAMPLE_PAIRS && pairAttempts < LIMIT) {
    pairAttempts += 1;
    const a = randomPoint();
    const b = randomPoint();
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    if (Math.sqrt(dx * dx + dz * dz) < required) {
      separationRejects += 1;
      continue;
    }
    battles.push({
      seed: 1000 + battles.length,
      throwA: withRest(a.x, a.z),
      throwB: withRest(b.x, b.z),
    });
  }

  return {
    battles,
    separationRate: separationRejects / pairAttempts,
    rejectRate: (pointRejects + separationRejects) / (pointAttempts + separationRejects),
    pairs: battles.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────

function fmt(n: number, d = 4): string {
  return n.toFixed(d);
}

async function main(): Promise<void> {
  await initPhysics();

  const arg = process.argv.find((a) => a.startsWith('--height-reading='));
  const readings = arg === undefined ? ['absolute', 'ratio'] : [arg.split('=')[1] as string];
  const wantBattles = process.argv.includes('--battles');
  /** 已跑過的車體（絕對尺寸相同者不重跑），key 為四項尺寸。 */
  const battleDone = new Set<string>();
  const battleRows: string[] = [];

  const out: string[] = [];
  out.push('# 第三輪靜態分析：車體 × 場地 9 組');
  out.push('');
  out.push(
    `μ = ${String(TIRE_FRICTION_COEF)}，質量固定 0.15 kg（0.11 / 0.04），` +
      '懸吊 restLength / maxTravel / k / c 全部不變。constants.ts 未改動，未升版。',
  );

  for (const reading of readings) {
    const heights = HEIGHTS[reading];
    if (heights === undefined) throw new Error(`unknown --height-reading=${reading}`);

    out.push('');
    out.push(`## 全高讀法：${reading}`);
    out.push('');

    const measures = VEHICLES.map((v, i) => {
      const override: VehicleOverride = {
        totalLength: v.totalLength,
        chassisWidth: v.chassisWidth,
        totalHeight: heights[i] as number,
        trackWidth: v.trackWidth,
      };
      const shape = resolveVehicle(override);
      assertVehicleGeometry(shape);
      const m = measureSingleVehicle({ vehicle: override });
      return { spec: v, override, shape, m };
    });

    const rows: string[] = [];
    rows.push(`| 量 | ${VEHICLES.map((v) => v.name).join(' | ')} |`);
    rows.push('|---|---|---|---|');
    const row = (label: string, get: (r: (typeof measures)[number]) => string): void => {
      rows.push(`| ${label} | ${measures.map(get).join(' | ')} |`);
    };
    const gap = (): void => {
      rows.push('| | | | |');
    };

    row('全長 mm', (r) => fmt(r.override.totalLength * 1000, 1));
    row('底盤寬 mm', (r) => fmt(r.override.chassisWidth * 1000, 1));
    row('全高 mm', (r) => fmt(r.override.totalHeight * 1000, 1));
    row('輪距 mm', (r) => fmt(r.shape.trackWidth * 1000, 1));
    row('軸距 mm', (r) => fmt(r.shape.wheelbase * 1000, 2));
    row('底盤 half x/y/z mm', (r) => {
      // 等比放大路徑的 parts[0] 恆為底盤 cuboid（見 resolveVehicle）。
      const base = r.shape.parts[0];
      if (base === undefined || base.kind !== 'cuboid') return '—';
      return [
        fmt(base.halfExtents.x * 1000, 2),
        fmt(base.halfExtents.y * 1000, 2),
        fmt(base.halfExtents.z * 1000, 2),
      ].join('/');
    });
    row('車體最低點 mm', (r) => fmt(r.shape.lowestY * 1000, 2));
    row('maxRadius mm', (r) => fmt(r.shape.maxRadius * 1000, 2));
    row('§7.1 投擲餘裕 mm', (r) => fmt((r.shape.maxRadius + 0.02) * 1000, 2));
    row('§7.2 最小距離 mm', (r) => fmt(minThrowSeparation(r.shape) * 1000, 2));
    gap();
    row('靜態行駛高度 mm', (r) => fmt(r.m.rideHeight * 1000, 2));
    row('離地高 mm', (r) => fmt(r.m.groundClearance * 1000, 2));
    row('localCom y mm', (r) => fmt(r.m.localCom.y * 1000, 3));
    row('localCom z mm', (r) => fmt(r.m.localCom.z * 1000, 3));
    row('重心高（接地面起） mm', (r) => fmt(r.m.cogHeight * 1000, 2));
    row('I_xx (pitch) g·m²', (r) => fmt(r.m.inertia.x * 1000, 5));
    row('I_yy (yaw) g·m²', (r) => fmt(r.m.inertia.y * 1000, 5));
    row('I_zz (roll) g·m²', (r) => fmt(r.m.inertia.z * 1000, 5));
    gap();
    row('**翻覆臨界 μ**', (r) => `**${fmt(r.m.rolloverMu, 4)}**`);
    row('與 μ=0.30 的距離', (r) => fmt(r.m.rolloverMu - 0.3, 4));
    gap();
    row('K heave', (r) => fmt(r.m.modeK.heave, 5));
    row('K pitch', (r) => fmt(r.m.modeK.pitch, 5));
    row('K roll', (r) => fmt(r.m.modeK.roll, 5));
    row('r heave', (r) => fmt(r.m.modes.heave, 5));
    row('r pitch', (r) => fmt(r.m.modes.pitch, 5));
    row('r roll', (r) => fmt(r.m.modes.roll, 5));
    row('三模態 |r| < 1', (r) =>
      Math.max(Math.abs(r.m.modes.heave), Math.abs(r.m.modes.pitch), Math.abs(r.m.modes.roll)) < 1
        ? 'OK'
        : '**FAIL**',
    );
    row('自由加速 m/s', (r) => fmt(r.m.freeAccel, 3));
    out.push(rows.join('\n'));

    // |r| ≥ 1 的組別：回報所需的 c，不自行調整。
    for (const r of measures) {
      for (const k of ['heave', 'pitch', 'roll'] as const) {
        if (Math.abs(r.m.modes[k]) < 1) continue;
        out.push('');
        out.push(
          `⚠ **${r.spec.name} 的 ${k} 模態 r = ${fmt(r.m.modes[k], 4)}，|r| ≥ 1**。` +
            `該模態 K = ${fmt(r.m.modeK[k], 5)}，需要 c < ${fmt(2 / r.m.modeK[k], 4)}（現行 c = 2）。` +
            '依指示不自行調整，回報所需值。',
        );
      }
    }

    out.push('');
    out.push('### 9 組組合');
    out.push('');
    const grid: string[] = [];
    grid.push(
      '| 組合 | R | 短邊 mm | 短邊/車長 | 投擲最大距離 mm | §7.2 最小距離 mm | ' +
        '§7.2 拒絕率 | 總拒絕率 | 可用 |',
    );
    grid.push('|---|---|---|---|---|---|---|---|---|');
    for (const v of measures) {
      for (const a of ARENAS) {
        const physics: PhysicsOverride = {
          fieldRadius: a.radius,
          fieldSegmentLength: a.segment,
          vehicle: v.override,
          vehicleDerivedThrowMargin: true,
          enforceMinThrowSeparation: true,
        };
        const arena = resolveArena(physics);
        const shortSide = arena.fieldRadius * 2;
        const s = checkSampling(physics);
        const usable = s.separationRate <= 0.5 && s.pairs === SAMPLE_PAIRS;
        if (wantBattles && usable) {
          const key = [
            v.override.totalLength,
            v.override.chassisWidth,
            v.override.totalHeight,
            v.override.trackWidth,
            a.radius,
          ].join(':');
          if (!battleDone.has(key)) {
            battleDone.add(key);
            process.stderr.write(`  battles: ${v.spec.name} x ${a.name} (${reading}) ...
`);
            const sweep = await measureSweep(s.battles, physics);
            const watchable = sweep.histogram
              .filter((b) => b.label !== '0-120' && b.label !== '7200 (timeout)')
              .reduce((acc, b) => acc + b.count, 0);
            const pctOf = (n: number): string => fmt((100 * n) / sweep.battles, 1);
            battleRows.push(
              `| ${v.spec.name} x ${a.name}（全高 ${fmt(v.override.totalHeight * 1000, 1)} mm） | ` +
                `${fmt(shortSide / v.override.totalLength, 2)} | ` +
                `${pctOf(sweep.reasons.OUT)}% | ${pctOf(sweep.reasons.FLIP)}% | ` +
                `**${pctOf(sweep.reasons.TIMEOUT)}%** | ` +
                `${pctOf(sweep.histogram[0]?.count ?? 0)}% | **${pctOf(watchable)}%** | ` +
                `${fmt(sweep.angularSpeed.p50, 1)} / ${fmt(sweep.angularSpeed.max, 1)} | ` +
                `${sweep.clampHits.linear} / ${sweep.clampHits.angular} | ` +
                `${fmt(sweep.maxComY, 4)} |`,
            );
          }
        }
        grid.push(
          `| ${v.spec.name} × ${a.name} | ${fmt(a.radius, 3)} | ${fmt(shortSide * 1000, 0)} | ` +
            `${fmt(shortSide / v.override.totalLength, 2)} | ` +
            `${fmt(arena.throwMaxStadiumDistance * 1000, 1)} | ` +
            `${fmt(arena.minThrowSeparation * 1000, 1)} | ${fmt(s.separationRate * 100, 1)}% | ` +
            `${fmt(s.rejectRate * 100, 1)}% | ${usable ? 'OK' : '**不可用**'} |`,
        );
      }
    }
    out.push(grid.join('\n'));
  }

  if (wantBattles) {
    out.push('');
    out.push('## 通過 §7.2 的組合：500 場實測');
    out.push('');
    out.push(
      '只跑 §7.2 拒絕率 ≤ 50% 的組合 —— 其餘依規格已判定不可用，跑了也不構成有效樣本。' +
        '同一組絕對尺寸只跑一次（V1 與兩種全高讀法相同）。',
    );
    out.push('');
    out.push(
      '| 組合 | 短邊/車長 | OUT | FLIP | TIMEOUT | 0-120 幀 | 120-7199 幀 | ' +
        '角速度 p50/max | clamp 線/角 | 質心 y 峰值 |',
    );
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    out.push(...battleRows);
  }

  process.stdout.write(`${out.join('\n')}\n`);
}

void main();
