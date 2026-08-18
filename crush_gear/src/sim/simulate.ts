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
  THROW_LIMITS,
  TIMEOUT_FRAMES,
} from '../data/constants.js';
import {
  DEFAULT_ARENA,
  MIN_SEPARATION_CLEARANCE,
  resolveArena,
  stadiumDistanceIn,
  type ResolvedArena,
} from './arena.js';
import { checkSeparation } from './separation.js';
import { checksumFrame } from './checksum.js';
import { Judge } from './judge.js';
import { Rng } from './rng.js';
import type {
  PhysicsOverride,
  BattleInput,
  SimOptions,
  SimResult,
  ThrowParams,
  TrajectoryDiagnostics,
  TrajectoryFrames,
  VehicleStateDump,
  WheelDiagnosticsWriter,
} from './types.js';
import { Vehicle } from './vehicle.js';
import { resolveVehicle } from './vehicle-shape.js';
import { createWorld, ENVIRONMENT_GROUPS, initPhysics } from './world.js';

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
export function validateThrowParams(
  label: string,
  p: ThrowParams,
  arena: ResolvedArena = DEFAULT_ARENA,
): void {
  // §7：投入點必須位於 stadium 內，且與圍欄內緣至少保持 THROW_FENCE_MARGIN 的距離。
  // v1.0 的矩形範圍檢查已作廢。
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
    throw new RangeError(`ThrowParams.${label}.x/z must be finite numbers.`);
  }
  const distance = stadiumDistanceIn(arena.halfSegment, p.x, p.z);
  if (distance > arena.throwMaxStadiumDistance) {
    throw new RangeError(
      `ThrowParams.${label} spawn point (${p.x}, ${p.z}) is ${distance.toFixed(4)} m from the ` +
        `stadium centre line; it must stay within ${String(arena.throwMaxStadiumDistance)} m ` +
        `(i.e. at least ${String(arena.throwMargin)} m clear of the fence).`,
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
export function validateBattleInput(
  input: BattleInput,
  arena: ResolvedArena = DEFAULT_ARENA,
  physics?: PhysicsOverride,
): void {
  if (!Number.isInteger(input.seed)) {
    throw new RangeError(`BattleInput.seed must be an integer, got ${String(input.seed)}`);
  }
  validateThrowParams('throwA', input.throwA, arena);
  validateThrowParams('throwB', input.throwB, arena);
  validateThrowSeparation(input, arena, physics);
}

/**
 * §7.2 兩車初始分離(第四輪修訂)。
 *
 * 以雙方 yaw 與各部件的 XZ 投影多邊形做 2D 判定,要求不重疊且最小間距
 * ≥ `MIN_SEPARATION_CLEARANCE`。外接圓保留為快速預篩。詳見 `separation.ts`。
 *
 * 仍然是**純幾何**:不建立世界、不做碰撞查詢,因此「參數驗證先於模擬」的分層不變。
 *
 * `arena.minThrowSeparation` 為 0 時不檢查,即 `PHYSICS_VERSION = 1` 的凍結行為。
 */
export function validateThrowSeparation(
  input: BattleInput,
  arena: ResolvedArena,
  physics?: PhysicsOverride,
): void {
  if (!(arena.minThrowSeparation > 0)) return;

  const shape = resolveVehicle(physics?.vehicle, physics?.vehiclePreset);
  const result = checkSeparation(
    shape,
    { x: input.throwA.x, z: input.throwA.z, yaw: input.throwA.yaw },
    { x: input.throwB.x, z: input.throwB.z, yaw: input.throwB.yaw },
    MIN_SEPARATION_CLEARANCE,
  );
  if (!result.ok) {
    throw new RangeError(
      `Throw points leave only ${result.distance.toFixed(4)} m between the two vehicles; ` +
        `§7.2 requires at least ${String(MIN_SEPARATION_CLEARANCE)} m of clearance between ` +
        `their footprints. The two cars would spawn intersecting or touching.`,
    );
  }
}

/**
 * 執行一場完整模擬。
 *
 * 第 0 幀為兩車同時投入的瞬間；checksum 於第 0 幀先記錄一次，
 * 之後每 CHECKSUM_SAMPLE_INTERVAL 幀記錄一次，結束幀必記一次（§9.2）。
 */
export async function simulate(input: BattleInput, options: SimOptions = {}): Promise<SimResult> {
  const arena = resolveArena(options.physics);
  validateBattleInput(input, arena, options.physics);
  await initPhysics();

  const rng = new Rng(input.seed);
  // 輪武器不參與地面碰撞的對照組，需要環境擁有獨立的 membership 位元才擋得掉；
  // 其餘情況一律不呼叫 setCollisionGroups，維持 v1 的執行路徑（見 world.ts）。
  const shape = resolveVehicle(options.physics?.vehicle, options.physics?.vehiclePreset);
  const substeps = options.physics?.substeps ?? 1;
  if (!Number.isInteger(substeps) || substeps < 1) {
    throw new RangeError(
      `PhysicsOverride.substeps must be a positive integer, got ${String(substeps)}.`,
    );
  }
  const physicsDt = substeps === 1 ? DT : DT / substeps;
  const world = createWorld(
    arena,
    shape.wheelWeaponHitsGround ? undefined : ENVIRONMENT_GROUPS,
    shape.nonWheelFriction,
    physicsDt,
  );

  try {
    // §9.3 剛體建立順序固定：先車 A 後車 B。
    const vehicleA = new Vehicle(world, input.throwA, options.physics);
    const vehicleB = new Vehicle(world, input.throwB, options.physics);
    const vehicles = [vehicleA, vehicleB] as const;

    const judge = new Judge(arena);
    const checksums: number[] = [];
    const denseChecksums: number[] | null = options.dense === true ? [] : null;
    let capturedState: SimResult['capturedState'];

    const currentChecksum = (): number =>
      checksumFrame([vehicleA.checksumState(), vehicleB.checksumState()], rng.snapshot());

    const recordChecksum = (): void => {
      checksums.push(currentChecksum());
    };

    // ── §P1.3 / §P1.5 旁路記錄 ──────────────────────────────────────────
    // 兩者都只是把既有的計算結果抄一份出來。緩衝區以最長場次配置，結束時再截斷，
    // 迴圈內不做任何配置，也不影響任何力的施加順序。
    const capacity = TIMEOUT_FRAMES + 1;
    const wantTrajectory = options.trajectory === true;
    const wantDiagnostics = options.diagnostics === true;

    const position = wantTrajectory
      ? [new Float32Array(capacity * 3), new Float32Array(capacity * 3)]
      : null;
    const rotation = wantTrajectory
      ? [new Float32Array(capacity * 4), new Float32Array(capacity * 4)]
      : null;

    const diagWriters: WheelDiagnosticsWriter[] | null = wantDiagnostics
      ? vehicles.map(() => ({
          grounded: new Uint8Array(capacity * 4),
          normalForce: new Float32Array(capacity * 4),
          tireForce: new Float32Array(capacity * 4 * 3),
          contactPoint: new Float32Array(capacity * 4 * 3),
          frame: 0,
        }))
      : null;
    const stadiumDist = wantDiagnostics
      ? [new Float32Array(capacity), new Float32Array(capacity)]
      : null;
    const flipCounter = wantDiagnostics
      ? [new Uint16Array(capacity), new Uint16Array(capacity)]
      : null;

    const recordTrajectory = (currentFrame: number): void => {
      if (position === null || rotation === null) return;
      for (let v = 0; v < vehicles.length; v += 1) {
        const vehicle = vehicles[v] as Vehicle;
        const t = vehicle.translation();
        const p = position[v] as Float32Array;
        const o = currentFrame * 3;
        p[o] = t.x;
        p[o + 1] = t.y;
        p[o + 2] = t.z;

        const q = vehicle.orientation();
        const r = rotation[v] as Float32Array;
        const o4 = currentFrame * 4;
        r[o4] = q.x;
        r[o4 + 1] = q.y;
        r[o4 + 2] = q.z;
        r[o4 + 3] = q.w;
      }
    };

    /** 每輪的資料由 applyWheelForces 旁路寫入；這裡只補車體層級的兩項。 */
    const recordVehicleDiagnostics = (currentFrame: number): void => {
      if (stadiumDist === null || flipCounter === null) return;
      for (let v = 0; v < vehicles.length; v += 1) {
        const com = (vehicles[v] as Vehicle).centerOfMass();
        (stadiumDist[v] as Float32Array)[currentFrame] = stadiumDistanceIn(
          arena.halfSegment,
          com.x,
          com.z,
        );
        (flipCounter[v] as Uint16Array)[currentFrame] = judge.flipFrames(v);
      }
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
    recordTrajectory(frame);

    // 第 0 幀（投入瞬間）也依約定檢查一次；合法的投擲參數不可能在此觸發任何條件。
    let outcome = judge.update(frame, vehicleA.judgeState(), vehicleB.judgeState());
    recordVehicleDiagnostics(frame);

    while (outcome === null && frame < TIMEOUT_FRAMES) {
      if (diagWriters !== null) {
        // 第 0 幀沒有輪力（力施加於 frame → frame+1 的推進），因此輪診斷自第 1 幀起記錄。
        (diagWriters[0] as WheelDiagnosticsWriter).frame = frame + 1;
        (diagWriters[1] as WheelDiagnosticsWriter).frame = frame + 1;
      }
      // ── 一個模擬幀 = substeps 次物理步（§第五輪）──────────────────────
      //
      // 幀的語意完全不變：checksum 取樣、判定、軌跡、TIMEOUT_FRAMES 全部仍以幀為單位。
      // 改變的只有幀內部積分多細。substeps = 1 時整段退化為原本的三行，位元不變。
      //
      // 每個子步都要重新算輪力：懸吊是 raycast，車體移動後接觸點就變了，
      // 沿用上一子步的力等於用過期的幾何積分，那正是 substep 要避免的事。
      for (let sub = 0; sub < substeps; sub += 1) {
        // 診斷只在最後一個子步寫入，代表該幀結束時的狀態；
        // 每個子步都寫會讓同一幀的資料被覆蓋 substeps 次，徒增成本。
        const writeDiag = sub === substeps - 1 ? diagWriters : null;
        vehicleA.applyWheelForces(world, physicsDt, writeDiag?.[0]);
        vehicleB.applyWheelForces(world, physicsDt, writeDiag?.[1]);

        world.step();

        // 每個子步只跨 JS↔wasm 邊界讀一次狀態。
        vehicleA.readState();
        vehicleB.readState();
      }
      frame += 1;

      // clamp 前先取樣，才能看見真實的速度峰值。
      sampleStats();
      vehicleA.clampVelocities();
      vehicleB.clampVelocities();

      outcome = judge.update(frame, vehicleA.judgeState(), vehicleB.judgeState());

      const isSampleFrame = frame % CHECKSUM_SAMPLE_INTERVAL === 0;
      if (isSampleFrame) recordChecksum();
      if (outcome !== null && !isSampleFrame) recordChecksum();
      recordDiagnostics(frame);
      recordTrajectory(frame);
      recordVehicleDiagnostics(frame);
    }

    // 理論上不可達：judge 在 frame === TIMEOUT_FRAMES 時必定回傳 DRAW/TIMEOUT。
    const finalOutcome = outcome ?? { result: 'DRAW' as const, reason: 'TIMEOUT' as const };

    const frameCount = frame + 1; // 含第 0 幀
    const trajectory: TrajectoryFrames | undefined =
      position === null || rotation === null
        ? undefined
        : {
            frameCount,
            position: position.map((a) => a.subarray(0, frameCount * 3)),
            rotation: rotation.map((a) => a.subarray(0, frameCount * 4)),
          };

    const diagnostics: TrajectoryDiagnostics | undefined =
      diagWriters === null || stadiumDist === null || flipCounter === null
        ? undefined
        : {
            wheelGrounded: diagWriters.map((w) => w.grounded.subarray(0, frameCount * 4)),
            normalForce: diagWriters.map((w) => w.normalForce.subarray(0, frameCount * 4)),
            tireForce: diagWriters.map((w) => w.tireForce.subarray(0, frameCount * 4 * 3)),
            contactPoint: diagWriters.map((w) => w.contactPoint.subarray(0, frameCount * 4 * 3)),
            stadiumDist: stadiumDist.map((a) => a.subarray(0, frameCount)),
            flipCounter: flipCounter.map((a) => a.subarray(0, frameCount)),
            localCenterOfMass: vehicles.map((v) => v.localCenterOfMass()),
          };

    return {
      result: finalOutcome.result,
      reason: finalOutcome.reason,
      frames: frame,
      checksums,
      ...(denseChecksums !== null ? { denseChecksums } : {}),
      ...(capturedState !== undefined ? { capturedState } : {}),
      ...(trajectory !== undefined ? { trajectory } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
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
