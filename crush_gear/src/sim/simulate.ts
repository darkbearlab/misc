/**
 * 主模擬迴圈 —— 對外唯一入口。
 *
 * 決定性契約：相同的 `BattleInput` 必然產生完全相同的 `SimResult`。
 * 為此本檔嚴格固定所有順序：
 *   - 剛體建立順序：場地（地板 → 四面圍欄）→ 車 A → 車 B
 *   - 每幀力的施加順序：車 A 的 4 個輪位（依 WHEEL_ANCHORS 順序）→ 車 B 的 4 個輪位
 *   - 每輪先施加懸吊力再施加輪胎力
 *   - 固定 timestep，迴圈以整數幀計數推進，不依賴實際經過時間
 */

import {
  CHECKSUM_SAMPLE_INTERVAL,
  DT,
  THROW_FENCE_MARGIN,
  THROW_LIMITS,
  THROW_MAX_STADIUM_DISTANCE,
  TIMEOUT_FRAMES,
} from '../data/constants.js';
import { checksumFrame } from './checksum.js';
import { Judge, stadiumDistance } from './judge.js';
import { Rng } from './rng.js';
import type {
  BattleInput,
  SimOptions,
  SimResult,
  ThrowParams,
  VehicleStateDump,
} from './types.js';
import { Vehicle } from './vehicle.js';
import { createWorld, initPhysics } from './world.js';

function checkRange(label: string, value: number, min: number, max: number, maxInclusive: boolean): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`ThrowParams.${label} must be a finite number, got ${String(value)}`);
  }
  const ok = value >= min && (maxInclusive ? value <= max : value < max);
  if (!ok) {
    const upper = maxInclusive ? `${max}]` : `${max})`;
    throw new RangeError(`ThrowParams.${label} out of range: ${value} not in [${min}, ${upper}`);
  }
}

/**
 * §7 參數合法性驗證。超出範圍的參數在模擬開始前拋出錯誤，不得靜默 clamp。
 *
 * @param label 用於錯誤訊息的來源標籤，例如 `throwA`。
 */
export function validateThrowParams(label: string, p: ThrowParams): void {
  // §7：投入點必須位於 stadium 內，且與圍欄內緣至少保持 THROW_FENCE_MARGIN 的距離。
  // v1.0 的矩形範圍檢查已作廢。
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
    throw new RangeError(`ThrowParams.${label}.x/z must be finite numbers.`);
  }
  const distance = stadiumDistance(p.x, p.z);
  if (distance > THROW_MAX_STADIUM_DISTANCE) {
    throw new RangeError(
      `ThrowParams.${label} spawn point (${p.x}, ${p.z}) is ${distance.toFixed(4)} m from the ` +
        `stadium centre line; it must stay within ${THROW_MAX_STADIUM_DISTANCE} m ` +
        `(i.e. at least ${THROW_FENCE_MARGIN} m clear of the fence).`,
    );
  }
  checkRange(`${label}.y`, p.y, THROW_LIMITS.y.min, THROW_LIMITS.y.max, true);
  // yaw 的範圍是 [0, 2π)，上界為開區間。
  checkRange(`${label}.yaw`, p.yaw, THROW_LIMITS.yaw.min, THROW_LIMITS.yaw.max, false);
  checkRange(`${label}.pitch`, p.pitch, THROW_LIMITS.pitch.min, THROW_LIMITS.pitch.max, true);
  checkRange(`${label}.speed`, p.speed, THROW_LIMITS.speed.min, THROW_LIMITS.speed.max, true);
  checkRange(`${label}.spin`, p.spin, THROW_LIMITS.spin.min, THROW_LIMITS.spin.max, true);
}

/** §7 + §9.1 的輸入驗證。 */
export function validateBattleInput(input: BattleInput): void {
  if (!Number.isInteger(input.seed)) {
    throw new RangeError(`BattleInput.seed must be an integer, got ${String(input.seed)}`);
  }
  validateThrowParams('throwA', input.throwA);
  validateThrowParams('throwB', input.throwB);
}

