/**
 * 軌跡的組裝與 replay 檔的相容性檢查（§P1.3、§P1.4）。
 *
 * 這一層刻意**不在 `src/sim/` 內**：
 *   - `TrajectoryMeta.generatedAt` 需要牆上時間，而 §3.2 與 ESLint 規則禁止 `src/sim/` 讀取它
 *   - replay 檔的載入與相容性判斷是 replay 的職責，不是模擬的職責
 *
 * `src/sim/` 只吐出 frame 資料（`TrajectoryFrames`）與 `outcome`；meta 由這裡蓋章。
 * 本模組不做任何 I/O，也不接觸瀏覽器 API，因此渲染層與 `tools/` 都能直接使用。
 */

import {
  PHYSICS_CONSTANTS_SHA256,
  PHYSICS_VERSION,
  RAPIER_VERSION,
  RAPIER_WASM_SHA256,
  SPEC_VERSION,
} from '../data/version.js';
import { simulate } from '../sim/simulate.js';
import type {
  BattleInput,
  BattleReason,
  BattleResult,
  ThrowParams,
  TrajectoryDiagnostics,
} from '../sim/types.js';

// ──────────────────────────────────────────────────────────────────────────
// 型別
// ──────────────────────────────────────────────────────────────────────────

export type TrajectoryMeta = {
  physicsVersion: number;
  specVersion: string;
  rapierVersion: string;
  wasmSha256: string;
  seed: number;
  throwA: ThrowParams;
  throwB: ThrowParams;
  /** ISO 8601。**僅供人閱讀，不參與任何判定，也不進入任何比對。** */
  generatedAt: string;
};

export type TrajectoryOutcome = {
  result: BattleResult;
  reason: BattleReason;
  frames: number;
};

export type Trajectory = {
  meta: TrajectoryMeta;
  /** 含第 0 幀。 */
  frameCount: number;
  /** 索引 0 = 車 A，1 = 車 B；長度 frameCount * 3。 */
  position: Float32Array[];
  /** 索引 0 = 車 A，1 = 車 B；長度 frameCount * 4（四元數 x, y, z, w）。 */
  rotation: Float32Array[];
  diagnostics?: TrajectoryDiagnostics;
  outcome: TrajectoryOutcome;
};

/**
 * 存檔用的 replay 檔內容（約 1 KB）。
 *
 * **刻意只存 meta，不存軌跡本身** —— 播放時以其中的 seed 與投擲參數重新產生。
 * 這正是為什麼相容性檢查必須嚴格：軌跡不在檔案裡，唯一的重現保證就是「物理沒變」。
 */
export type ReplayFile = {
  kind: 'crush-gear-replay';
  meta: TrajectoryMeta;
};

// ──────────────────────────────────────────────────────────────────────────
// 產生
// ──────────────────────────────────────────────────────────────────────────

/** 目前這一版物理的識別資訊，供產生 meta 與相容性比對共用。 */
export function currentPhysicsIdentity(): {
  physicsVersion: number;
  specVersion: string;
  rapierVersion: string;
  wasmSha256: string;
  constantsSha256: string;
} {
  return {
    physicsVersion: PHYSICS_VERSION,
    specVersion: SPEC_VERSION,
    rapierVersion: RAPIER_VERSION,
    wasmSha256: RAPIER_WASM_SHA256,
    constantsSha256: PHYSICS_CONSTANTS_SHA256,
  };
}

export type GenerateOptions = {
  /** 一併記錄 §P1.5 的除錯資料（約 1.7 MB / 7200 幀）。預設 false。 */
  diagnostics?: boolean;
  /** 覆寫 `generatedAt`；不指定時取現在時刻。測試會指定以取得可重現的輸出。 */
  generatedAt?: string;
};

/**
 * 跑完一場戰鬥並組裝成可播放的 `Trajectory`。
 *
 * 播放器只會呼叫這個函式，**不會**自己持有 Rapier 世界或呼叫 `world.step()`（§P1.2.1）。
 */
export async function generateTrajectory(
  input: BattleInput,
  options: GenerateOptions = {},
): Promise<Trajectory> {
  const result = await simulate(input, {
    trajectory: true,
    ...(options.diagnostics === true ? { diagnostics: true } : {}),
  });

  const frames = result.trajectory;
  if (frames === undefined) {
    throw new Error('simulate() did not return trajectory frames despite trajectory: true.');
  }

  const identity = currentPhysicsIdentity();
  const trajectory: Trajectory = {
    meta: {
      physicsVersion: identity.physicsVersion,
      specVersion: identity.specVersion,
      rapierVersion: identity.rapierVersion,
      wasmSha256: identity.wasmSha256,
      seed: input.seed,
      throwA: { ...input.throwA },
      throwB: { ...input.throwB },
      generatedAt: options.generatedAt ?? new Date().toISOString(),
    },
    frameCount: frames.frameCount,
    position: frames.position,
    rotation: frames.rotation,
    outcome: {
      result: result.result,
      reason: result.reason,
      frames: result.frames,
    },
    ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
  };

  assertTrajectoryShape(trajectory);
  return trajectory;
}

