#!/usr/bin/env node
/**
 * 第五輪:鏟形武器 + substep 的驗收。
 *
 *   npx tsx tools/wedge-round5.ts
 *
 * 四組(同一批投擲,只差設定):
 *   substep 1 / 4 × 地板摩擦 0 / 0.20
 *
 * 另外做兩件事:
 *   - 刃口單步位移上界(以 maxLinear + maxAngular × r_tip 推得,是**上界**不是估計)
 *   - 鏟起式翻覆的定向搜尋,找到即輸出 replay 檔
 *
 * `constants.ts` 未改動;新車體與 substep 皆以覆寫載入。
 */

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { DT, THROW_LIMITS, TIMEOUT_FRAMES } from '../src/data/constants.js';
import { resolveArena, stadiumDistanceIn } from '../src/sim/arena.js';
import { Rng } from '../src/sim/rng.js';
import { checkSeparation } from '../src/sim/separation.js';
import { simulate } from '../src/sim/simulate.js';
import type { BattleInput, PhysicsOverride } from '../src/sim/types.js';
import { resolveVehicle, WEDGE_VEHICLE } from '../src/sim/vehicle-shape.js';
import { initPhysics } from '../src/sim/world.js';
import { BATTLE_COUNT, measureSweep, SWEEP_SEED, type SweepMeasurement } from './measure.js';

const CLEARANCE = 0.005;
/** 對手底盤厚度（base 部件 16 mm）——刃口單步位移必須小於它才可能插入而非穿過。 */
const BASE_THICKNESS = 0.016;

function sampleBattles(physics: PhysicsOverride): BattleInput[] {
  const arena = resolveArena(physics);
  const shape = resolveVehicle(physics.vehicle, physics.vehiclePreset);
  const rng = new Rng(SWEEP_SEED);
  const maxZ = arena.throwMaxStadiumDistance + arena.halfSegment;
  const battles: BattleInput[] = [];
  const L = THROW_LIMITS;
  const point = (): { x: number; z: number } => {
    for (;;) {
      const x = rng.nextRange(-arena.throwMaxStadiumDistance, arena.throwMaxStadiumDistance);
      const z = rng.nextRange(-maxZ, maxZ);
      if (stadiumDistanceIn(arena.halfSegment, x, z) <= arena.throwMaxStadiumDistance) {
        return { x, z };
      }
    }
  };
  const rest = (): { y: number; yaw: number; pitch: number; speed: number; spin: number } => ({
    y: rng.nextRange(L.y.min, L.y.max),
    yaw: rng.nextRange(L.yaw.min, L.yaw.max),
    pitch: rng.nextRange(L.pitch.min, L.pitch.max),
    speed: rng.nextRange(L.speed.min, L.speed.max),
    spin: rng.nextRange(L.spin.min, L.spin.max),
  });
  let guard = 0;
  while (battles.length < BATTLE_COUNT && guard < BATTLE_COUNT * 2000) {
    guard += 1;
    const pa = point();
    const ra = rest();
    const pb = point();
    const rb = rest();
    if (
      !checkSeparation(
        shape,
        { x: pa.x, z: pa.z, yaw: ra.yaw },
        { x: pb.x, z: pb.z, yaw: rb.yaw },
        CLEARANCE,
      ).ok
    ) {
      continue;
    }
    battles.push({
      seed: 1000 + battles.length,
      throwA: { x: pa.x, z: pa.z, ...ra },
      throwB: { x: pb.x, z: pb.z, ...rb },
    });
  }
  return battles;
}

/**
 * 鏟起式翻覆的定向搜尋。
 *
 * A 從後方高速追撞靜止的 B，刃口正對 B 的車尾下緣。速度與橫向偏移掃描，
 * 找到「B 翻覆且 A 未翻覆」的第一組即回傳。
 */