/**
 * 執行一場完整模擬。
 *
 * 第 0 幀為兩車同時投入的瞬間；checksum 於第 0 幀先記錄一次，
 * 之後每 CHECKSUM_SAMPLE_INTERVAL 幀記錄一次，結束幀必記一次（§9.2）。
 */
export async function simulate(input: BattleInput, options: SimOptions = {}): Promise<SimResult> {
  validateBattleInput(input);
  await initPhysics();

  const rng = new Rng(input.seed);
  const world = createWorld();

  try {
    // §9.3 剛體建立順序固定：先車 A 後車 B。
    const vehicleA = new Vehicle(world, input.throwA);
    const vehicleB = new Vehicle(world, input.throwB);
    const vehicles = [vehicleA, vehicleB] as const;

    const judge = new Judge();
    const checksums: number[] = [];
    const denseChecksums: number[] | null = options.dense === true ? [] : null;
    let capturedState: SimResult['capturedState'];

    const currentChecksum = (): number =>
      checksumFrame([vehicleA.checksumState(), vehicleB.checksumState()], rng.snapshot());

    const recordChecksum = (): void => {
      checksums.push(currentChecksum());
    };

    const toDump = (v: Vehicle): VehicleStateDump => {
      const s = v.checksumState();
      return {
        translation: s.translation,
        rotation: s.rotation,
        linvel: s.linvel,
        angvel: s.angvel,
      };
    };

    const recordDiagnostics = (currentFrame: number): void => {
      if (denseChecksums !== null) denseChecksums.push(currentChecksum());
      if (options.captureFrame === currentFrame) {
        capturedState = { frame: currentFrame, a: toDump(vehicleA), b: toDump(vehicleB) };
      }
    };

    let maxComY = Number.NEGATIVE_INFINITY;
    let maxLinearSpeed = 0;
    let maxAngularSpeed = 0;

    const sampleStats = (): void => {
      for (const v of vehicles) {
        maxLinearSpeed = Math.max(maxLinearSpeed, v.linearSpeed());
        maxAngularSpeed = Math.max(maxAngularSpeed, v.angularSpeed());
        maxComY = Math.max(maxComY, v.centerOfMass().y);
      }
    };

    let frame = 0;
    recordChecksum();
    recordDiagnostics(frame);
    sampleStats();

    // 第 0 幀（投入瞬間）也依約定檢查一次；合法的投擲參數不可能在此觸發任何條件。
    let outcome = judge.update(frame, vehicleA.judgeState(), vehicleB.judgeState());

    while (outcome === null && frame < TIMEOUT_FRAMES) {
      vehicleA.applyWheelForces(world, DT);
      vehicleB.applyWheelForces(world, DT);

      world.step();
      frame += 1;

      // 每幀只跨 JS↔wasm 邊界讀一次狀態，之後的取樣、clamp、判定、checksum 全部共用。
      vehicleA.readState();
      vehicleB.readState();

      // clamp 前先取樣，才能看見真實的速度峰值。
      sampleStats();
      vehicleA.clampVelocities();
      vehicleB.clampVelocities();

      outcome = judge.update(frame, vehicleA.judgeState(), vehicleB.judgeState());

      const isSampleFrame = frame % CHECKSUM_SAMPLE_INTERVAL === 0;
      if (isSampleFrame) recordChecksum();
      if (outcome !== null && !isSampleFrame) recordChecksum();
      recordDiagnostics(frame);
    }

    // 理論上不可達：judge 在 frame === TIMEOUT_FRAMES 時必定回傳 DRAW/TIMEOUT。
    const finalOutcome = outcome ?? { result: 'DRAW' as const, reason: 'TIMEOUT' as const };

    return {
      result: finalOutcome.result,
      reason: finalOutcome.reason,
      frames: frame,
      checksums,
      ...(denseChecksums !== null ? { denseChecksums } : {}),
      ...(capturedState !== undefined ? { capturedState } : {}),
      stats: {
        maxComY,
        maxLinearSpeed,
        maxAngularSpeed,
        linearClampHits: vehicleA.linearClampHits + vehicleB.linearClampHits,
        angularClampHits: vehicleA.angularClampHits + vehicleB.angularClampHits,
      },
    };
  } finally {
    world.free();
  }
}