/** 軌跡長度與 outcome 的一致性檢查；不符代表旁路記錄寫錯了，屬程式錯誤。 */
export function assertTrajectoryShape(t: Trajectory): void {
  if (t.frameCount !== t.outcome.frames + 1) {
    throw new Error(
      `Trajectory frameCount ${t.frameCount} does not match outcome.frames + 1 ` +
        `(${t.outcome.frames + 1}); the recorder and the loop disagree.`,
    );
  }
  for (let v = 0; v < 2; v += 1) {
    const p = t.position[v];
    const r = t.rotation[v];
    if (p === undefined || r === undefined) throw new Error(`Trajectory is missing vehicle ${v}.`);
    if (p.length !== t.frameCount * 3) {
      throw new Error(`Vehicle ${v} position length ${p.length} != ${t.frameCount * 3}.`);
    }
    if (r.length !== t.frameCount * 4) {
      throw new Error(`Vehicle ${v} rotation length ${r.length} != ${t.frameCount * 4}.`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// §P1.4.3 相容性
// ──────────────────────────────────────────────────────────────────────────

export type CompatibilityResult =
  | { compatible: true }
  | { compatible: false; reasons: string[]; message: string };

/**
 * 判斷一份 replay 檔能否以當前的物理重現。
 *
 * **任一欄位不符即拒絕重現。** 這不是保守，而是因為 replay 檔裡沒有軌跡 ——
 * 用不同版本的物理重跑會產生一場**結局可能完全不同**的戰鬥，
 * 卻讓使用者以為自己看到的是原本那一場。這是本專案最嚴重的失效模式之一，
 * 寧可拒絕播放。
 *
 * `generatedAt` 與投擲參數不參與比對（前者僅供人閱讀，後者是輸入而非物理版本）。
 */
export function checkCompatibility(meta: TrajectoryMeta): CompatibilityResult {
  const current = currentPhysicsIdentity();
  const reasons: string[] = [];

  if (meta.physicsVersion !== current.physicsVersion) {
    reasons.push(
      `physicsVersion: replay 為 ${meta.physicsVersion}，目前為 ${current.physicsVersion}`,
    );
  }
  if (meta.rapierVersion !== current.rapierVersion) {
    reasons.push(
      `rapierVersion: replay 為 ${meta.rapierVersion}，目前為 ${current.rapierVersion}`,
    );
  }
  if (meta.wasmSha256 !== current.wasmSha256) {
    reasons.push(
      `wasmSha256: replay 為 ${meta.wasmSha256.slice(0, 12)}…，` +
        `目前為 ${current.wasmSha256.slice(0, 12)}…`,
    );
  }

  if (reasons.length === 0) return { compatible: true };

  return {
    compatible: false,
    reasons,
    message:
      '這份 replay 是由不同版本的物理產生的，目前的版本無法重現同一場戰鬥。\n' +
      `${reasons.map((r) => `  · ${r}`).join('\n')}\n` +
      '重跑會得到一場結局可能完全不同的戰鬥，因此拒絕播放。',
  };
}

/** 由 `Trajectory` 產生可存檔的 replay 內容（只含 meta，約 1 KB）。 */
export function toReplayFile(trajectory: Trajectory): ReplayFile {
  return { kind: 'crush-gear-replay', meta: { ...trajectory.meta } };
}

const THROW_KEYS = ['x', 'z', 'y', 'yaw', 'pitch', 'speed', 'spin'] as const;

function parseThrow(value: unknown, what: string): ThrowParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of THROW_KEYS) {
    const raw = record[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(`${what}.${key} must be a finite number.`);
    }
    out[key] = raw;
  }
  return out as unknown as ThrowParams;
}

/** 解析 replay 檔的內容。結構不合法時拋錯；版本不符不在這裡判斷（見 checkCompatibility）。 */
export function parseReplayFile(value: unknown): ReplayFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Replay file must be a JSON object.');
  }
  const root = value as Record<string, unknown>;
  if (root['kind'] !== 'crush-gear-replay') {
    throw new Error('Not a crush-gear replay file (missing kind: "crush-gear-replay").');
  }
  const rawMeta = root['meta'];
  if (typeof rawMeta !== 'object' || rawMeta === null || Array.isArray(rawMeta)) {
    throw new Error('Replay file must contain a "meta" object.');
  }
  const m = rawMeta as Record<string, unknown>;

  const num = (key: string): number => {
    const v = m[key];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new Error(`meta.${key} must be an integer.`);
    }
    return v;
  };
  const str = (key: string): string => {
    const v = m[key];
    if (typeof v !== 'string') throw new Error(`meta.${key} must be a string.`);
    return v;
  };

  return {
    kind: 'crush-gear-replay',
    meta: {
      physicsVersion: num('physicsVersion'),
      specVersion: str('specVersion'),
      rapierVersion: str('rapierVersion'),
      wasmSha256: str('wasmSha256'),
      seed: num('seed'),
      throwA: parseThrow(m['throwA'], 'meta.throwA'),
      throwB: parseThrow(m['throwB'], 'meta.throwB'),
      generatedAt: typeof m['generatedAt'] === 'string' ? m['generatedAt'] : '',
    },
  };
}

/**
 * 載入一份 replay 並重現軌跡。版本不符時**拒絕產生**並拋出帶有說明的錯誤。
 */
export async function loadReplay(
  file: ReplayFile,
  options: GenerateOptions = {},
): Promise<Trajectory> {
  const compat = checkCompatibility(file.meta);
  if (!compat.compatible) {
    throw new IncompatibleReplayError(compat.message, compat.reasons);
  }
  return generateTrajectory(
    { seed: file.meta.seed, throwA: file.meta.throwA, throwB: file.meta.throwB },
    options,
  );
}

export class IncompatibleReplayError extends Error {
  readonly reasons: readonly string[];

  constructor(message: string, reasons: readonly string[]) {
    super(message);
    this.name = 'IncompatibleReplayError';
    this.reasons = reasons;
  }
}
