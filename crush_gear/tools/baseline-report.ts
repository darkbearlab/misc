#!/usr/bin/env node
/**
 * 產生一份完整的物理基線報告(Phase 1.5 調參的對照組)。
 *
 * 每次調整 `src/data/constants.ts` 後重跑本工具,與 `TUNING_PHASE15.md` 的
 * v1 基線逐項對照,即可看出這次改動實際造成了什麼。
 *
 *   npx tsx tools/baseline-report.ts               # 人可讀
 *   npx tsx tools/baseline-report.ts --json        # 機器可讀,便於 diff
 *   npx tsx tools/baseline-report.ts --mu 0.20     # 探索用覆寫(不寫回 constants.ts)
 *
 * 本工具**只讀取**模擬結果,不改變任何物理。
 */

import {
  MAX_ANGULAR_SPEED,
  MAX_LINEAR_SPEED,
  SUSPENSION_DAMPING,
  SUSPENSION_STIFFNESS,
  TOTAL_MASS,
  TRACK_WIDTH,
  WHEELBASE,
} from '../src/data/constants.js';
import { PHYSICS_VERSION } from '../src/data/version.js';
import type { BattleReason, PhysicsOverride } from '../src/sim/types.js';
import { initPhysics } from '../src/sim/world.js';
import {
  BATTLE_COUNT,
  effectiveTireParams,
  measureSingleVehicle,
  measureSweep,
  sweepBattles,
  SWEEP_SEED,
  type SingleVehicleMeasurement,
  type SweepMeasurement,
} from './measure.js';

function parseOverride(argv: readonly string[]): PhysicsOverride | undefined {
  const read = (flag: string): number | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const value = Number(argv[i + 1]);
    if (!Number.isFinite(value)) throw new Error(`${flag} requires a finite number.`);
    return value;
  };
  const mu = read('--mu');
  const speed = read('--wheel-speed');
  if (mu === undefined && speed === undefined) return undefined;
  return {
    ...(mu === undefined ? {} : { tireFrictionCoef: mu }),
    ...(speed === undefined ? {} : { wheelSurfaceSpeed: speed }),
  };
}

export function formatReport(
  single: SingleVehicleMeasurement,
  sweep: SweepMeasurement,
  physics?: PhysicsOverride,
): string {
  const tire = effectiveTireParams(physics);
  const out: string[] = [];
  out.push(`physicsVersion ${String(PHYSICS_VERSION)}`);
  if (tire.overridden) {
    out.push('⚠ 使用探索覆寫,非 constants.ts 的值 —— 不得作為版本依據');
  }
  out.push('');
  out.push('── 參數 ────────────────────────────────────────────');
  out.push(`  輪距 ${TRACK_WIDTH} m   軸距 ${WHEELBASE} m   總質量 ${TOTAL_MASS} kg`);
  out.push(
    `  μ ${tire.mu}   wheelSurfaceSpeed ${tire.wheelSurfaceSpeed} m/s   k ${SUSPENSION_STIFFNESS} N/m   c ${SUSPENSION_DAMPING} Ns/m`,
  );
  out.push('');
  out.push('── 單車實測 ────────────────────────────────────────');
  out.push(`  靜態行駛高度        ${single.rideHeight.toFixed(5)} m（車體原點）`);
  out.push(`  車體最低點離地      ${single.groundClearance.toFixed(5)} m`);
  out.push(
    `  localCom            (${single.localCom.x.toFixed(6)}, ${single.localCom.y.toFixed(6)}, ${single.localCom.z.toFixed(6)})`,
  );
  out.push(
    `  慣量                Ixx ${single.inertia.x.toExponential(4)}  Iyy ${single.inertia.y.toExponential(4)}  Izz ${single.inertia.z.toExponential(4)}`,
  );
  out.push(`  cogHeight           ${single.cogHeight.toFixed(5)} m`);
  out.push(`  翻覆臨界 μ          ${single.rolloverMu.toFixed(3)}（現行 μ = ${tire.mu}）`);
  out.push(
    `  自由加速 0.5 秒     ${single.freeAccel.toFixed(3)} m/s（理論 μ·g·t = ${single.freeAccelTheory.toFixed(3)}，比值 ${single.freeAccelRatio.toFixed(3)}）`,
  );
  out.push(
    `  阻尼三模態 r        heave ${single.modes.heave.toFixed(4)}  pitch ${single.modes.pitch.toFixed(4)}  roll ${single.modes.roll.toFixed(4)}   （須全部 |r| < 1）`,
  );
  out.push('');
  out.push(`── ${String(BATTLE_COUNT)} 場隨機投擲（seed ${String(SWEEP_SEED)}） ──────────────`);
  out.push(
    `  勝負          A_WINS ${String(sweep.results.A_WINS)} / B_WINS ${String(sweep.results.B_WINS)} / DRAW ${String(sweep.results.DRAW)}`,
  );
  out.push(
    `  結束原因      OUT ${String(sweep.reasons.OUT)} / FLIP ${String(sweep.reasons.FLIP)} / TIMEOUT ${String(sweep.reasons.TIMEOUT)}`,
  );
  out.push(`  總幀數        ${String(sweep.totalFrames)}`);
  out.push(
    `  角速度分位    p50 ${sweep.angularSpeed.p50.toFixed(1)}  p90 ${sweep.angularSpeed.p90.toFixed(1)}  p99 ${sweep.angularSpeed.p99.toFixed(1)}  max ${sweep.angularSpeed.max.toFixed(1)}  （clamp ${String(MAX_ANGULAR_SPEED)}）`,
  );
  out.push(
    `  質心 y 峰值   ${sweep.maxComY.toFixed(4)}   線速度峰值 ${sweep.maxLinearSpeed.toFixed(3)}（clamp ${String(MAX_LINEAR_SPEED)}）`,
  );
  out.push(
    `  clamp 觸發    線速度 ${String(sweep.clampHits.linear)} · 角速度 ${String(sweep.clampHits.angular)}`,
  );
  out.push('');
  out.push('  戰鬥長度直方圖');
  const maxCount = Math.max(...sweep.histogram.map((b) => b.count), 1);
  for (const b of sweep.histogram) {
    const bar = '#'.repeat(Math.round((b.count / maxCount) * 32));
    const rs = (Object.entries(b.reasons) as [BattleReason, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${String(n)}`)
      .join(', ');
    out.push(
      `    ${b.label.padEnd(15)} ${String(b.count).padStart(4)} (${((100 * b.count) / sweep.battles).toFixed(1).padStart(5)}%) ${bar.padEnd(32)} ${rs}`,
    );
  }
  out.push('');
  out.push(`  批次耗時      ${String(Math.round(sweep.elapsedMs))} ms（${String(sweep.workers)} workers）`);
  return out.join('\n');
}

async function main(): Promise<void> {
  await initPhysics();
  const physics = parseOverride(process.argv);
  const single = measureSingleVehicle(physics);
  const sweep = await measureSweep(sweepBattles(), physics);

  if (process.argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          physicsVersion: PHYSICS_VERSION,
          tire: effectiveTireParams(physics),
          singleVehicle: single,
          sweep,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${formatReport(single, sweep, physics)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