async function findWedgeFlip(physics: PhysicsOverride): Promise<BattleInput | null> {
  for (const speed of [5, 4.5, 4, 3.5, 3, 2.5, 2]) {
    for (const offset of [0, 0.01, -0.01, 0.02, -0.02, 0.03, -0.03]) {
      const input: BattleInput = {
        seed: 20260818,
        // A 在後方，車頭朝 +Z 衝向 B
        throwA: { x: offset, z: -0.16, y: 0.031, yaw: 0, pitch: 0, speed, spin: 0 },
        // B 在前方靜止，車頭同向（因此 A 的鏟刃正對 B 的車尾）
        throwB: { x: 0, z: 0.06, y: 0.031, yaw: 0, pitch: 0, speed: 0, spin: 0 },
      };
      try {
        const r = await simulate(input, { physics });
        if (r.reason === 'FLIP' && r.result === 'A_WINS') return input;
      } catch {
        // 違反 §7.1／§7.2 的組合直接跳過
      }
    }
  }
  return null;
}

function fmt(n: number, d = 3): string {
  return n.toFixed(d);
}

async function main(): Promise<void> {
  await initPhysics();

  const shape = WEDGE_VEHICLE;
  const rTip = shape.maxRadius;

  const variants = [
    { name: 'substep 1 · μ_floor 0', substeps: 1, preset: 'wedge-no-friction' },
    { name: 'substep 1 · μ_floor 0.20', substeps: 1, preset: 'wedge' },
    { name: 'substep 4 · μ_floor 0', substeps: 4, preset: 'wedge-no-friction' },
    { name: 'substep 4 · μ_floor 0.20 ★', substeps: 4, preset: 'wedge' },
  ] as const;

  const base: PhysicsOverride = {
    vehiclePreset: 'wedge',
    vehicleDerivedThrowMargin: true,
    enforceMinThrowSeparation: true,
  };
  const battles = sampleBattles(base);

  const out: string[] = [];
  out.push('# 第五輪:鏟形武器 + substep');
  out.push('');
  out.push(
    `500 場 / 組,同一批投擲(seed ${String(SWEEP_SEED)})。` +
      '`constants.ts` 未改動,未升版 —— 車體與 substep 皆以覆寫載入。',
  );
  out.push('');
  out.push(
    `刃口離地 1.5 mm、厚 1.5 mm;對手底盤厚 ${String(BASE_THICKNESS * 1000)} mm。` +
      '「刃口單步位移」以 `(maxLinear + maxAngular × maxRadius) × dt_physics` 計算,' +
      '是**嚴格上界**而非估計 —— 實際位移不可能超過它。',
  );

  const rows: string[] = [];
  rows.push('| 指標 | ' + variants.map((v) => v.name).join(' | ') + ' |');
  rows.push('|---|' + variants.map(() => '---').join('|') + '|');
  type Row = {
    v: (typeof variants)[number];
    sweep: SweepMeasurement;
    wallMs: number;
  };
  const results: Row[] = [];
  for (const v of variants) {
    process.stderr.write(`  ${v.name} …\n`);
    const started = performance.now();
    const sweep = await measureSweep(battles, {
      ...base,
      vehiclePreset: v.preset,
      substeps: v.substeps,
    });
    results.push({ v, sweep, wallMs: performance.now() - started });
  }

  const row = (label: string, get: (r: Row) => string): void => {
    rows.push(`| ${label} | ${results.map(get).join(' | ')} |`);
  };
  const pct = (n: number, t: number): string => `${fmt((100 * n) / t, 1)}%`;
  row('OUT', (r) => pct(r.sweep.reasons.OUT, r.sweep.battles));
  row('**FLIP**', (r) => `**${pct(r.sweep.reasons.FLIP, r.sweep.battles)}**`);
  row('TIMEOUT', (r) => pct(r.sweep.reasons.TIMEOUT, r.sweep.battles));
  row('0–120 幀', (r) => pct(r.sweep.histogram[0]?.count ?? 0, r.sweep.battles));
  row('120–7199 幀', (r) =>
    pct(
      r.sweep.histogram
        .filter((b) => b.label !== '0-120' && b.label !== '7200 (timeout)')
        .reduce((a, b) => a + b.count, 0),
      r.sweep.battles,
    ),
  );
  row('**clamp 線/角**', (r) => `**${String(r.sweep.clampHits.linear)} / ${String(r.sweep.clampHits.angular)}**`);
  row('質心 y 峰值', (r) => fmt(r.sweep.maxComY, 4));
  row('線速度峰值', (r) => fmt(r.sweep.maxLinearSpeed, 3));
  row('角速度 max', (r) => fmt(r.sweep.angularSpeed.max, 1));
  row('**刃口單步位移上界 mm**', (r) => {
    const dtPhys = DT / r.v.substeps;
    const bound = (r.sweep.maxLinearSpeed + r.sweep.angularSpeed.max * rTip) * dtPhys;
    return `**${fmt(bound * 1000, 2)}**${bound < BASE_THICKNESS ? '' : ' ✗'}`;
  });
  row('總幀數', (r) => String(r.sweep.totalFrames));
  row('牆上時間 s', (r) => fmt(r.wallMs / 1000, 1));
  row('§11.5a 30 秒內', (r) => (r.wallMs < 30000 ? 'OK' : '**超出**'));
  row('每 car-frame µs', (r) => fmt((r.wallMs * 1000) / (r.sweep.totalFrames * 2), 2));

  out.push('');
  out.push('## 四組對照');
  out.push('');
  out.push(rows.join('\n'));

  // 鏟起式翻覆的定向搜尋
  out.push('');
  out.push('## 鏟起式翻覆');
  out.push('');
  const found = await findWedgeFlip({ ...base, substeps: 4 });
  if (found === null) {
    out.push('**未找到**穩定的鏟起式翻覆序列（掃描 7 種速度 × 7 種橫向偏移）。');
  } else {
    const r = await simulate(found, { physics: { ...base, substeps: 4 } });
    const file = {
      _comment:
        '第五輪：A 自後方以鏟形前武器接觸 B 的車尾下緣，將 B 掀翻。' +
        'physics 需以 vehiclePreset: "wedge" + substeps: 4 載入。',
      physics: { vehiclePreset: 'wedge', substeps: 4, vehicleDerivedThrowMargin: true, enforceMinThrowSeparation: true },
      seed: found.seed,
      throwA: found.throwA,
      throwB: found.throwB,
      expected: { result: r.result, reason: r.reason, frames: r.frames },
    };
    writeFileSync('sample_battles/wedge_flip.json', `${JSON.stringify(file, null, 2)}\n`);
    out.push(
      `✓ 找到：A speed ${String(found.throwA.speed)}、橫向偏移 ${String(found.throwA.x)} m，` +
        `結果 ${r.result} / ${r.reason} / ${String(r.frames)} 幀。`,
    );
    out.push('');
    out.push('replay 檔已寫入 `sample_battles/wedge_flip.json`。');
  }

  // 健全性
  out.push('');
  out.push('## 物理健全性');
  out.push('');
  for (const r of results) {
    const checks = [
      ['clamp 0', r.sweep.clampHits.linear === 0 && r.sweep.clampHits.angular === 0],
      ['無爆飛', r.sweep.maxComY <= 0.5],
      ['翻覆可觸發', r.sweep.reasons.FLIP > 0],
      ['出界可觸發', r.sweep.reasons.OUT > 0],
      [
        '刃口不穿透',
        (r.sweep.maxLinearSpeed + r.sweep.angularSpeed.max * rTip) * (DT / r.v.substeps) <
          BASE_THICKNESS,
      ],
    ] as const;
    out.push(
      `- **${r.v.name}**：` + checks.map(([l, ok]) => `${ok ? '✓' : '✗'} ${l}`).join('　'),
    );
  }
  out.push('');
  out.push(`（TIMEOUT_FRAMES = ${String(TIMEOUT_FRAMES)}，幀語意未因 substep 改變。）`);

  process.stdout.write(`${out.join('\n')}\n`);
}

void main();
