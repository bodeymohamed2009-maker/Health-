import type {
  AwbTelemetry,
  CaptureMode,
  PoincarePoint,
  RespStatus,
  RgbSample,
  RppgAlgorithm,
  RppgMetrics,
  SignalQualityState,
  SpectrumBin,
} from "../types/rppg";

const TARGET_FS = 30;
const RESP_FS = 4;
const MIN_SECONDS_FOR_ESTIMATE = 5.0;
const MIN_SECONDS_FOR_RESPIRATION = 10.0;
const MAX_CARDIAC_WINDOW_SECONDS = 12.0;
const MAX_RESP_WINDOW_SECONDS = 30.0;

function mean(arr: Float64Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return arr.length > 0 ? sum / arr.length : 0;
}

function stdDev(arr: Float64Array | number[], mu?: number): number {
  if (arr.length < 2) return 0;
  const m = mu ?? mean(arr);
  let acc = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    acc += d * d;
  }
  return Math.sqrt(acc / arr.length);
}

/**
 * 2-State Velocity-Aware 1D Kalman Heart-Rate Tracker [bpm, velocity]
 * with rolling median deglitching, SNR-adaptive noise, and motion-artifact gating.
 */
export class KalmanBpmTracker {
  private x: number | null = null; // estimated BPM
  private v = 0; // BPM rate of change per update
  private p = 100; // error covariance
  private recentMeasurements: number[] = [];

  public reset(): void {
    this.x = null;
    this.v = 0;
    this.p = 100;
    this.recentMeasurements = [];
  }

  public getEstimate(): number | null {
    return this.x;
  }

  public isLocked(): boolean {
    return this.x !== null && this.p < 6.5;
  }

  public update(
    measuredBpm: number | null,
    snrDb: number,
    isMotionArtifact: boolean
  ): number | null {
    if (measuredBpm === null) {
      return this.x !== null ? Math.round(this.x) : null;
    }

    if (this.x === null) {
      this.x = measuredBpm;
      this.v = 0;
      this.p = 8;
      this.recentMeasurements = [measuredBpm];
      return Math.round(this.x);
    }

    // Freeze state update during sudden motion spikes if already locked
    if (isMotionArtifact) {
      this.p = Math.min(8, this.p + 0.15);
      return Math.round(this.x);
    }

    // Rolling median-of-5 deglitching stops 1-frame FFT jumps from perturbing lock
    this.recentMeasurements.push(measuredBpm);
    if (this.recentMeasurements.length > 5) {
      this.recentMeasurements.shift();
    }
    const sorted = [...this.recentMeasurements].sort((a, b) => a - b);
    const medBpm = sorted[Math.floor(sorted.length / 2)];
    const stabilizedMeas =
      this.recentMeasurements.length >= 3
        ? 0.65 * medBpm + 0.35 * measuredBpm
        : measuredBpm;

    // Predict step with gentle damped velocity prior
    const predicted = this.x + this.v * 0.35;
    const Q = 0.36;
    this.p = Math.min(18, this.p + Q);

    // Measurement noise R scales inversely with SNR quality
    const clampedSnr = Math.max(0.6, Math.min(22, snrDb));
    const R = 18 / Math.pow(clampedSnr, 1.25);

    // Reject sudden outlier jumps when already locked unless SNR is exceptionally strong
    const jumpLimit = this.p < 4 ? 18 : 24;
    if (Math.abs(stabilizedMeas - predicted) > jumpLimit && snrDb < 8.5) {
      return Math.round(this.x);
    }

    const K = this.p / (this.p + R);
    const innovation = stabilizedMeas - predicted;
    this.x = predicted + K * innovation;
    this.v = Math.max(-1.6, Math.min(1.6, this.v * 0.55 + K * innovation * 0.30));
    this.p = (1 - K) * this.p;

    return Math.round(this.x);
  }
}

/**
 * Stateful 1D Kalman Respiration & Adaptive Breath-Hold Hysteresis Tracker.
 * Combines a velocity-damped Kalman filter for steady BrPM (6..34 BrPM) with an
 * asymmetric personal baseline and Schmitt-trigger state machine to eliminate
 * breath-hold flickering on noisy webcams.
 */
export class RespirationTracker {
  private brpm: number | null = null;
  private brpmVel = 0;
  private brpmCov = 64;
  private recentBrpm: number[] = [];

  private baselineEnv = 0;
  private baselineCardiacEnv = 0;
  private inBreathHold = false;
  private holdEnterStreak = 0;
  private holdExitStreak = 0;
  private holdStartMs = 0;

  public reset(): void {
    this.brpm = null;
    this.brpmVel = 0;
    this.brpmCov = 64;
    this.recentBrpm = [];
    this.baselineEnv = 0;
    this.baselineCardiacEnv = 0;
    this.inBreathHold = false;
    this.holdEnterStreak = 0;
    this.holdExitStreak = 0;
    this.holdStartMs = 0;
  }

  public getEstimate(): number | null {
    return this.brpm !== null ? Math.round(this.brpm) : null;
  }

  public isLocked(): boolean {
    return this.brpm !== null && this.brpmCov < 5.0;
  }

  public getLearnedBaseline(): { env: number; cardiacEnv: number } {
    return { env: this.baselineEnv, cardiacEnv: this.baselineCardiacEnv };
  }

  public updateHoldState(params: {
    durationSec: number;
    nowMs: number;
    holdScore: number;
    recentEnv: number;
    recentCardiacEnv: number;
    recentSnrDb: number;
    recentPeriodicity: number;
    rawHoldSec: number;
    signalBlocked: boolean;
  }): { isHold: boolean; holdSeconds: number } {
    const {
      durationSec,
      nowMs,
      holdScore,
      recentEnv,
      recentCardiacEnv,
      recentSnrDb,
      recentPeriodicity,
      rawHoldSec,
      signalBlocked,
    } = params;

    if (signalBlocked || durationSec < 7.5) {
      if (signalBlocked) {
        this.holdEnterStreak = 0;
      }
      return { isHold: false, holdSeconds: 0 };
    }

    // Learn personal breathing baseline ONLY during verified rhythmic breathing
    if (!this.inBreathHold && recentPeriodicity >= 0.34 && recentSnrDb >= 0.5 && holdScore < 0.42) {
      if (this.baselineEnv <= 0) {
        this.baselineEnv = recentEnv;
        this.baselineCardiacEnv = recentCardiacEnv;
      } else {
        // Asymmetric EMA: adapts faster upward to normal breathing, very slow downward so holds don't corrupt it
        const alphaEnv = recentEnv >= this.baselineEnv ? 0.16 : 0.025;
        const alphaCard = recentCardiacEnv >= this.baselineCardiacEnv ? 0.16 : 0.025;
        this.baselineEnv = this.baselineEnv * (1 - alphaEnv) + recentEnv * alphaEnv;
        this.baselineCardiacEnv =
          this.baselineCardiacEnv * (1 - alphaCard) + recentCardiacEnv * alphaCard;
      }
    }

    if (!this.inBreathHold) {
      if (holdScore >= 0.56) {
        this.holdEnterStreak++;
      } else {
        this.holdEnterStreak = Math.max(0, this.holdEnterStreak - 1);
      }

      if (this.holdEnterStreak >= 2 || holdScore >= 0.76) {
        this.inBreathHold = true;
        this.holdExitStreak = 0;
        this.holdStartMs = nowMs - Math.max(3.5, rawHoldSec) * 1000;
      }
    } else {
      // Hysteresis exit: stay locked in breath_hold until sustained genuine rhythmic breathing & amplitude return
      const minRecoveredEnv =
        this.baselineCardiacEnv > 0.35
          ? Math.max(0.30, this.baselineCardiacEnv * 0.46)
          : 0.32;
      const strongBreathingResumed =
        holdScore < 0.38 &&
        recentPeriodicity >= 0.34 &&
        recentSnrDb >= 0.6 &&
        recentCardiacEnv >= minRecoveredEnv;
      if (strongBreathingResumed) {
        this.holdExitStreak++;
        if (this.holdExitStreak >= 3) {
          this.inBreathHold = false;
          this.holdEnterStreak = 0;
          this.holdExitStreak = 0;
        }
      } else {
        this.holdExitStreak = 0;
      }
    }

    if (!this.inBreathHold) {
      return { isHold: false, holdSeconds: 0 };
    }

    const elapsedHold = Math.max(
      rawHoldSec,
      (nowMs - this.holdStartMs) / 1000
    );
    return {
      isHold: true,
      holdSeconds: Number(Math.max(3.5, elapsedHold).toFixed(1)),
    };
  }

  public updateBrpm(
    measuredBrpm: number | null,
    snrDb: number,
    periodicity: number,
    isMotionArtifact: boolean,
    isHold: boolean
  ): number | null {
    if (isHold) {
      return null;
    }
    if (measuredBrpm === null || measuredBrpm < 6 || measuredBrpm > 34) {
      return this.brpm !== null ? Math.round(this.brpm) : null;
    }

    if (this.brpm === null) {
      this.brpm = measuredBrpm;
      this.brpmVel = 0;
      this.brpmCov = 6;
      this.recentBrpm = [measuredBrpm];
      return Math.round(this.brpm);
    }

    if (isMotionArtifact) {
      this.brpmCov = Math.min(8, this.brpmCov + 0.15);
      return Math.round(this.brpm);
    }

    this.recentBrpm.push(measuredBrpm);
    if (this.recentBrpm.length > 5) {
      this.recentBrpm.shift();
    }
    const sorted = [...this.recentBrpm].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const stabilized =
      this.recentBrpm.length >= 3 ? 0.65 * med + 0.35 * measuredBrpm : measuredBrpm;

    const predicted = this.brpm + this.brpmVel * 0.3;
    const Q = 0.18;
    this.brpmCov = Math.min(10, this.brpmCov + Q);

    const quality = Math.max(0.4, Math.min(18, snrDb + periodicity * 6));
    const R = 10 / Math.pow(quality, 1.15);

    if (Math.abs(stabilized - predicted) > 7 && snrDb < 5.0) {
      return Math.round(this.brpm);
    }

    const K = this.brpmCov / (this.brpmCov + R);
    const innov = stabilized - predicted;
    this.brpm = Math.max(6, Math.min(34, predicted + K * innov));
    this.brpmVel = Math.max(-0.8, Math.min(0.8, this.brpmVel * 0.5 + K * innov * 0.25));
    this.brpmCov = (1 - K) * this.brpmCov;

    return Math.round(this.brpm);
  }
}

/**
 * Adaptive NLMS (Normalized Least-Mean-Squares) Ambient Flicker Canceller.
 * Subtracts correlated background illumination fluctuations (LED 50/60Hz aliasing,
 * screen brightness shifts) from facial skin channels while preserving capillary pulse.
 */
function applyNlmsAmbientCancel(
  skin: Float64Array,
  bgRef: Float64Array,
  taps = 5,
  mu = 0.08
): { cleaned: Float64Array; reductionDb: number } {
  const N = skin.length;
  if (N <= taps + 4 || bgRef.length !== N) {
    return { cleaned: skin, reductionDb: 0 };
  }

  const mSkin = mean(skin) || 1;
  const mBg = mean(bgRef) || 1;

  // Work on AC variations around temporal mean
  const d = new Float64Array(N);
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    d[i] = skin[i] - mSkin;
    x[i] = bgRef[i] - mBg;
  }

  const stdBg = stdDev(x);
  if (stdBg < 0.05) {
    // Background illumination is already rock-steady
    return { cleaned: skin, reductionDb: 0 };
  }

  // Least-squares zero-lag warm-start eliminates cold-start transient on the first 60–90 frames
  let covDX = 0;
  let varX = 1e-6;
  for (let i = 0; i < N; i++) {
    covDX += d[i] * x[i];
    varX += x[i] * x[i];
  }
  const w = new Float64Array(taps);
  w[0] = Math.max(-0.25, Math.min(1.5, covDX / varX));

  // Pre-train weights on backward pass so tap coefficients stabilize before sample 0
  for (let n = N - 1; n >= 0; n--) {
    let yHat = 0;
    let normSq = 1e-4;
    for (let k = 0; k < taps; k++) {
      const xk = n + k < N ? x[n + k] : 0;
      yHat += w[k] * xk;
      normSq += xk * xk;
    }
    const err = d[n] - yHat;
    const step = (mu * 0.65 * err) / normSq;
    for (let k = 0; k < taps; k++) {
      const xk = n + k < N ? x[n + k] : 0;
      w[k] = Math.max(-1.6, Math.min(1.6, w[k] * 0.999 + step * xk));
    }
  }

  const cleaned = new Float64Array(N);
  let rawPower = 0;
  let cleanPower = 0;

  for (let n = 0; n < N; n++) {
    let yHat = 0;
    let normSq = 1e-4;
    for (let k = 0; k < taps; k++) {
      const xk = n - k >= 0 ? x[n - k] : 0;
      yHat += w[k] * xk;
      normSq += xk * xk;
    }

    const err = d[n] - yHat;
    const step = (mu * err) / normSq;
    for (let k = 0; k < taps; k++) {
      const xk = n - k >= 0 ? x[n - k] : 0;
      w[k] = Math.max(-1.6, Math.min(1.6, w[k] * 0.9995 + step * xk));
    }

    cleaned[n] = mSkin + err;
    rawPower += d[n] * d[n];
    cleanPower += err * err;
  }

  const ratio = rawPower > 1e-9 && cleanPower > 1e-9 ? rawPower / cleanPower : 1;
  const reductionDb = Math.max(
    0,
    Math.min(18, Number((10 * Math.log10(ratio)).toFixed(1)))
  );

  return { cleaned, reductionDb };
}

function hampelDespike(arr: Float64Array, halfWin = 3, nSigma = 3.5): Float64Array {
  const N = arr.length;
  if (N < halfWin * 2 + 1) return arr;
  const out = new Float64Array(arr);
  const windowVals = new Array<number>(halfWin * 2 + 1);

  for (let i = halfWin; i < N - halfWin; i++) {
    let idx = 0;
    for (let k = -halfWin; k <= halfWin; k++) {
      windowVals[idx++] = arr[i + k];
    }
    const sorted = [...windowVals].sort((a, b) => a - b);
    const med = sorted[halfWin];
    const devs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = devs[halfWin] * 1.4826;
    if (mad > 1e-6 && Math.abs(arr[i] - med) > nSigma * mad) {
      out[i] = med;
    }
  }
  return out;
}

function estimateCctFromRgb(r: number, g: number, b: number): number {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const sum = X + Y + Z;
  if (sum <= 1e-6) return 5500;
  const x = X / sum;
  const y = Y / sum;
  const denom = 0.1858 - y;
  if (Math.abs(denom) < 1e-4) return 5500;
  const n = (x - 0.332) / denom;
  const cct = 449 * n * n * n + 3525 * n * n + 6823.3 * n + 5520.33;
  return Math.round(Math.max(2200, Math.min(9500, cct)));
}

function zeroPhaseEma(arr: Float64Array, alpha = 0.09): Float64Array {
  const N = arr.length;
  if (N < 4) return new Float64Array(arr);
  const fwd = new Float64Array(N);
  fwd[0] = arr[0];
  for (let i = 1; i < N; i++) {
    fwd[i] = fwd[i - 1] * (1 - alpha) + arr[i] * alpha;
  }
  const bwd = new Float64Array(N);
  bwd[N - 1] = fwd[N - 1];
  for (let i = N - 2; i >= 0; i--) {
    bwd[i] = bwd[i + 1] * (1 - alpha) + fwd[i] * alpha;
  }
  return bwd;
}

function computeVonKriesGains(
  bgR: Float64Array,
  bgG: Float64Array,
  bgB: Float64Array
): {
  gainR: Float64Array;
  gainG: Float64Array;
  gainB: Float64Array;
  lastGainR: number;
  lastGainG: number;
  lastGainB: number;
  lastCctK: number;
} {
  const N = bgR.length;
  const sR = zeroPhaseEma(bgR, 0.12);
  const sG = zeroPhaseEma(bgG, 0.12);
  const sB = zeroPhaseEma(bgB, 0.12);

  const meanGray = (mean(sR) + mean(sG) + mean(sB)) / 3 || 128;

  const gainR = new Float64Array(N);
  const gainG = new Float64Array(N);
  const gainB = new Float64Array(N);
  const clampGain = (v: number) => Math.max(0.55, Math.min(1.85, v));

  for (let i = 0; i < N; i++) {
    gainR[i] = clampGain(meanGray / Math.max(12, sR[i]));
    gainG[i] = clampGain(meanGray / Math.max(12, sG[i]));
    gainB[i] = clampGain(meanGray / Math.max(12, sB[i]));
  }

  const last = Math.max(0, N - 1);
  return {
    gainR,
    gainG,
    gainB,
    lastGainR: Number((gainR[last] ?? 1).toFixed(2)),
    lastGainG: Number((gainG[last] ?? 1).toFixed(2)),
    lastGainB: Number((gainB[last] ?? 1).toFixed(2)),
    lastCctK: estimateCctFromRgb(sR[last] ?? 128, sG[last] ?? 128, sB[last] ?? 128),
  };
}

function computeChromaticityVariance(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array
): number {
  const N = r.length;
  if (N < 4) return 0;
  const rgRatio = new Float64Array(N);
  const bgRatio = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const sum = Math.max(1, r[i] + g[i] + b[i]);
    rgRatio[i] = r[i] / sum;
    bgRatio[i] = b[i] / sum;
  }
  const v1 = stdDev(rgRatio);
  const v2 = stdDev(bgRatio);
  return v1 * v1 + v2 * v2;
}

interface UniformChannels {
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  bgR: Float64Array;
  bgG: Float64Array;
  bgB: Float64Array;
  forehead?: { r: Float64Array; g: Float64Array; b: Float64Array; validRatio: number };
  leftCheek?: { r: Float64Array; g: Float64Array; b: Float64Array; validRatio: number };
  rightCheek?: { r: Float64Array; g: Float64Array; b: Float64Array; validRatio: number };
  durationSec: number;
  ambientCanceledDb: number;
  awb: AwbTelemetry;
}

function resampleUniform(
  samples: RgbSample[],
  fs: number,
  maxSeconds: number,
  enableNlms: boolean,
  enableAwb: boolean,
  mode: CaptureMode
): UniformChannels {
  const defaultAwb: AwbTelemetry = {
    enabled: enableAwb && mode !== "finger",
    gainR: 1,
    gainG: 1,
    gainB: 1,
    colorTempK: 5500,
    driftReducedPct: 0,
  };

  const n = samples.length;
  if (n < 4) {
    return {
      r: new Float64Array(0),
      g: new Float64Array(0),
      b: new Float64Array(0),
      bgR: new Float64Array(0),
      bgG: new Float64Array(0),
      bgB: new Float64Array(0),
      durationSec: 0,
      ambientCanceledDb: 0,
      awb: defaultAwb,
    };
  }

  const tEnd = samples[n - 1].t;
  const totalSpanSec = (tEnd - samples[0].t) / 1000;
  const usedSec = Math.min(totalSpanSec, maxSeconds);
  const tStart = tEnd - usedSec * 1000;

  const outLen = Math.floor(usedSec * fs);
  if (outLen < 16) {
    return {
      r: new Float64Array(0),
      g: new Float64Array(0),
      b: new Float64Array(0),
      bgR: new Float64Array(0),
      bgG: new Float64Array(0),
      bgB: new Float64Array(0),
      durationSec: usedSec,
      ambientCanceledDb: 0,
      awb: defaultAwb,
    };
  }

  const rOut = new Float64Array(outLen);
  const gOut = new Float64Array(outLen);
  const bOut = new Float64Array(outLen);
  const bgROut = new Float64Array(outLen);
  const bgGOut = new Float64Array(outLen);
  const bgBOut = new Float64Array(outLen);

  const hasRegions = Boolean(samples[n - 1].regions);
  const fhR = hasRegions ? new Float64Array(outLen) : undefined;
  const fhG = hasRegions ? new Float64Array(outLen) : undefined;
  const fhB = hasRegions ? new Float64Array(outLen) : undefined;
  const lcR = hasRegions ? new Float64Array(outLen) : undefined;
  const lcG = hasRegions ? new Float64Array(outLen) : undefined;
  const lcB = hasRegions ? new Float64Array(outLen) : undefined;
  const rcR = hasRegions ? new Float64Array(outLen) : undefined;
  const rcG = hasRegions ? new Float64Array(outLen) : undefined;
  const rcB = hasRegions ? new Float64Array(outLen) : undefined;

  let fhValid = 0;
  let lcValid = 0;
  let rcValid = 0;

  const catmullRom = (
    p0: number,
    p1: number,
    p2: number,
    p3: number,
    t: number
  ): number => {
    const t2 = t * t;
    const t3 = t2 * t;
    const val =
      0.5 *
      (2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    const lo = Math.min(p1, p2);
    const hi = Math.max(p1, p2);
    const margin = (hi - lo) * 0.15;
    return Math.max(lo - margin, Math.min(hi + margin, val));
  };

  const motionOut = new Float64Array(outLen);
  let srcIdx = 0;
  const dtMs = 1000 / fs;

  for (let i = 0; i < outLen; i++) {
    const tTarget = tStart + i * dtMs;
    while (srcIdx < n - 2 && samples[srcIdx + 1].t < tTarget) {
      srcIdx++;
    }
    const i0 = Math.max(0, srcIdx - 1);
    const i1 = srcIdx;
    const i2 = Math.min(n - 1, srcIdx + 1);
    const i3 = Math.min(n - 1, srcIdx + 2);
    const s0 = samples[i0];
    const s1 = samples[i1];
    const s2 = samples[i2];
    const s3 = samples[i3];
    const span = s2.t - s1.t;
    const alpha =
      span > 0.001 ? Math.max(0, Math.min(1, (tTarget - s1.t) / span)) : 0;

    rOut[i] = catmullRom(s0.r, s1.r, s2.r, s3.r, alpha);
    gOut[i] = catmullRom(s0.g, s1.g, s2.g, s3.g, alpha);
    bOut[i] = catmullRom(s0.b, s1.b, s2.b, s3.b, alpha);
    motionOut[i] = s1.motion + alpha * (s2.motion - s1.motion);

    const b0R = s1.bgR ?? 128;
    const b1R = s2.bgR ?? 128;
    const b0G = s1.bgG ?? 128;
    const b1G = s2.bgG ?? 128;
    const b0B = s1.bgB ?? 128;
    const b1B = s2.bgB ?? 128;

    bgROut[i] = b0R + alpha * (b1R - b0R);
    bgGOut[i] = b0G + alpha * (b1G - b0G);
    bgBOut[i] = b0B + alpha * (b1B - b0B);

    if (hasRegions && fhR && fhG && fhB && lcR && lcG && lcB && rcR && rcG && rcB) {
      const pickReg = (
        s: RgbSample,
        key: "forehead" | "leftCheek" | "rightCheek"
      ) => {
        const reg = s.regions?.[key];
        return reg?.valid ? reg : { r: s.r, g: s.g, b: s.b, valid: false };
      };

      const f0 = pickReg(s0, "forehead");
      const f1 = pickReg(s1, "forehead");
      const f2 = pickReg(s2, "forehead");
      const f3 = pickReg(s3, "forehead");
      if (f1.valid || f2.valid) fhValid++;
      fhR[i] = catmullRom(f0.r, f1.r, f2.r, f3.r, alpha);
      fhG[i] = catmullRom(f0.g, f1.g, f2.g, f3.g, alpha);
      fhB[i] = catmullRom(f0.b, f1.b, f2.b, f3.b, alpha);

      const l0 = pickReg(s0, "leftCheek");
      const l1 = pickReg(s1, "leftCheek");
      const l2 = pickReg(s2, "leftCheek");
      const l3 = pickReg(s3, "leftCheek");
      if (l1.valid || l2.valid) lcValid++;
      lcR[i] = catmullRom(l0.r, l1.r, l2.r, l3.r, alpha);
      lcG[i] = catmullRom(l0.g, l1.g, l2.g, l3.g, alpha);
      lcB[i] = catmullRom(l0.b, l1.b, l2.b, l3.b, alpha);

      const r0 = pickReg(s0, "rightCheek");
      const r1 = pickReg(s1, "rightCheek");
      const r2 = pickReg(s2, "rightCheek");
      const r3 = pickReg(s3, "rightCheek");
      if (r1.valid || r2.valid) rcValid++;
      rcR[i] = catmullRom(r0.r, r1.r, r2.r, r3.r, alpha);
      rcG[i] = catmullRom(r0.g, r1.g, r2.g, r3.g, alpha);
      rcB[i] = catmullRom(r0.b, r1.b, r2.b, r3.b, alpha);
    }
  }

  // Suppress isolated transient motion bursts (e.g. blinks/nods) via local clean-anchor interpolation
  if (outLen > 12) {
    const sortedMot = Array.from(motionOut).sort((a, b) => a - b);
    const medMot = sortedMot[Math.floor(sortedMot.length / 2)];
    const burstThresh = Math.max(9.5, medMot * 2.8);

    const isBad = new Uint8Array(outLen);
    let badCount = 0;
    for (let i = 0; i < outLen; i++) {
      if (motionOut[i] > burstThresh) {
        isBad[i] = 1;
        badCount++;
      }
    }

    // Only repair transient bursts (<35% of window) so genuine global motion stays flagged
    if (badCount > 0 && badCount < outLen * 0.35) {
      const repairBurst = (arr: Float64Array) => {
        let i = 0;
        while (i < outLen) {
          if (!isBad[i]) {
            i++;
            continue;
          }
          const start = i;
          while (i < outLen && isBad[i]) i++;
          const end = i - 1;
          if (end - start + 1 > Math.round(fs * 0.7)) continue;
          const prevClean = Math.max(0, start - 1);
          const nextClean = Math.min(outLen - 1, end + 1);
          if (isBad[prevClean] || isBad[nextClean]) continue;
          const span = nextClean - prevClean || 1;
          for (let k = start; k <= end; k++) {
            const t = (k - prevClean) / span;
            const interp = arr[prevClean] + t * (arr[nextClean] - arr[prevClean]);
            arr[k] = arr[k] * 0.25 + interp * 0.75;
          }
        }
      };

      repairBurst(rOut);
      repairBurst(gOut);
      repairBurst(bOut);
      if (fhR && fhG && fhB && lcR && lcG && lcB && rcR && rcG && rcB) {
        repairBurst(fhR);
        repairBurst(fhG);
        repairBurst(fhB);
        repairBurst(lcR);
        repairBurst(lcG);
        repairBurst(lcB);
        repairBurst(rcR);
        repairBurst(rcG);
        repairBurst(rcB);
      }
    }
  }

  // Apply Temporal Von Kries AWB before Hampel & NLMS when not already applied at frame level
  const latestAwbSample = samples[n - 1].awb;
  const frameAlreadyAwbApplied = Boolean(latestAwbSample?.applied);

  let awbTelemetry: AwbTelemetry = {
    enabled: enableAwb && mode !== "finger",
    gainR: latestAwbSample?.gainR ?? 1,
    gainG: latestAwbSample?.gainG ?? 1,
    gainB: latestAwbSample?.gainB ?? 1,
    colorTempK:
      latestAwbSample?.colorTempK ??
      estimateCctFromRgb(
        mean(bgROut) || 128,
        mean(bgGOut) || 128,
        mean(bgBOut) || 128
      ),
    driftReducedPct: 0,
  };

  if (enableAwb && mode !== "finger" && !frameAlreadyAwbApplied) {
    const gains = computeVonKriesGains(bgROut, bgGOut, bgBOut);
    const varBefore = computeChromaticityVariance(rOut, gOut, bOut);

    const applyGains = (
      arrR: Float64Array,
      arrG: Float64Array,
      arrB: Float64Array
    ) => {
      for (let i = 0; i < outLen; i++) {
        arrR[i] = Math.min(255, arrR[i] * gains.gainR[i]);
        arrG[i] = Math.min(255, arrG[i] * gains.gainG[i]);
        arrB[i] = Math.min(255, arrB[i] * gains.gainB[i]);
      }
    };

    applyGains(rOut, gOut, bOut);
    applyGains(bgROut, bgGOut, bgBOut);
    if (fhR && fhG && fhB && lcR && lcG && lcB && rcR && rcG && rcB) {
      applyGains(fhR, fhG, fhB);
      applyGains(lcR, lcG, lcB);
      applyGains(rcR, rcG, rcB);
    }

    const varAfter = computeChromaticityVariance(rOut, gOut, bOut);
    const driftReducedPct =
      varBefore > 1e-9
        ? Math.max(0, Math.min(99, Math.round(((varBefore - varAfter) / varBefore) * 100)))
        : 0;

    awbTelemetry = {
      enabled: true,
      gainR: gains.lastGainR,
      gainG: gains.lastGainG,
      gainB: gains.lastGainB,
      colorTempK: gains.lastCctK,
      driftReducedPct,
    };
  } else if (enableAwb && mode !== "finger" && frameAlreadyAwbApplied && latestAwbSample) {
    const dev =
      (Math.abs(latestAwbSample.gainR - 1) +
        Math.abs(latestAwbSample.gainG - 1) +
        Math.abs(latestAwbSample.gainB - 1)) /
      3;
    awbTelemetry.driftReducedPct = Math.max(0, Math.min(95, Math.round(dev * 240)));
  }

  let rClean = hampelDespike(rOut);
  let gClean = hampelDespike(gOut);
  let bClean = hampelDespike(bOut);
  let ambientCanceledDb = 0;

  const cleanChannelPair = (
    cR: Float64Array,
    cG: Float64Array,
    cB: Float64Array
  ) => {
    const dR = hampelDespike(cR);
    const dG = hampelDespike(cG);
    const dB = hampelDespike(cB);
    if (!enableNlms || mode === "finger") {
      return { r: dR, g: dG, b: dB, redDb: 0 };
    }
    const nR = applyNlmsAmbientCancel(dR, bgROut);
    const nG = applyNlmsAmbientCancel(dG, bgGOut);
    const nB = applyNlmsAmbientCancel(dB, bgBOut);
    return { r: nR.cleaned, g: nG.cleaned, b: nB.cleaned, redDb: nG.reductionDb };
  };

  if (enableNlms && mode !== "finger") {
    const resMain = cleanChannelPair(rClean, gClean, bClean);
    rClean = resMain.r;
    gClean = resMain.g;
    bClean = resMain.b;
    ambientCanceledDb = resMain.redDb;
  }

  const fhCleaned =
    fhR && fhG && fhB ? cleanChannelPair(fhR, fhG, fhB) : undefined;
  const lcCleaned =
    lcR && lcG && lcB ? cleanChannelPair(lcR, lcG, lcB) : undefined;
  const rcCleaned =
    rcR && rcG && rcB ? cleanChannelPair(rcR, rcG, rcB) : undefined;

  return {
    r: rClean,
    g: gClean,
    b: bClean,
    bgR: bgROut,
    bgG: bgGOut,
    bgB: bgBOut,
    forehead: fhCleaned
      ? { r: fhCleaned.r, g: fhCleaned.g, b: fhCleaned.b, validRatio: fhValid / outLen }
      : undefined,
    leftCheek: lcCleaned
      ? { r: lcCleaned.r, g: lcCleaned.g, b: lcCleaned.b, validRatio: lcValid / outLen }
      : undefined,
    rightCheek: rcCleaned
      ? { r: rcCleaned.r, g: rcCleaned.g, b: rcCleaned.b, validRatio: rcValid / outLen }
      : undefined,
    durationSec: usedSec,
    ambientCanceledDb,
    awb: awbTelemetry,
  };
}

function extractPosSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  fs: number
): Float64Array {
  const N = r.length;
  const H = new Float64Array(N);
  const weightSum = new Float64Array(N);
  const winLen = Math.max(24, Math.round(1.6 * fs));

  if (N <= winLen) {
    const mr = mean(r) || 1;
    const mg = mean(g) || 1;
    const mb = mean(b) || 1;
    const s1 = new Float64Array(N);
    const s2 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const rn = r[i] / mr - 1;
      const gn = g[i] / mg - 1;
      const bn = b[i] / mb - 1;
      s1[i] = gn - bn;
      s2[i] = gn + bn - 2 * rn;
    }
    const alpha = stdDev(s1) / (stdDev(s2) || 1e-6);
    for (let i = 0; i < N; i++) H[i] = s1[i] + alpha * s2[i];
    return H;
  }

  for (let start = 0; start <= N - winLen; start++) {
    let mr = 0,
      mg = 0,
      mb = 0;
    for (let j = 0; j < winLen; j++) {
      mr += r[start + j];
      mg += g[start + j];
      mb += b[start + j];
    }
    mr = mr / winLen || 1;
    mg = mg / winLen || 1;
    mb = mb / winLen || 1;

    const s1 = new Float64Array(winLen);
    const s2 = new Float64Array(winLen);
    for (let j = 0; j < winLen; j++) {
      const rn = r[start + j] / mr - 1;
      const gn = g[start + j] / mg - 1;
      const bn = b[start + j] / mb - 1;
      s1[j] = gn - bn;
      s2[j] = gn + bn - 2 * rn;
    }

    const alpha = stdDev(s1) / (stdDev(s2) || 1e-6);
    for (let j = 0; j < winLen; j++) {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * j) / (winLen - 1));
      H[start + j] += w * (s1[j] + alpha * s2[j]);
      weightSum[start + j] += w;
    }
  }

  for (let i = 0; i < N; i++) {
    if (weightSum[i] > 1e-6) {
      H[i] /= weightSum[i];
    }
  }
  return H;
}

function extractChromSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  fs: number
): Float64Array {
  const N = r.length;
  const out = new Float64Array(N);
  const weightSum = new Float64Array(N);
  const winLen = Math.max(24, Math.round(1.6 * fs));

  const processSegment = (start: number, len: number) => {
    let mr = 0,
      mg = 0,
      mb = 0;
    for (let j = 0; j < len; j++) {
      mr += r[start + j];
      mg += g[start + j];
      mb += b[start + j];
    }
    mr = mr / len || 1;
    mg = mg / len || 1;
    mb = mb / len || 1;

    const xs = new Float64Array(len);
    const ys = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      const rn = r[start + j] / mr - 1;
      const gn = g[start + j] / mg - 1;
      const bn = b[start + j] / mb - 1;
      xs[j] = 3 * rn - 2 * gn;
      ys[j] = 1.5 * rn + gn - 1.5 * bn;
    }
    const alpha = stdDev(xs) / (stdDev(ys) || 1e-6);
    for (let j = 0; j < len; j++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * j) / (len - 1)));
      const w = Math.max(0.05, hann);
      out[start + j] += w * (xs[j] - alpha * ys[j]);
      weightSum[start + j] += w;
    }
  };

  if (N <= winLen) {
    processSegment(0, N);
    for (let i = 0; i < N; i++) {
      if (weightSum[i] > 1e-6) out[i] /= weightSum[i];
    }
    return out;
  }

  const step = Math.max(1, Math.floor(winLen / 4));
  for (let start = 0; start <= N - winLen; start += step) {
    processSegment(start, winLen);
  }
  if ((N - winLen) % step !== 0) {
    processSegment(N - winLen, winLen);
  }
  for (let i = 0; i < N; i++) {
    if (weightSum[i] > 1e-6) {
      out[i] /= weightSum[i];
    }
  }
  return out;
}

function extractGreenSignal(
  r: Float64Array,
  g: Float64Array,
  mode: CaptureMode
): Float64Array {
  const N = g.length;
  const out = new Float64Array(N);
  const mg = mean(g) || 1;
  const mr = mean(r) || 1;

  // In finger contact mode with flash ON, high red intensity (>238) approaches sensor saturation;
  // adaptively blend more Green channel (higher hemoglobin absorption contrast) as red approaches 255.
  const satBlend =
    mode === "finger" ? Math.max(0, Math.min(1, (mr - 228) / 24)) : 0;
  const wR = 0.65 * (1 - satBlend * 0.72);
  const wG = 1 - wR;

  for (let i = 0; i < N; i++) {
    if (mode === "finger") {
      const gn = -(g[i] / mg - 1);
      const rn = -(r[i] / mr - 1);
      out[i] = wR * rn + wG * gn;
    } else {
      out[i] = -(g[i] / mg - 1);
    }
  }
  return out;
}

/**
 * 3x3 Symmetric Jacobi Eigensolver (V^T * A * V = diag(evals))
 * Used for PCA whitening & symmetric orthogonalization in FastICA.
 */
function jacobiEigen3x3(A: number[][]): { evals: [number, number, number]; V: number[][] } {
  const M = [
    [A[0][0], A[0][1], A[0][2]],
    [A[1][0], A[1][1], A[1][2]],
    [A[2][0], A[2][1], A[2][2]],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 14; sweep++) {
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = M[p][q];
        if (Math.abs(apq) < 1e-10) continue;
        const tau = (M[q][q] - M[p][p]) / (2 * apq);
        const t =
          tau >= 0
            ? 1 / (tau + Math.sqrt(1 + tau * tau))
            : -1 / (-tau + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        const app = M[p][p];
        const aqq = M[q][q];
        M[p][p] = app - t * apq;
        M[q][q] = aqq + t * apq;
        M[p][q] = 0;
        M[q][p] = 0;

        for (let r = 0; r < 3; r++) {
          if (r === p || r === q) continue;
          const arp = M[r][p];
          const arq = M[r][q];
          M[r][p] = c * arp - s * arq;
          M[p][r] = M[r][p];
          M[r][q] = s * arp + c * arq;
          M[q][r] = M[r][q];
        }

        for (let r = 0; r < 3; r++) {
          const vrp = V[r][p];
          const vrq = V[r][q];
          V[r][p] = c * vrp - s * vrq;
          V[r][q] = s * vrp + c * vrq;
        }
      }
    }
  }

  return {
    evals: [
      Math.max(1e-6, M[0][0]),
      Math.max(1e-6, M[1][1]),
      Math.max(1e-6, M[2][2]),
    ],
    V,
  };
}

/**
 * Symmetric FastICA Blind Source Separation (Poh et al. 2010 / webcam-pulse-detector / rPPG-Toolbox)
 * Unmixes [R, G, B] into 3 independent sources via ZCA whitening + tanh negentropy maximization
 * and selects the source with maximum cardiac band spectral SNR.
 */
function extractIcaSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  fs: number
): Float64Array {
  const N = r.length;
  if (N < 24) return extractGreenSignal(r, g, "face");

  const z0 = normalizeUnitStd(r);
  const z1 = normalizeUnitStd(g);
  const z2 = normalizeUnitStd(b);
  const Z = [z0, z1, z2];

  // 3x3 covariance matrix C = (1/N) * Z * Z^T
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      let acc = 0;
      const zi = Z[i];
      const zj = Z[j];
      for (let t = 0; t < N; t++) acc += zi[t] * zj[t];
      C[i][j] = acc / N;
      C[j][i] = C[i][j];
    }
  }

  const { evals, V } = jacobiEigen3x3(C);
  const invSqrt = [
    1 / Math.sqrt(evals[0]),
    1 / Math.sqrt(evals[1]),
    1 / Math.sqrt(evals[2]),
  ];

  // Whitening matrix K = D^{-1/2} * V^T
  const Xw = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  for (let i = 0; i < 3; i++) {
    const scale = invSqrt[i];
    const v0i = V[0][i] * scale;
    const v1i = V[1][i] * scale;
    const v2i = V[2][i] * scale;
    const out = Xw[i];
    for (let t = 0; t < N; t++) {
      out[t] = v0i * z0[t] + v1i * z1[t] + v2i * z2[t];
    }
  }

  // Symmetric FastICA with tanh contrast
  let W = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let iter = 0; iter < 15; iter++) {
    const Wnew = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];

    for (let k = 0; k < 3; k++) {
      const wk0 = W[k][0];
      const wk1 = W[k][1];
      const wk2 = W[k][2];
      let e0 = 0,
        e1 = 0,
        e2 = 0,
        dgMean = 0;
      for (let t = 0; t < N; t++) {
        const x0 = Xw[0][t];
        const x1 = Xw[1][t];
        const x2 = Xw[2][t];
        const u = wk0 * x0 + wk1 * x1 + wk2 * x2;
        const gVal = Math.tanh(u);
        const dg = 1 - gVal * gVal;
        e0 += x0 * gVal;
        e1 += x1 * gVal;
        e2 += x2 * gVal;
        dgMean += dg;
      }
      e0 /= N;
      e1 /= N;
      e2 /= N;
      dgMean /= N;
      Wnew[k][0] = e0 - dgMean * wk0;
      Wnew[k][1] = e1 - dgMean * wk1;
      Wnew[k][2] = e2 - dgMean * wk2;
    }

    // Symmetric decorrelation: W <- (Wnew * Wnew^T)^{-1/2} * Wnew
    const M = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        const dot =
          Wnew[i][0] * Wnew[j][0] +
          Wnew[i][1] * Wnew[j][1] +
          Wnew[i][2] * Wnew[j][2];
        M[i][j] = dot;
        M[j][i] = dot;
      }
    }
    const eigM = jacobiEigen3x3(M);
    const invM = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let m = 0; m < 3; m++) {
          s +=
            (eigM.V[i][m] * eigM.V[j][m]) / Math.sqrt(eigM.evals[m]);
        }
        invM[i][j] = s;
      }
    }

    const Wnext = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        Wnext[i][j] =
          invM[i][0] * Wnew[0][j] +
          invM[i][1] * Wnew[1][j] +
          invM[i][2] * Wnew[2][j];
      }
    }
    W = Wnext;
  }

  // Reconstruct the 3 independent components and pick highest cardiac SNR source
  const greenRef = extractGreenSignal(r, g, "face");
  let bestSrc = greenRef;
  let bestSnr = -999;

  for (let k = 0; k < 3; k++) {
    const comp = new Float64Array(N);
    const w0 = W[k][0];
    const w1 = W[k][1];
    const w2 = W[k][2];
    for (let t = 0; t < N; t++) {
      comp[t] = w0 * Xw[0][t] + w1 * Xw[1][t] + w2 * Xw[2][t];
    }
    const band = zeroPhaseBandpass(comp, fs, 0.7, 3.5);
    const spec = evaluateCardiacSpectrum(band, fs);
    if (spec.snrDb > bestSnr) {
      bestSnr = spec.snrDb;
      bestSrc = alignPolarityToRef(comp, greenRef);
    }
  }

  return bestSrc;
}

/**
 * 3x3 Linear System Solver (Gaussian elimination with partial pivoting)
 * Used for regularized PBV spatial weight computation: (Q + lambda*I) * w = p_bv.
 */
function solveLinear3x3(A: number[][], rhs: [number, number, number]): [number, number, number] {
  const M = [
    [A[0][0], A[0][1], A[0][2], rhs[0]],
    [A[1][0], A[1][1], A[1][2], rhs[1]],
    [A[2][0], A[2][1], A[2][2], rhs[2]],
  ];

  for (let col = 0; col < 3; col++) {
    let pivot = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(M[row][col]) > maxAbs) {
        maxAbs = Math.abs(M[row][col]);
        pivot = row;
      }
    }
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const diag = Math.abs(M[col][col]) > 1e-10 ? M[col][col] : 1e-10;
    for (let row = col + 1; row < 3; row++) {
      const factor = M[row][col] / diag;
      for (let k = col; k < 4; k++) {
        M[row][k] -= factor * M[col][k];
      }
    }
  }

  const x2 = M[2][3] / (Math.abs(M[2][2]) > 1e-10 ? M[2][2] : 1e-10);
  const x1 =
    (M[1][3] - M[1][2] * x2) / (Math.abs(M[1][1]) > 1e-10 ? M[1][1] : 1e-10);
  const x0 =
    (M[0][3] - M[0][1] * x1 - M[0][2] * x2) /
    (Math.abs(M[0][0]) > 1e-10 ? M[0][0] : 1e-10);
  return [x0, x1, x2];
}

/**
 * OMIT: Orthogonal Matrix Image Transformation (Álvarez Casado & Bordallo López, IEEE JBHI 2023 / pyVHR)
 * Uses orthonormal QR decomposition seeded on the skin reflectance direction to project out
 * brightness, quantization steps, and webcam compression artifacts via S = I - q0*q0^T.
 */
function extractOmitSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  fs: number
): Float64Array {
  const N = r.length;
  const out = new Float64Array(N);
  const weightSum = new Float64Array(N);
  const winLen = Math.max(24, Math.round(1.6 * fs));

  const processWindow = (start: number, len: number) => {
    let mr = 0,
      mg = 0,
      mb = 0;
    for (let j = 0; j < len; j++) {
      mr += r[start + j];
      mg += g[start + j];
      mb += b[start + j];
    }
    mr = mr / len || 1;
    mg = mg / len || 1;
    mb = mb / len || 1;

    // Seed column 0 with mean skin reflectance axis so QR q0 spans common-mode intensity/compression drift
    const norm0 = Math.hypot(mr, mg, mb) || 1;
    const q0 = [mr / norm0, mg / norm0, mb / norm0];

    // Orthogonalize arterial green-minus-red/blue chrominance direction [-0.45, 0.85, -0.35]
    const bvpAxis = [-0.45, 0.85, -0.35];
    const dot0 =
      q0[0] * bvpAxis[0] + q0[1] * bvpAxis[1] + q0[2] * bvpAxis[2];
    const wOrth = [
      bvpAxis[0] - dot0 * q0[0],
      bvpAxis[1] - dot0 * q0[1],
      bvpAxis[2] - dot0 * q0[2],
    ];
    const wNorm = Math.hypot(wOrth[0], wOrth[1], wOrth[2]) || 1;
    wOrth[0] /= wNorm;
    wOrth[1] /= wNorm;
    wOrth[2] /= wNorm;

    // Also compute normalized 2nd QR complement q2 = q0 x wOrth to suppress residual 2-axis motion if needed
    const q2 = [
      q0[1] * wOrth[2] - q0[2] * wOrth[1],
      q0[2] * wOrth[0] - q0[0] * wOrth[2],
      q0[0] * wOrth[1] - q0[1] * wOrth[0],
    ];

    const s1 = new Float64Array(len);
    const s2 = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      const rn = r[start + j] / mr - 1;
      const gn = g[start + j] / mg - 1;
      const bn = b[start + j] / mb - 1;
      s1[j] = wOrth[0] * rn + wOrth[1] * gn + wOrth[2] * bn;
      s2[j] = q2[0] * rn + q2[1] * gn + q2[2] * bn;
    }

    // Orthogonal ratio alpha cancels residual correlated motion along q2
    const cov12 = meanProduct(s1, s2);
    const var2 = meanProduct(s2, s2) + 1e-6;
    const alpha = Math.max(-1.2, Math.min(1.2, cov12 / var2));

    for (let j = 0; j < len; j++) {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * j) / Math.max(1, len - 1));
      out[start + j] += w * (s1[j] - alpha * s2[j]);
      weightSum[start + j] += w;
    }
  };

  if (N <= winLen) {
    processWindow(0, N);
  } else {
    const step = Math.max(1, Math.floor(winLen / 4));
    for (let start = 0; start <= N - winLen; start += step) {
      processWindow(start, winLen);
    }
    if ((N - winLen) % step !== 0) {
      processWindow(N - winLen, winLen);
    }
  }

  for (let i = 0; i < N; i++) {
    if (weightSum[i] > 1e-6) out[i] /= weightSum[i];
  }
  return out;
}

function meanProduct(a: Float64Array, b: Float64Array): number {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += a[i] * b[i];
  return acc / Math.max(1, a.length);
}

/**
 * PBV: Blood Volume Pulse Signature (De Haan & Van Leest, Physiol. Meas. 2014 / pyVHR / rPPG-Toolbox)
 * Solves regularized matched filter (Q + lambda*I) * w = p_bv against arterial blood absorption vector [0.33, 0.77, 0.54].
 */
function extractPbvSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  fs: number
): Float64Array {
  const N = r.length;
  const out = new Float64Array(N);
  const weightSum = new Float64Array(N);
  const winLen = Math.max(24, Math.round(1.6 * fs));
  const pbvVec: [number, number, number] = [0.33, 0.77, 0.54];

  const processWindow = (start: number, len: number) => {
    let mr = 0,
      mg = 0,
      mb = 0;
    for (let j = 0; j < len; j++) {
      mr += r[start + j];
      mg += g[start + j];
      mb += b[start + j];
    }
    mr = mr / len || 1;
    mg = mg / len || 1;
    mb = mb / len || 1;

    const rn = new Float64Array(len);
    const gn = new Float64Array(len);
    const bn = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      rn[j] = r[start + j] / mr - 1;
      gn[j] = g[start + j] / mg - 1;
      bn[j] = b[start + j] / mb - 1;
    }

    const chans = [rn, gn, bn];
    const Q = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        const val = meanProduct(chans[i], chans[j]);
        Q[i][j] = val;
        Q[j][i] = val;
      }
    }

    const traceMean = (Q[0][0] + Q[1][1] + Q[2][2]) / 3;
    const reg = Math.max(1e-7, 0.025 * traceMean);
    Q[0][0] += reg;
    Q[1][1] += reg;
    Q[2][2] += reg;

    const wVec = solveLinear3x3(Q, pbvVec);
    const wNorm = Math.hypot(wVec[0], wVec[1], wVec[2]) || 1;
    const w0 = wVec[0] / wNorm;
    const w1 = wVec[1] / wNorm;
    const w2 = wVec[2] / wNorm;

    const seg = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      seg[j] = w0 * rn[j] + w1 * gn[j] + w2 * bn[j];
    }
    const segStd = stdDev(seg) || 1;
    for (let j = 0; j < len; j++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * j) / Math.max(1, len - 1)));
      const hw = Math.max(0.05, w);
      out[start + j] += hw * (seg[j] / segStd);
      weightSum[start + j] += hw;
    }
  };

  if (N <= winLen) {
    processWindow(0, N);
  } else {
    const step = Math.max(1, Math.floor(winLen / 4));
    for (let start = 0; start <= N - winLen; start += step) {
      processWindow(start, winLen);
    }
    if ((N - winLen) % step !== 0) {
      processWindow(N - winLen, winLen);
    }
  }

  for (let i = 0; i < N; i++) {
    if (weightSum[i] > 1e-6) out[i] /= weightSum[i];
  }
  return out;
}

/**
 * LGI: Local Group Invariance (Pilz et al., CVPRW 2018 / pyVHR / rPPG-Toolbox)
 * Computes rank-1 SVD eigenvector u1 of local channel covariance and projects onto invariant subspace P = I - u1*u1^T,
 * providing strong invariance to non-uniform room lighting shifts and rigid head rotation.
 */
function extractLgiSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  fs: number
): Float64Array {
  const N = r.length;
  const out = new Float64Array(N);
  const weightSum = new Float64Array(N);
  const winLen = Math.max(24, Math.round(1.6 * fs));

  const processWindow = (start: number, len: number) => {
    let mr = 0,
      mg = 0,
      mb = 0;
    for (let j = 0; j < len; j++) {
      mr += r[start + j];
      mg += g[start + j];
      mb += b[start + j];
    }
    mr = mr / len || 1;
    mg = mg / len || 1;
    mb = mb / len || 1;

    const rn = new Float64Array(len);
    const gn = new Float64Array(len);
    const bn = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      rn[j] = r[start + j] / mr - 1;
      gn[j] = g[start + j] / mg - 1;
      bn[j] = b[start + j] / mb - 1;
    }

    const chans = [rn, gn, bn];
    const C = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        const val = meanProduct(chans[i], chans[j]);
        C[i][j] = val;
        C[j][i] = val;
      }
    }

    const { evals, V } = jacobiEigen3x3(C);
    let maxIdx = 0;
    if (evals[1] > evals[maxIdx]) maxIdx = 1;
    if (evals[2] > evals[maxIdx]) maxIdx = 2;
    const u0 = V[0][maxIdx];
    const u1 = V[1][maxIdx];
    const u2 = V[2][maxIdx];

    // Invariant projection P * d_bvp where P = I - u1*u1^T removes dominant local illumination/motion mode
    const d0 = -0.45,
      d1 = 0.85,
      d2 = -0.4;
    const dotU = u0 * d0 + u1 * d1 + u2 * d2;
    let p0 = d0 - dotU * u0;
    let p1 = d1 - dotU * u1;
    let p2 = d2 - dotU * u2;
    let pNorm = Math.hypot(p0, p1, p2);

    if (pNorm < 0.08) {
      // Fallback to 2nd eigenvector when dominant mode is orthogonal to standard illumination vector
      const secIdx = maxIdx === 0 ? 1 : 0;
      p0 = V[0][secIdx];
      p1 = V[1][secIdx];
      p2 = V[2][secIdx];
      pNorm = Math.hypot(p0, p1, p2) || 1;
    }
    p0 /= pNorm;
    p1 /= pNorm;
    p2 /= pNorm;

    for (let j = 0; j < len; j++) {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * j) / Math.max(1, len - 1));
      out[start + j] += w * (p0 * rn[j] + p1 * gn[j] + p2 * bn[j]);
      weightSum[start + j] += w;
    }
  };

  if (N <= winLen) {
    processWindow(0, N);
  } else {
    const step = Math.max(1, Math.floor(winLen / 4));
    for (let start = 0; start <= N - winLen; start += step) {
      processWindow(start, winLen);
    }
    if ((N - winLen) % step !== 0) {
      processWindow(N - winLen, winLen);
    }
  }

  for (let i = 0; i < N; i++) {
    if (weightSum[i] > 1e-6) out[i] /= weightSum[i];
  }
  return out;
}

function selectBvpSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  algorithm: RppgAlgorithm,
  mode: CaptureMode,
  fs: number
): Float64Array {
  if (mode === "finger") return extractGreenSignal(r, g, "finger");
  if (algorithm === "CHROM") return extractChromSignal(r, g, b, fs);
  if (algorithm === "OMIT") return extractOmitSignal(r, g, b, fs);
  if (algorithm === "PBV") return extractPbvSignal(r, g, b, fs);
  if (algorithm === "LGI") return extractLgiSignal(r, g, b, fs);
  if (algorithm === "ICA") return extractIcaSignal(r, g, b, fs);
  if (algorithm === "GREEN") return extractGreenSignal(r, g, mode);
  return extractPosSignal(r, g, b, fs);
}

interface AlgoWeightsBreakdown {
  pos: number;
  chrom: number;
  omit: number;
  pbv: number;
  lgi: number;
  ica: number;
  green: number;
}

interface AlgoFusionResult {
  filtered: Float64Array;
  weights: AlgoWeightsBreakdown;
}

function normalizeUnitStd(arr: Float64Array): Float64Array {
  const m = mean(arr);
  const s = stdDev(arr, m) || 1;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = (arr[i] - m) / s;
  }
  return out;
}

function alignPolarityToRef(sig: Float64Array, ref: Float64Array): Float64Array {
  let dot = 0;
  const len = Math.min(sig.length, ref.length);
  for (let i = 0; i < len; i++) {
    dot += sig[i] * ref[i];
  }
  if (dot >= 0) return sig;
  const flipped = new Float64Array(sig.length);
  for (let i = 0; i < sig.length; i++) flipped[i] = -sig[i];
  return flipped;
}

function pearsonCorrelation(a: Float64Array, b: Float64Array): number {
  const N = Math.min(a.length, b.length);
  if (N < 8) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < N; i++) {
    const va = a[i] - ma;
    const vb = b[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const denom = Math.sqrt(da * db);
  return denom > 1e-9 ? num / denom : 0;
}

function detrendSlidingMean(signal: Float64Array, halfWin: number): Float64Array {
  const N = signal.length;
  if (N < 8) return new Float64Array(signal);
  const prefix = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    prefix[i + 1] = prefix[i] + signal[i];
  }
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(N - 1, i + halfWin);
    const localMean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    out[i] = signal[i] - localMean;
  }
  return out;
}

/**
 * 7-Algorithm Phase-Aligned Consensus Fusion (POS + CHROM + OMIT + PBV + LGI + FastICA + GREEN)
 * with SNR SoftMax, Welch PSD, and 7-way fundamental frequency consensus voting (pyVHR / rPPG-Toolbox).
 */
function extractBandpassedByAlgorithm(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  algorithm: RppgAlgorithm,
  mode: CaptureMode,
  fs: number,
  priorBpm?: number | null
): AlgoFusionResult {
  const halfDetrend = Math.max(8, Math.round(fs * 0.75));

  if (mode === "finger" || algorithm !== "FUSION") {
    const raw = detrendSlidingMean(
      selectBvpSignal(r, g, b, algorithm, mode, fs),
      halfDetrend
    );
    const filtered = zeroPhaseBandpass(raw, fs, 0.7, 3.5);
    const w: AlgoWeightsBreakdown = {
      pos: algorithm === "POS" && mode !== "finger" ? 100 : 0,
      chrom: algorithm === "CHROM" && mode !== "finger" ? 100 : 0,
      omit: algorithm === "OMIT" && mode !== "finger" ? 100 : 0,
      pbv: algorithm === "PBV" && mode !== "finger" ? 100 : 0,
      lgi: algorithm === "LGI" && mode !== "finger" ? 100 : 0,
      ica: algorithm === "ICA" && mode !== "finger" ? 100 : 0,
      green: mode === "finger" || algorithm === "GREEN" ? 100 : 0,
    };
    return { filtered, weights: w };
  }

  const prep = (raw: Float64Array) =>
    normalizeUnitStd(
      zeroPhaseBandpass(detrendSlidingMean(raw, halfDetrend), fs, 0.7, 3.5)
    );

  const fPos = prep(extractPosSignal(r, g, b, fs));
  const fChrom = alignPolarityToRef(prep(extractChromSignal(r, g, b, fs)), fPos);
  const fOmit = alignPolarityToRef(prep(extractOmitSignal(r, g, b, fs)), fPos);
  const fPbv = alignPolarityToRef(prep(extractPbvSignal(r, g, b, fs)), fPos);
  const fLgi = alignPolarityToRef(prep(extractLgiSignal(r, g, b, fs)), fPos);
  const fIca = alignPolarityToRef(prep(extractIcaSignal(r, g, b, fs)), fPos);
  const fGreen = alignPolarityToRef(prep(extractGreenSignal(r, g, mode)), fPos);

  const sPos = evaluateCardiacSpectrum(fPos, fs, priorBpm);
  const sChrom = evaluateCardiacSpectrum(fChrom, fs, priorBpm);
  const sOmit = evaluateCardiacSpectrum(fOmit, fs, priorBpm);
  const sPbv = evaluateCardiacSpectrum(fPbv, fs, priorBpm);
  const sLgi = evaluateCardiacSpectrum(fLgi, fs, priorBpm);
  const sIca = evaluateCardiacSpectrum(fIca, fs, priorBpm);
  const sGreen = evaluateCardiacSpectrum(fGreen, fs, priorBpm);

  const freqs = [
    sPos.dominantFreqHz,
    sChrom.dominantFreqHz,
    sOmit.dominantFreqHz,
    sPbv.dominantFreqHz,
    sLgi.dominantFreqHz,
    sIca.dominantFreqHz,
    sGreen.dominantFreqHz,
  ];

  // 7-way inter-algorithm fundamental frequency consensus voting (±0.055 Hz ≈ ±3.3 BPM)
  // Core specular-orthogonal extractors {POS, CHROM, OMIT, LGI} mathematically reject [1,1,1] luminance motion.
  // PBV/ICA/GREEN retain sensitivity to [1,1,1] luminance shifts, so penalize them if they diverge from an agreed ortho core.
  const strictOrthoFreqs = [freqs[0], freqs[1], freqs[2], freqs[4]];
  let orthoClusterCount = 0;
  for (let a = 0; a < strictOrthoFreqs.length; a++) {
    let matches = 0;
    for (let b = 0; b < strictOrthoFreqs.length; b++) {
      if (a !== b && Math.abs(strictOrthoFreqs[a] - strictOrthoFreqs[b]) <= 0.06) {
        matches++;
      }
    }
    if (matches > orthoClusterCount) orthoClusterCount = matches;
  }
  const hasOrthoConsensus = orthoClusterCount >= 1; // >= 2 of {POS, CHROM, OMIT, LGI} agree

  const consensusScore = (idx: number) => {
    const fSelf = freqs[idx];
    const isStrictOrtho = idx === 0 || idx === 1 || idx === 2 || idx === 4;
    let mult = 1.0;
    for (let j = 0; j < freqs.length; j++) {
      if (j === idx) continue;
      const jStrictOrtho = j === 0 || j === 1 || j === 2 || j === 4;
      if (Math.abs(fSelf - freqs[j]) <= 0.055) {
        mult *= jStrictOrtho ? 1.28 : 1.08;
      }
    }
    if (!isStrictOrtho && hasOrthoConsensus) {
      const orthoAgree = strictOrthoFreqs.filter(
        (fo) => Math.abs(fSelf - fo) <= 0.08
      ).length;
      if (orthoAgree === 0) {
        mult *= 0.14;
      }
    }
    return mult;
  };

  const snrTerm = (spec: { snrDb: number; purity: number }) =>
    Math.exp(Math.max(-4, Math.min(11, spec.snrDb)) / 4.2) *
    (0.75 + 0.50 * spec.purity);

  const rawWPos = 1.24 * consensusScore(0) * snrTerm(sPos);
  const rawWChrom = 1.18 * consensusScore(1) * snrTerm(sChrom);
  const rawWOmit = 1.20 * consensusScore(2) * snrTerm(sOmit);
  const rawWPbv = 1.06 * consensusScore(3) * snrTerm(sPbv);
  const rawWLgi = 1.12 * consensusScore(4) * snrTerm(sLgi);
  const rawWIca = 0.85 * consensusScore(5) * snrTerm(sIca);
  const rawWGreen = 0.65 * consensusScore(6) * snrTerm(sGreen);

  const wSum =
    rawWPos +
      rawWChrom +
      rawWOmit +
      rawWPbv +
      rawWLgi +
      rawWIca +
      rawWGreen || 1;
  const wp = rawWPos / wSum;
  const wc = rawWChrom / wSum;
  const wo = rawWOmit / wSum;
  const wpbv = rawWPbv / wSum;
  const wlgi = rawWLgi / wSum;
  const wi = rawWIca / wSum;
  const wg = rawWGreen / wSum;

  const fused = new Float64Array(fPos.length);
  for (let i = 0; i < fPos.length; i++) {
    fused[i] =
      wp * fPos[i] +
      wc * fChrom[i] +
      wo * fOmit[i] +
      wpbv * fPbv[i] +
      wlgi * fLgi[i] +
      wi * fIca[i] +
      wg * fGreen[i];
  }

  const wpInt = Math.round(wp * 100);
  const wcInt = Math.round(wc * 100);
  const woInt = Math.round(wo * 100);
  const wpbvInt = Math.round(wpbv * 100);
  const wlgiInt = Math.round(wlgi * 100);
  const wiInt = Math.round(wi * 100);
  return {
    filtered: fused,
    weights: {
      pos: wpInt,
      chrom: wcInt,
      omit: woInt,
      pbv: wpbvInt,
      lgi: wlgiInt,
      ica: wiInt,
      green: Math.max(
        0,
        100 - wpInt - wcInt - woInt - wpbvInt - wlgiInt - wiInt
      ),
    },
  };
}

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function butterworthLowpassCoeffs(fc: number, fs: number): BiquadCoeffs {
  const ita = 1.0 / Math.tan((Math.PI * fc) / fs);
  const q = Math.SQRT2;
  const b0 = 1.0 / (1.0 + q * ita + ita * ita);
  return {
    b0,
    b1: 2 * b0,
    b2: b0,
    a1: 2 * (1 - ita * ita) * b0,
    a2: (1 - q * ita + ita * ita) * b0,
  };
}

function butterworthHighpassCoeffs(fc: number, fs: number): BiquadCoeffs {
  const ita = Math.tan((Math.PI * fc) / fs);
  const q = Math.SQRT2;
  const b0 = 1.0 / (1.0 + q * ita + ita * ita);
  return {
    b0,
    b1: -2 * b0,
    b2: b0,
    a1: 2 * (ita * ita - 1) * b0,
    a2: (1 - q * ita + ita * ita) * b0,
  };
}

function applyBiquad(x: Float64Array, c: BiquadCoeffs): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return y;
}

function zeroPhaseBandpass(
  signal: Float64Array,
  fs: number,
  lowHz: number,
  highHz: number
): Float64Array {
  const N = signal.length;
  if (N < 16) return new Float64Array(signal);

  const m = mean(signal);
  const pad = Math.min(Math.round(fs), N - 1);
  const padded = new Float64Array(N + pad * 2);

  for (let i = 0; i < pad; i++) padded[i] = signal[pad - i] - m;
  for (let i = 0; i < N; i++) padded[pad + i] = signal[i] - m;
  for (let i = 0; i < pad; i++) padded[pad + N + i] = signal[N - 2 - i] - m;

  const hp = butterworthHighpassCoeffs(lowHz, fs);
  const lp = butterworthLowpassCoeffs(highHz, fs);

  let tmp = applyBiquad(padded, hp);
  tmp = applyBiquad(tmp, lp);

  const rev = new Float64Array(tmp.length);
  for (let i = 0; i < tmp.length; i++) rev[i] = tmp[tmp.length - 1 - i];
  rev.set(applyBiquad(rev, hp));
  rev.set(applyBiquad(rev, lp));

  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = rev[tmp.length - 1 - (pad + i)];
  }
  return out;
}

function fftReal(signal: Float64Array, fftSize: number): Float64Array {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  const len = Math.min(signal.length, fftSize);
  for (let i = 0; i < len; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
    re[i] = signal[i] * hann;
  }

  let j = 0;
  for (let i = 1; i < fftSize; i++) {
    let bit = fftSize >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
    }
  }

  for (let size = 2; size <= fftSize; size <<= 1) {
    const half = size >> 1;
    const angle = (-2 * Math.PI) / size;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);

    for (let start = 0; start < fftSize; start += size) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const i1 = start + k;
        const i2 = i1 + half;
        const tRe = wRe * re[i2] - wIm * im[i2];
        const tIm = wRe * im[i2] + wIm * re[i2];

        re[i2] = re[i1] - tRe;
        im[i2] = im[i1] - tIm;
        re[i1] += tRe;
        im[i1] += tIm;

        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }

  const halfBins = fftSize >> 1;
  const power = new Float64Array(halfBins);
  for (let i = 0; i < halfBins; i++) {
    power[i] = re[i] * re[i] + im[i] * im[i];
  }
  return power;
}

function estimateAutocorrelationBpm(
  filtered: Float64Array,
  fs: number
): { bpm: number | null; periodicity: number } {
  const N = filtered.length;
  if (N < Math.round(fs * 3.5)) {
    return { bpm: null, periodicity: 0 };
  }
  const minLag = Math.max(2, Math.floor(0.32 * fs)); // ~187 BPM max
  const maxLag = Math.min(Math.floor(N * 0.55), Math.ceil(1.36 * fs)); // ~44 BPM min
  if (maxLag <= minLag + 2) return { bpm: null, periodicity: 0 };

  const corr = new Float64Array(maxLag + 1);
  let bestLag = minLag;
  let bestR = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    const limit = N - lag;
    for (let i = 0; i < limit; i++) {
      const a = filtered[i];
      const b = filtered[i + lag];
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
    const denom = Math.sqrt(denA * denB);
    const r = denom > 1e-9 ? num / denom : 0;
    corr[lag] = r;
    if (r > bestR) {
      bestR = r;
      bestLag = lag;
    }
  }

  if (bestR < 0.25) return { bpm: null, periodicity: Math.max(0, bestR) };

  // YIN/MPM octave-error guard: if bestLag ≈ 2*T (double period, half BPM) and halfLag also correlates strongly,
  // pick the shorter period (true fundamental HR) rather than the 2T sub-harmonic alias.
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag) {
    let subBestLag = halfLag;
    let subBestR = -1;
    for (let k = Math.max(minLag, halfLag - 2); k <= Math.min(maxLag, halfLag + 2); k++) {
      if (corr[k] > subBestR) {
        subBestR = corr[k];
        subBestLag = k;
      }
    }
    if (subBestR >= bestR * 0.80 && subBestR >= 0.32) {
      bestLag = subBestLag;
      bestR = subBestR;
    }
  }

  // Sub-sample parabolic refinement on autocorrelation lag
  const rL = corr[bestLag - 1] ?? bestR;
  const rC = corr[bestLag];
  const rR = corr[bestLag + 1] ?? bestR;
  const denom = rL - 2 * rC + rR;
  const delta = Math.abs(denom) > 1e-9 ? (0.5 * (rL - rR)) / denom : 0;
  const refinedLag = bestLag + Math.max(-0.5, Math.min(0.5, delta));

  return {
    bpm: (60 * fs) / refinedLag,
    periodicity: bestR,
  };
}

function evaluateCardiacSpectrum(
  filtered: Float64Array,
  fs: number,
  priorBpm?: number | null
) {
  const fftInputLen = Math.min(360, filtered.length);
  const fftSlice = filtered.slice(filtered.length - fftInputLen);
  const fftSize = 4096;
  const fullPower = fftReal(fftSlice, fftSize);
  const binResHz = fs / fftSize;

  const minBin = Math.max(1, Math.floor(0.72 / binResHz));
  const maxBin = Math.min(fullPower.length - 2, Math.ceil(3.15 / binResHz));

  // Welch's Overlapping-Segment PSD (pyVHR / SciPy style) suppresses transient spectral noise
  let power = fullPower;
  const welchWin = Math.round(fs * 6);
  const welchStep = Math.round(fs * 2);
  if (fftSlice.length >= Math.round(fs * 8) && fftSlice.length > welchWin) {
    const welchAcc = new Float64Array(fullPower.length);
    let segCount = 0;
    for (let s = 0; s <= fftSlice.length - welchWin; s += welchStep) {
      const segPower = fftReal(fftSlice.subarray(s, s + welchWin), fftSize);
      for (let i = 0; i < welchAcc.length; i++) welchAcc[i] += segPower[i];
      segCount++;
    }
    if (segCount > 0) {
      let fullSum = 0;
      let welchSum = 0;
      for (let i = minBin; i <= maxBin; i++) {
        fullSum += fullPower[i];
        welchSum += welchAcc[i];
      }
      const scale = welchSum > 1e-12 ? fullSum / welchSum : 1;
      const blended = new Float64Array(fullPower.length);
      for (let i = 0; i < fullPower.length; i++) {
        blended[i] = 0.52 * fullPower[i] + 0.48 * welchAcc[i] * scale;
      }
      power = blended;
    }
  }

  const priorFreq =
    priorBpm && priorBpm >= 42 && priorBpm <= 195 ? priorBpm / 60 : null;

  let peakBin = minBin;
  let maxCombScore = 0;
  let maxPower = 0;
  let totalBandPower = 0;

  for (let i = minBin; i <= maxBin; i++) {
    totalBandPower += power[i];
    const h2 = i * 2;
    const harmonicBoost =
      h2 < power.length - 1
        ? 0.30 * Math.max(power[h2 - 1], power[h2], power[h2 + 1])
        : 0;
    let combScore = power[i] + harmonicBoost;
    if (priorFreq !== null) {
      const df = i * binResHz - priorFreq;
      // Soft Gaussian prior (±13 BPM sigma) suppresses transient noise & harmonic jumps
      combScore *= 1 + 0.38 * Math.exp(-0.5 * (df / 0.22) * (df / 0.22));
    }
    if (combScore > maxCombScore) {
      maxCombScore = combScore;
      peakBin = i;
      maxPower = power[i];
    }
  }

  const candFreq = peakBin * binResHz;
  if (candFreq > 1.72) {
    const subBin = Math.round(peakBin / 2);
    if (subBin >= minBin && subBin <= maxBin) {
      let localSubMax = 0;
      let localSubBin = subBin;
      for (
        let k = Math.max(minBin, subBin - 4);
        k <= Math.min(maxBin, subBin + 4);
        k++
      ) {
        if (power[k] > localSubMax) {
          localSubMax = power[k];
          localSubBin = k;
        }
      }
      if (localSubMax >= maxPower * 0.58) {
        peakBin = localSubBin;
        maxPower = localSubMax;
      }
    }
  }

  const pLeft = power[peakBin - 1] ?? 0;
  const pCenter = power[peakBin] ?? 0;
  const pRight = power[peakBin + 1] ?? 0;
  const denom = pLeft - 2 * pCenter + pRight;
  const delta = Math.abs(denom) > 1e-12 ? (0.5 * (pLeft - pRight)) / denom : 0;
  const refinedBin = peakBin + Math.max(-0.5, Math.min(0.5, delta));
  let dominantFreqHz = refinedBin * binResHz;

  // Time-domain Autocorrelation cross-check for harmonic disambiguation & sub-BPM precision
  const acf = estimateAutocorrelationBpm(filtered, fs);
  const fftBpm = dominantFreqHz * 60;
  if (acf.bpm !== null && acf.periodicity >= 0.44) {
    if (Math.abs(fftBpm - acf.bpm) <= 7) {
      const fusedBpm = 0.78 * fftBpm + 0.22 * acf.bpm;
      dominantFreqHz = fusedBpm / 60;
    } else if (
      Math.abs(fftBpm * 0.5 - acf.bpm) <= 6 &&
      acf.periodicity >= 0.62
    ) {
      // Confirm true subharmonic energy in FFT before flipping down an octave
      const halfBin = Math.round((fftBpm * 0.5) / 60 / binResHz);
      let halfPow = 0;
      for (let k = Math.max(minBin, halfBin - 4); k <= Math.min(maxBin, halfBin + 4); k++) {
        if (power[k] > halfPow) halfPow = power[k];
      }
      if (halfPow >= power[peakBin] * 0.35) {
        dominantFreqHz = acf.bpm / 60;
      }
    }
  }

  const halfWidthBins = Math.max(3, Math.round(0.15 / binResHz));
  let signalPower = 0;
  for (let i = minBin; i <= maxBin; i++) {
    const nearFund = Math.abs(i - peakBin) <= halfWidthBins;
    const nearHarmonic = Math.abs(i - peakBin * 2) <= halfWidthBins;
    if (nearFund || nearHarmonic) signalPower += power[i];
  }
  const noisePower = Math.max(1e-12, totalBandPower - signalPower);
  const snrDb = Number(
    (10 * Math.log10(Math.max(0.05, signalPower / noisePower))).toFixed(1)
  );
  const purity = totalBandPower > 1e-12 ? Math.min(1, signalPower / totalBandPower) : 0;

  return { power, binResHz, maxPower, dominantFreqHz, snrDb, purity };
}

function computeFrequencyDomainLfHf(cleanIbisMs: number[]): number | null {
  if (cleanIbisMs.length < 6) return null;
  const timesSec: number[] = [0];
  let totalSec = 0;
  for (let i = 0; i < cleanIbisMs.length; i++) {
    totalSec += cleanIbisMs[i] / 1000;
    timesSec.push(totalSec);
  }
  if (totalSec < 5.5) return null;

  const fsIbi = 4;
  const nGrid = Math.floor(totalSec * fsIbi);
  if (nGrid < 20) return null;

  const grid = new Float64Array(nGrid);
  let idx = 0;
  for (let k = 0; k < nGrid; k++) {
    const t = k / fsIbi;
    while (idx < cleanIbisMs.length - 1 && timesSec[idx + 1] < t) idx++;
    const i0 = Math.min(cleanIbisMs.length - 1, idx);
    const i1 = Math.min(cleanIbisMs.length - 1, idx + 1);
    const span = timesSec[i1 + 1] - timesSec[i0];
    const alpha = span > 1e-4 ? Math.max(0, Math.min(1, (t - timesSec[i0]) / span)) : 0;
    grid[k] = cleanIbisMs[i0] + alpha * (cleanIbisMs[i1] - cleanIbisMs[i0]);
  }

  const m = mean(grid);
  for (let k = 0; k < nGrid; k++) grid[k] -= m;

  const fftSize = 256;
  const power = fftReal(grid, fftSize);
  const df = fsIbi / fftSize;

  let lfPower = 0;
  let hfPower = 0;
  for (let i = 1; i < power.length; i++) {
    const f = i * df;
    if (f >= 0.04 && f < 0.15) lfPower += power[i];
    else if (f >= 0.15 && f <= 0.40) hfPower += power[i];
  }

  if (hfPower <= 1e-12) return null;
  return Number(Math.max(0.1, Math.min(9.9, lfPower / hfPower)).toFixed(2));
}

function catmullRomEval(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function detectSystolicPeaksAndPoincare(
  waveform: number[],
  fs: number,
  expectedBpm?: number | null
): {
  peakIndices: number[];
  rmssdMs: number | null;
  sdnnMs: number | null;
  sd1Ms: number | null;
  sd2Ms: number | null;
  lfHfRatio: number | null;
  cleanIbiRatio: number;
  poincarePoints: PoincarePoint[];
} {
  const N = waveform.length;
  if (N < fs * 2) {
    return {
      peakIndices: [],
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      lfHfRatio: null,
      cleanIbiRatio: 0,
      poincarePoints: [],
    };
  }

  // 4x Catmull-Rom cubic spline upsampling (30 Hz -> 120 Hz effective grid, 8.33 ms resolution)
  // eliminates asymmetric arterial peak rounding error before sub-sample parabolic interpolation
  const UP = 4;
  const fsHi = fs * UP;
  const nHi = (N - 1) * UP + 1;
  const hiWave = new Float64Array(nHi);
  for (let i = 0; i < N - 1; i++) {
    const p0 = waveform[Math.max(0, i - 1)];
    const p1 = waveform[i];
    const p2 = waveform[i + 1];
    const p3 = waveform[Math.min(N - 1, i + 2)];
    for (let u = 0; u < UP; u++) {
      hiWave[i * UP + u] = catmullRomEval(p0, p1, p2, p3, u / UP);
    }
  }
  hiWave[nHi - 1] = waveform[N - 1];

  const sigma = stdDev(waveform);
  const threshold = sigma * 0.34;
  // Adaptive refractory period locks out dicrotic notches using dominant heart rate
  const refractorySec =
    expectedBpm && expectedBpm >= 42 && expectedBpm <= 190
      ? Math.max(0.30, Math.min(0.68, 0.56 * (60 / expectedBpm)))
      : 0.34;
  const minDistHi = Math.round(refractorySec * fsHi);

  const candidatesHi: number[] = [];
  for (let i = 1; i < nHi - 1; i++) {
    if (
      hiWave[i] > threshold &&
      hiWave[i] >= hiWave[i - 1] &&
      hiWave[i] > hiWave[i + 1]
    ) {
      if (candidatesHi.length === 0) {
        candidatesHi.push(i);
      } else {
        const last = candidatesHi[candidatesHi.length - 1];
        if (i - last >= minDistHi) {
          candidatesHi.push(i);
        } else if (hiWave[i] > hiWave[last]) {
          candidatesHi[candidatesHi.length - 1] = i;
        }
      }
    }
  }

  // Map high-resolution peak positions cleanly back to original waveform indices for UI dots/audio
  const peakIndices = candidatesHi.map((idxHi) =>
    Math.max(0, Math.min(N - 1, Math.round(idxHi / UP)))
  );

  if (candidatesHi.length < 4) {
    return {
      peakIndices,
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      lfHfRatio: null,
      cleanIbiRatio: 0,
      poincarePoints: [],
    };
  }

  // Sub-sample parabolic interpolation on 120 Hz grid yields ~±2 ms IBI/HRV timing precision
  const refinedFractionalPeaks = candidatesHi.map((idxHi) => {
    if (idxHi <= 0 || idxHi >= nHi - 1) return idxHi;
    const yL = hiWave[idxHi - 1];
    const yC = hiWave[idxHi];
    const yR = hiWave[idxHi + 1];
    const denom = yL - 2 * yC + yR;
    const delta = Math.abs(denom) > 1e-9 ? (0.5 * (yL - yR)) / denom : 0;
    return idxHi + Math.max(-0.5, Math.min(0.5, delta));
  });

  const rawIbis: number[] = [];
  for (let i = 1; i < refinedFractionalPeaks.length; i++) {
    const ibiMs =
      ((refinedFractionalPeaks[i] - refinedFractionalPeaks[i - 1]) / fsHi) * 1000;
    if (ibiMs >= 330 && ibiMs <= 1450) {
      rawIbis.push(ibiMs);
    }
  }

  if (rawIbis.length < 3) {
    return {
      peakIndices,
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      lfHfRatio: null,
      cleanIbiRatio: 0,
      poincarePoints: [],
    };
  }

  const sorted = [...rawIbis].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const devs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = Math.max(12, devs[Math.floor(devs.length / 2)] * 1.4826);
  const cleanIbis = rawIbis.filter(
    (v) => v >= med * 0.78 && v <= med * 1.22 && Math.abs(v - med) <= 3.2 * mad
  );
  const cleanIbiRatio = cleanIbis.length / Math.max(1, rawIbis.length);

  if (cleanIbis.length < 3) {
    return {
      peakIndices,
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      lfHfRatio: null,
      cleanIbiRatio,
      poincarePoints: [],
    };
  }

  let sqDiffSum = 0;
  let validPairCount = 0;
  const poincarePoints: PoincarePoint[] = [];
  const diffAxis: number[] = [];
  const sumAxis: number[] = [];

  for (let i = 1; i < cleanIbis.length; i++) {
    const a = cleanIbis[i - 1];
    const b = cleanIbis[i];
    const d = b - a;
    if (Math.abs(d) > med * 0.22) continue;
    sqDiffSum += d * d;
    validPairCount++;
    poincarePoints.push({
      ibiN: Math.round(a),
      ibiNext: Math.round(b),
    });
    diffAxis.push((b - a) / Math.SQRT2);
    sumAxis.push((b + a) / Math.SQRT2);
  }

  if (validPairCount < 2) {
    return {
      peakIndices,
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      lfHfRatio: null,
      cleanIbiRatio,
      poincarePoints: [],
    };
  }

  const rmssdMs = Math.round(Math.sqrt(sqDiffSum / validPairCount));
  const sdnnMs = Math.round(stdDev(cleanIbis));
  const sd1Ms = Math.round(stdDev(diffAxis));
  const sd2Ms = Math.round(stdDev(sumAxis));
  const lfHfRatio = computeFrequencyDomainLfHf(cleanIbis);

  return {
    peakIndices,
    rmssdMs,
    sdnnMs,
    sd1Ms,
    sd2Ms,
    lfHfRatio,
    cleanIbiRatio,
    poincarePoints,
  };
}

function detrendLinear(signal: Float64Array): Float64Array {
  const N = signal.length;
  if (N < 4) return new Float64Array(signal);
  const mx = (N - 1) / 2;
  const my = mean(signal);
  let num = 0;
  let den = 0;
  for (let i = 0; i < N; i++) {
    const dx = i - mx;
    num += dx * (signal[i] - my);
    den += dx * dx;
  }
  const slope = den > 1e-12 ? num / den : 0;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = signal[i] - (my + slope * (i - mx));
  }
  return out;
}

function computeHannPower(signal: Float64Array, fftSize: number): Float64Array {
  // fftReal already applies a single Hann window; only subtract DC here to avoid Hann^2 main-lobe broadening
  const N = signal.length;
  const centered = new Float64Array(N);
  const m = mean(signal);
  for (let i = 0; i < N; i++) {
    centered[i] = signal[i] - m;
  }
  return fftReal(centered, fftSize);
}

function computeRespPeriodicity(signal4Hz: Float64Array): {
  brpm: number | null;
  periodicity: number;
} {
  const N = signal4Hz.length;
  if (N < Math.round(RESP_FS * 5.0)) {
    return { brpm: null, periodicity: 0 };
  }
  const minLag = Math.max(6, Math.round(1.8 * RESP_FS)); // ~33 BrPM max
  const maxLag = Math.min(Math.floor(N * 0.72), Math.round(8.0 * RESP_FS)); // covers down to ~7.5 BrPM
  if (maxLag <= minLag + 2) return { brpm: null, periodicity: 0 };

  const m = mean(signal4Hz);
  let bestLag = minLag;
  let bestR = -1;
  const corr = new Float64Array(maxLag + 1);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    const limit = N - lag;
    for (let i = 0; i < limit; i++) {
      const a = signal4Hz[i] - m;
      const b = signal4Hz[i + lag] - m;
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
    const denom = Math.sqrt(denA * denB);
    const r = denom > 1e-9 ? num / denom : 0;
    corr[lag] = r;
    if (r > bestR) {
      bestR = r;
      bestLag = lag;
    }
  }

  if (bestR < 0.22) return { brpm: null, periodicity: Math.max(0, bestR) };

  const rL = corr[bestLag - 1] ?? bestR;
  const rC = corr[bestLag];
  const rR = corr[bestLag + 1] ?? bestR;
  const denom = rL - 2 * rC + rR;
  const delta = Math.abs(denom) > 1e-9 ? (0.5 * (rL - rR)) / denom : 0;
  const refinedLag = bestLag + Math.max(-0.5, Math.min(0.5, delta));

  return {
    brpm: (60 * RESP_FS) / refinedLag,
    periodicity: bestR,
  };
}

function computeRespComponentSnr(signal4Hz: Float64Array): number {
  const fftSize = 512;
  const power = computeHannPower(signal4Hz, fftSize);
  const binResHz = RESP_FS / fftSize;
  const minBin = Math.max(1, Math.floor(0.12 / binResHz));
  const maxBin = Math.min(power.length - 2, Math.ceil(0.52 / binResHz));

  let peakBin = minBin;
  let maxPower = 0;
  let total = 0;
  for (let i = minBin; i <= maxBin; i++) {
    total += power[i];
    if (power[i] > maxPower) {
      maxPower = power[i];
      peakBin = i;
    }
  }

  // Scale spectral lobe width dynamically with the Rayleigh resolution of signal4Hz.length
  const sigHalfHz = Math.max(0.05, 1.45 * (RESP_FS / Math.max(16, signal4Hz.length)));
  const halfBins = Math.max(2, Math.round(sigHalfHz / binResHz));
  let sigPower = 0;
  for (let i = minBin; i <= maxBin; i++) {
    if (Math.abs(i - peakBin) <= halfBins) sigPower += power[i];
  }
  const noise = Math.max(1e-12, total - sigPower);
  return 10 * Math.log10(Math.max(0.05, sigPower / noise));
}

/**
 * Computes normalized cross-correlation coherence (%) between
 * Respiratory Sinus Arrhythmia (RIFV) and Amplitude Modulation (RIAV)
 * across lags up to ±1.5s to measure cardiorespiratory synchronization.
 */
function computeCardiorespiratoryCoherence(
  a: Float64Array,
  b: Float64Array
): number | null {
  const N = Math.min(a.length, b.length);
  if (N < RESP_FS * 8) return null;

  const sa = stdDev(a);
  const sb = stdDev(b);
  if (sa < 1e-6 || sb < 1e-6) return null;

  const ma = mean(a);
  const mb = mean(b);
  const maxLag = Math.round(1.5 * RESP_FS); // ±6 samples at 4 Hz
  let bestCorr = 0;

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < N; i++) {
      const j = i + lag;
      if (j < 0 || j >= N) continue;
      const va = a[i] - ma;
      const vb = b[j] - mb;
      num += va * vb;
      denA += va * va;
      denB += vb * vb;
    }
    const denom = Math.sqrt(denA * denB);
    if (denom > 1e-9) {
      const corr = Math.abs(num / denom);
      if (corr > bestCorr) bestCorr = corr;
    }
  }

  return Math.max(0, Math.min(99, Math.round(bestCorr * 100)));
}

function filterAnchorOutliers(
  anchors: Array<{ idx: number; val: number }>,
  minAllowed: number,
  maxAllowed: number,
  madFactor = 3.0
): Array<{ idx: number; val: number }> {
  if (anchors.length < 5) {
    return anchors.filter((a) => a.val >= minAllowed && a.val <= maxAllowed);
  }
  const sorted = anchors.map((a) => a.val).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const devs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = Math.max(1e-6, devs[Math.floor(devs.length / 2)] * 1.4826);
  const lo = Math.max(minAllowed, med - madFactor * mad);
  const hi = Math.min(maxAllowed, med + madFactor * mad);
  return anchors.map((a) => ({
    idx: a.idx,
    val: Math.max(lo, Math.min(hi, a.val)),
  }));
}

function interpolateAnchorsCatmullRom(
  anchors: Array<{ idx: number; val: number }>,
  outLen: number
): Float64Array {
  const out = new Float64Array(outLen);
  if (anchors.length === 0) return out;
  if (anchors.length === 1) {
    out.fill(anchors[0].val);
    return out;
  }
  let aIdx = 0;
  for (let i = 0; i < outLen; i++) {
    if (i <= anchors[0].idx) {
      out[i] = anchors[0].val;
    } else if (i >= anchors[anchors.length - 1].idx) {
      out[i] = anchors[anchors.length - 1].val;
    } else {
      while (aIdx < anchors.length - 2 && anchors[aIdx + 1].idx < i) aIdx++;
      const b0 = anchors[Math.max(0, aIdx - 1)];
      const b1 = anchors[aIdx];
      const b2 = anchors[aIdx + 1];
      const b3 = anchors[Math.min(anchors.length - 1, aIdx + 2)];
      const span = b2.idx - b1.idx || 1;
      const t = (i - b1.idx) / span;
      const interp = catmullRomEval(b0.val, b1.val, b2.val, b3.val, t);
      const lin = b1.val + t * (b2.val - b1.val);
      const lo = Math.min(b1.val, b2.val);
      const hi = Math.max(b1.val, b2.val);
      const overshootAllowance = Math.max(1e-6, (hi - lo) * 0.25);
      // Bounded Catmull-Rom prevents spline ringing while keeping smooth RSA respiratory inflection
      out[i] = Math.max(
        lo - overshootAllowance,
        Math.min(hi + overshootAllowance, 0.75 * interp + 0.25 * lin)
      );
    }
  }
  return out;
}

function estimateRespiration(
  r30: Float64Array,
  g30: Float64Array,
  b30: Float64Array,
  durationSec: number,
  nowMs: number,
  algorithm: RppgAlgorithm,
  mode: CaptureMode,
  signalState: SignalQualityState,
  respTracker?: RespirationTracker,
  priorBpm?: number | null
): {
  respirationBrpm: number | null;
  respSnrDb: number;
  respFreqHz: number | null;
  respWaveform: number[];
  respPeakIndices: number[];
  coherencePct: number | null;
  respStatus: RespStatus;
  breathHoldSeconds: number;
  respModulationPct: number;
} {
  const N = g30.length;
  if (N < TARGET_FS * 4) {
    return {
      respirationBrpm: null,
      respSnrDb: 0,
      respFreqHz: null,
      respWaveform: [],
      respPeakIndices: [],
      coherencePct: null,
      respStatus: "calibrating",
      breathHoldSeconds: 0,
      respModulationPct: 0,
    };
  }

  // Use 7-way consensus fused BVP across the full respiratory window when algorithm === "FUSION"
  // instead of noisy single-extractor signal so RIAV & RSA/RIFV inherit full +3 dB fusion clarity
  const cardiacBvp =
    algorithm === "FUSION" && mode !== "finger"
      ? extractBandpassedByAlgorithm(r30, g30, b30, algorithm, mode, TARGET_FS, priorBpm).filtered
      : zeroPhaseBandpass(
          detrendSlidingMean(
            selectBvpSignal(r30, g30, b30, algorithm, mode, TARGET_FS),
            Math.round(TARGET_FS * 0.75)
          ),
          TARGET_FS,
          0.7,
          3.5
        );

  const sigmaCard = stdDev(cardiacBvp) || 1;
  const refractorySec =
    priorBpm && priorBpm >= 42 && priorBpm <= 190
      ? Math.max(0.30, Math.min(0.64, 0.54 * (60 / priorBpm)))
      : 0.32;
  const minPeakDist = Math.round(refractorySec * TARGET_FS);
  const peakIdx: number[] = [];
  for (let i = 1; i < N - 1; i++) {
    if (
      cardiacBvp[i] > sigmaCard * 0.2 &&
      cardiacBvp[i] >= cardiacBvp[i - 1] &&
      cardiacBvp[i] > cardiacBvp[i + 1]
    ) {
      if (peakIdx.length === 0) {
        peakIdx.push(i);
      } else {
        const last = peakIdx[peakIdx.length - 1];
        if (i - last >= minPeakDist) {
          peakIdx.push(i);
        } else if (cardiacBvp[i] > cardiacBvp[last]) {
          peakIdx[peakIdx.length - 1] = i;
        }
      }
    }
  }

  // Sub-sample parabolic refinement removes ±33.3 ms step quantization sawtooth (~±3 BPM jitter) from RIFV/RSA
  const peakFrac = peakIdx.map((pk) => {
    if (pk <= 0 || pk >= N - 1) return pk;
    const yL = cardiacBvp[pk - 1];
    const yC = cardiacBvp[pk];
    const yR = cardiacBvp[pk + 1];
    const denom = yL - 2 * yC + yR;
    const delta = Math.abs(denom) > 1e-9 ? (0.5 * (yL - yR)) / denom : 0;
    return pk + Math.max(-0.5, Math.min(0.5, delta));
  });

  const rawAmpAnchors: Array<{ idx: number; val: number }> = [];
  const rawHrAnchors: Array<{ idx: number; val: number }> = [];

  for (let p = 0; p < peakIdx.length; p++) {
    const pk = peakIdx[p];
    const searchStart =
      p === 0 ? Math.max(0, pk - Math.round(0.5 * TARGET_FS)) : peakIdx[p - 1];
    let minVal = cardiacBvp[pk];
    for (let k = searchStart; k < pk; k++) {
      if (cardiacBvp[k] < minVal) minVal = cardiacBvp[k];
    }
    rawAmpAnchors.push({ idx: pk, val: Math.max(0, cardiacBvp[pk] - minVal) });

    if (p > 0) {
      const dtSec = (peakFrac[p] - peakFrac[p - 1]) / TARGET_FS;
      if (dtSec >= 0.33 && dtSec <= 1.45) {
        rawHrAnchors.push({ idx: pk, val: 60 / dtSec });
      }
    }
  }

  const ampAnchors = filterAnchorOutliers(rawAmpAnchors, 0, Infinity, 3.0);
  const hrAnchors = filterAnchorOutliers(rawHrAnchors, 40, 195, 2.8);

  let riav30: Float64Array;
  if (ampAnchors.length >= 4) {
    riav30 = interpolateAnchorsCatmullRom(ampAnchors, N);
  } else {
    riav30 = new Float64Array(N);
    const halfWin = Math.round(0.35 * TARGET_FS);
    for (let i = 0; i < N; i++) {
      let acc = 0,
        cnt = 0;
      for (let k = Math.max(0, i - halfWin); k <= Math.min(N - 1, i + halfWin); k++) {
        acc += Math.abs(cardiacBvp[k]);
        cnt++;
      }
      riav30[i] = cnt > 0 ? acc / cnt : 0;
    }
  }

  const hasRifv = hrAnchors.length >= 5;
  const rifv30 = hasRifv
    ? interpolateAnchorsCatmullRom(hrAnchors, N)
    : new Float64Array(N);

  const stride = TARGET_FS / RESP_FS;
  const outLen = Math.floor(N / stride);
  if (outLen < 16) {
    return {
      respirationBrpm: null,
      respSnrDb: 0,
      respFreqHz: null,
      respWaveform: [],
      respPeakIndices: [],
      coherencePct: null,
      respStatus: "calibrating",
      breathHoldSeconds: 0,
      respModulationPct: 0,
    };
  }

  const mg = mean(g30) || 1;
  const riav4 = new Float64Array(outLen);
  const riiv4 = new Float64Array(outLen);
  const rifv4 = new Float64Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const s = Math.floor(i * stride);
    const e = Math.min(N, Math.floor((i + 1) * stride));
    let sumA = 0,
      sumI = 0,
      sumF = 0,
      cnt = 0;
    for (let k = s; k < e; k++) {
      sumA += riav30[k];
      sumI += -(g30[k] / mg - 1);
      if (hasRifv) sumF += rifv30[k];
      cnt++;
    }
    riav4[i] = cnt > 0 ? sumA / cnt : 0;
    riiv4[i] = cnt > 0 ? sumI / cnt : 0;
    rifv4[i] = cnt > 0 && hasRifv ? sumF / cnt : 0;
  }

  // Linear detrend avoids sliding-window boundary curvature on 10–12s buffers
  const filtRiav = zeroPhaseBandpass(detrendLinear(riav4), RESP_FS, 0.12, 0.55);
  const filtRiiv = zeroPhaseBandpass(detrendLinear(riiv4), RESP_FS, 0.12, 0.55);
  const filtRifv = hasRifv
    ? zeroPhaseBandpass(detrendLinear(rifv4), RESP_FS, 0.12, 0.55)
    : new Float64Array(outLen);

  const stdA = stdDev(filtRiav) || 1;
  const stdI = stdDev(filtRiiv) || 1;
  const stdF = stdDev(filtRifv) || 1;

  // Un-normalized physical respiratory modulation signals (preserves true amplitude collapse during breath-hold)
  const meanRiav = Math.max(1e-4, mean(riav4));
  const relRiav = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    relRiav[i] = filtRiav[i] / meanRiav;
  }

  const localRms = (arr: Float64Array, center: number, halfW: number) => {
    const lo = Math.max(0, center - halfW);
    const hi = Math.min(arr.length - 1, center + halfW);
    let sq = 0;
    let cnt = 0;
    for (let k = lo; k <= hi; k++) {
      sq += arr[k] * arr[k];
      cnt++;
    }
    return cnt > 0 ? Math.sqrt(sq / cnt) : 0;
  };

  const snrA = computeRespComponentSnr(filtRiav);
  const snrI = computeRespComponentSnr(filtRiiv);
  const snrF = hasRifv ? computeRespComponentSnr(filtRifv) : -20;

  // Separate cardiac-coupled envelope (RIAV + RSA/RIFV) from raw green intensity drift (RIIV)
  const rawCardiacEnv = new Float64Array(outLen);
  const rawCompositeEnv = new Float64Array(outLen);
  const riivTrust = snrI >= 0.8 ? 0.18 : 0.08;
  for (let i = 0; i < outLen; i++) {
    const normA = localRms(relRiav, i, 4) / 0.052;
    const normI = localRms(filtRiiv, i, 4) / 0.00062;
    const normF = hasRifv ? localRms(filtRifv, i, 4) / 1.45 : 0;
    const cardEnv = hasRifv ? 0.64 * normA + 0.36 * normF : normA;
    rawCardiacEnv[i] = cardEnv;
    rawCompositeEnv[i] = (1 - riivTrust) * cardEnv + riivTrust * normI;
  }

  // 3-tap smoothing prevents 1 noisy webcam frame from breaking consecutive hold tracking
  const cardiacEnv = new Float64Array(outLen);
  const compositeEnv = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const prev = Math.max(0, i - 1);
    const next = Math.min(outLen - 1, i + 1);
    cardiacEnv[i] =
      0.25 * rawCardiacEnv[prev] + 0.5 * rawCardiacEnv[i] + 0.25 * rawCardiacEnv[next];
    compositeEnv[i] =
      0.25 * rawCompositeEnv[prev] + 0.5 * rawCompositeEnv[i] + 0.25 * rawCompositeEnv[next];
  }

  // Evaluate recent ~4.75s modulation vs earlier & tracker-learned personal baseline
  const recentTailLen = Math.min(outLen, 19); // 4.75s at 4 Hz
  const recentEnv = mean(compositeEnv.subarray(outLen - recentTailLen));
  const recentCardiacEnv = mean(cardiacEnv.subarray(outLen - recentTailLen));

  const earlierEnd = Math.max(0, outLen - recentTailLen);
  let earlierBaselineEnv = 0;
  let earlierCardiacBaseline = 0;
  if (earlierEnd >= 10) {
    const earlierSorted = Array.from(compositeEnv.subarray(0, earlierEnd)).sort(
      (a, b) => a - b
    );
    earlierBaselineEnv = earlierSorted[Math.floor(earlierSorted.length * 0.72)];
    const earlierCardSorted = Array.from(cardiacEnv.subarray(0, earlierEnd)).sort(
      (a, b) => a - b
    );
    earlierCardiacBaseline = earlierCardSorted[Math.floor(earlierCardSorted.length * 0.72)];
  }

  const learned = respTracker?.getLearnedBaseline() ?? { env: 0, cardiacEnv: 0 };
  const effectiveBaselineEnv = Math.max(earlierBaselineEnv, learned.env);
  const effectiveCardBaseline = Math.max(earlierCardiacBaseline, learned.cardiacEnv);

  const corrIA = Math.abs(pearsonCorrelation(filtRiiv, filtRiav));
  const riivAlignedFactor =
    corrIA >= 0.35 ? 1.0 : corrIA >= 0.22 || !hasRifv ? 0.45 : 0.14;
  const wA = Math.exp(Math.min(7.5, Math.max(-4, snrA)) / 3.8) * 1.65;
  const wI =
    Math.exp(Math.min(5.5, Math.max(-4, snrI)) / 3.8) *
    (snrI >= 0.5 ? 0.44 : 0.22) *
    riivAlignedFactor;
  const wF = hasRifv
    ? Math.exp(Math.min(7.5, Math.max(-4, snrF)) / 3.8) * 1.3
    : 0;
  const wSum = wA + wI + wF || 1;

  const fused = new Float64Array(outLen);
  const fusedCardUnnorm = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    fused[i] =
      (wA * (filtRiav[i] / stdA) +
        wI * (filtRiiv[i] / stdI) +
        wF * (filtRifv[i] / stdF)) /
      wSum;
    fusedCardUnnorm[i] =
      (wA * relRiav[i] + (hasRifv ? wF * (filtRifv[i] / 24) : 0)) /
      (wA + (hasRifv ? wF : 0) || 1);
  }

  // 9.0s tail (36 samples) covers full period of slow 10–14 BrPM breathing while spotting 4–6s holds
  const recentFusedLen = Math.min(outLen, 36);
  const recentRespSnrDb =
    recentFusedLen >= 20
      ? computeRespComponentSnr(fusedCardUnnorm.subarray(outLen - recentFusedLen))
      : 0;
  const recentAutocorr =
    recentFusedLen >= 22
      ? computeRespPeriodicity(fusedCardUnnorm.subarray(outLen - recentFusedLen))
      : { brpm: null, periodicity: 0 };

  const holdThresh =
    effectiveBaselineEnv >= 0.40 ? Math.max(0.30, effectiveBaselineEnv * 0.50) : 0.36;
  const cardHoldThresh =
    effectiveCardBaseline >= 0.35 ? Math.max(0.28, effectiveCardBaseline * 0.54) : 0.38;

  // Tolerate up to 1 momentary micro-glitch sample in tail so single-frame noise doesn't reset hold count
  let suppressedSamples = 0;
  let blipBudget = 1;
  for (let i = outLen - 1; i >= 0; i--) {
    const isSuppressed =
      compositeEnv[i] < holdThresh || cardiacEnv[i] < cardHoldThresh;
    if (isSuppressed) {
      suppressedSamples++;
    } else if (blipBudget > 0 && i < outLen - 2) {
      blipBudget--;
      suppressedSamples++;
    } else {
      break;
    }
  }
  const rawHoldSec = suppressedSamples / RESP_FS;

  // Multi-evidence continuous breath-hold score (0..1)
  let holdScore = 0;
  if (effectiveBaselineEnv >= 0.36 || effectiveCardBaseline >= 0.35) {
    const dropRatio =
      effectiveBaselineEnv > 0.25 ? recentEnv / effectiveBaselineEnv : 1;
    const cardDropRatio =
      effectiveCardBaseline > 0.25 ? recentCardiacEnv / effectiveCardBaseline : dropRatio;
    const bestDrop = Math.min(dropRatio, cardDropRatio);
    if (bestDrop <= 0.40) holdScore += 0.56;
    else if (bestDrop <= 0.54) holdScore += 0.42;
    else if (bestDrop <= 0.65) holdScore += 0.22;
  }

  if (recentCardiacEnv < 0.32) holdScore += 0.46;
  else if (recentCardiacEnv < 0.42) holdScore += 0.30;
  else if (recentCardiacEnv < 0.50 && recentEnv < 0.50) holdScore += 0.14;

  if (rawHoldSec >= 4.2) holdScore += 0.36;
  else if (rawHoldSec >= 3.0) holdScore += 0.24;

  if (recentAutocorr.periodicity < 0.30 && recentRespSnrDb < 1.2) {
    holdScore += 0.24;
  } else if (recentAutocorr.periodicity >= 0.52 && recentRespSnrDb >= 1.8) {
    holdScore -= 0.34; // Strong rhythmic cardiac-coupled breathing opposes hold classification
  }
  holdScore = Math.max(0, Math.min(1, holdScore));

  const signalBlocked =
    signalState === "no_skin" ||
    signalState === "low_light" ||
    signalState === "motion";

  let isBreathHold = false;
  let breathHoldSeconds = 0;
  if (respTracker) {
    const trackedHold = respTracker.updateHoldState({
      durationSec,
      nowMs,
      holdScore,
      recentEnv,
      recentCardiacEnv,
      recentSnrDb: recentRespSnrDb,
      recentPeriodicity: recentAutocorr.periodicity,
      rawHoldSec,
      signalBlocked,
    });
    isBreathHold = trackedHold.isHold;
    breathHoldSeconds = trackedHold.holdSeconds;
  } else {
    isBreathHold =
      durationSec >= 7.5 &&
      !signalBlocked &&
      (holdScore >= 0.58 || (rawHoldSec >= 4.0 && recentCardiacEnv < 0.42));
    breathHoldSeconds = isBreathHold
      ? Number(Math.max(3.8, rawHoldSec).toFixed(1))
      : 0;
  }

  const respModulationPct = Math.max(
    0,
    Math.min(100, Math.round(recentCardiacEnv * 45))
  );

  // Attenuate waveform regions where physical modulation collapsed so breath-hold visibly flattens
  const fusedStd = stdDev(fused) || 1;
  const waveScaleBase = Math.max(0.48, effectiveCardBaseline * 0.78);
  const respWaveform = Array.from(fused).map((v, idx) => {
    const localEnv = Math.min(compositeEnv[idx], cardiacEnv[idx] * 1.15);
    const envGain = Math.min(1, Math.max(0.05, localEnv / waveScaleBase));
    return Math.max(-3.0, Math.min(3.0, (v / fusedStd) * envGain));
  });

  const respPeakIndices: number[] = [];
  const minBreathDist = Math.round(1.8 * RESP_FS);
  for (let i = 1; i < respWaveform.length - 1; i++) {
    if (
      respWaveform[i] > 0.25 &&
      respWaveform[i] >= respWaveform[i - 1] &&
      respWaveform[i] > respWaveform[i + 1]
    ) {
      if (respPeakIndices.length === 0) {
        respPeakIndices.push(i);
      } else {
        const last = respPeakIndices[respPeakIndices.length - 1];
        if (i - last >= minBreathDist) {
          respPeakIndices.push(i);
        } else if (respWaveform[i] > respWaveform[last]) {
          respPeakIndices[respPeakIndices.length - 1] = i;
        }
      }
    }
  }

  // Hann-windowed 1024-pt FFT (0.234 BrPM/bin) + Welch segment blend + subharmonic guard
  const fftSize = 1024;
  const fullPower = computeHannPower(fused, fftSize);
  let power = fullPower;
  const welchWin = Math.round(RESP_FS * 12);
  const welchStep = Math.round(RESP_FS * 3);
  if (outLen >= Math.round(RESP_FS * 15) && outLen > welchWin) {
    const welchAcc = new Float64Array(fullPower.length);
    let segCnt = 0;
    for (let s = 0; s <= outLen - welchWin; s += welchStep) {
      const segPow = computeHannPower(fused.subarray(s, s + welchWin), fftSize);
      for (let i = 0; i < welchAcc.length; i++) welchAcc[i] += segPow[i];
      segCnt++;
    }
    if (segCnt > 0) {
      const blended = new Float64Array(fullPower.length);
      for (let i = 0; i < fullPower.length; i++) {
        blended[i] = 0.55 * fullPower[i] + 0.45 * (welchAcc[i] / segCnt);
      }
      power = blended;
    }
  }

  const binResHz = RESP_FS / fftSize;
  const minBin = Math.max(1, Math.floor(0.11 / binResHz));
  const maxBin = Math.min(power.length - 2, Math.ceil(0.54 / binResHz));

  const fullAutocorr = computeRespPeriodicity(fused);
  const priorEstBrpm = respTracker?.isLocked() ? respTracker.getEstimate() : null;

  let peakBin = minBin;
  let maxScore = 0;
  let maxPower = 0;
  let totalBandPower = 0;
  for (let i = minBin; i <= maxBin; i++) {
    totalBandPower += power[i];
    if (power[i] > maxPower) maxPower = power[i];
    let score = power[i];
    const candBrpm = i * binResHz * 60;
    if (fullAutocorr.brpm !== null && fullAutocorr.periodicity >= 0.4) {
      const diffAc = Math.abs(candBrpm - fullAutocorr.brpm);
      if (diffAc <= 2.5) score *= 1.32;
    }
    if (priorEstBrpm !== null) {
      const diffPrior = Math.abs(candBrpm - priorEstBrpm);
      if (diffPrior <= 3.0) score *= 1.18;
    }
    if (score > maxScore) {
      maxScore = score;
      peakBin = i;
    }
  }

  // Prevent 2x respiratory harmonic locking when true slow breathing (e.g. 12 BrPM -> 24 BrPM) is present
  const candRespFreq = peakBin * binResHz;
  if (candRespFreq > 0.30) {
    const subBin = Math.round(peakBin / 2);
    if (subBin >= minBin && subBin <= maxBin) {
      let localSubMax = 0;
      let localSubBin = subBin;
      for (
        let k = Math.max(minBin, subBin - 4);
        k <= Math.min(maxBin, subBin + 4);
        k++
      ) {
        if (power[k] > localSubMax) {
          localSubMax = power[k];
          localSubBin = k;
        }
      }
      if (localSubMax >= power[peakBin] * 0.50) {
        peakBin = localSubBin;
        maxPower = localSubMax;
      }
    }
  }

  const pL = power[peakBin - 1] ?? 0;
  const pC = power[peakBin] ?? 0;
  const pR = power[peakBin + 1] ?? 0;
  const denom = pL - 2 * pC + pR;
  const delta = Math.abs(denom) > 1e-12 ? (0.5 * (pL - pR)) / denom : 0;
  const refinedBin = peakBin + Math.max(-0.5, Math.min(0.5, delta));
  const respFreqHz = refinedBin * binResHz;
  let rawBrpm = Math.round(respFreqHz * 60);

  // Blend with high-confidence autocorrelation if close (sub-bin stability)
  if (
    fullAutocorr.brpm !== null &&
    fullAutocorr.periodicity >= 0.55 &&
    Math.abs(fullAutocorr.brpm - rawBrpm) <= 2.5
  ) {
    rawBrpm = Math.round(0.65 * rawBrpm + 0.35 * fullAutocorr.brpm);
  }

  const halfBins = Math.max(3, Math.round(0.05 / binResHz));
  let sigPower = 0;
  for (let i = minBin; i <= maxBin; i++) {
    if (Math.abs(i - peakBin) <= halfBins) sigPower += power[i];
  }
  const noisePower = Math.max(1e-12, totalBandPower - sigPower);
  const respSnrDb = Number(
    (10 * Math.log10(Math.max(0.05, sigPower / noisePower))).toFixed(1)
  );

  const rawValidBrpm =
    !isBreathHold &&
    durationSec >= MIN_SECONDS_FOR_RESPIRATION &&
    respSnrDb >= 0.0 &&
    !signalBlocked
      ? rawBrpm
      : null;

  const finalBrpm = respTracker
    ? respTracker.updateBrpm(
        rawValidBrpm,
        respSnrDb,
        fullAutocorr.periodicity,
        signalState === "motion",
        isBreathHold
      )
    : rawValidBrpm;

  const validResp = !isBreathHold ? finalBrpm : null;

  const coherencePct =
    !isBreathHold && validResp !== null && hasRifv
      ? computeCardiorespiratoryCoherence(filtRiav, filtRifv)
      : null;

  const respStatus: RespStatus =
    signalState === "no_skin" || signalState === "low_light"
      ? "low_signal"
      : isBreathHold
      ? "breath_hold"
      : validResp !== null
      ? "breathing"
      : durationSec < MIN_SECONDS_FOR_RESPIRATION
      ? "calibrating"
      : "low_signal";

  return {
    respirationBrpm: validResp,
    respSnrDb: isBreathHold
      ? Number(Math.min(respSnrDb, recentRespSnrDb).toFixed(1))
      : respSnrDb,
    respFreqHz: validResp ? Number((validResp / 60).toFixed(3)) : null,
    respWaveform,
    respPeakIndices,
    coherencePct,
    respStatus,
    breathHoldSeconds,
    respModulationPct,
  };
}

export function analyzeRppgBuffer(
  samples: RgbSample[],
  algorithm: RppgAlgorithm,
  mode: CaptureMode,
  options?: {
    enableNlms?: boolean;
    enableAwb?: boolean;
    kalman?: KalmanBpmTracker;
    respTracker?: RespirationTracker;
  }
): RppgMetrics {
  const enableNlms = options?.enableNlms ?? true;
  const enableAwb = options?.enableAwb ?? true;
  const n = samples.length;
  const recent = samples.slice(-30);
  const avgMotion =
    recent.length > 0
      ? recent.reduce((acc, s) => acc + s.motion, 0) / recent.length
      : 0;
  const avgSkin =
    recent.length > 0
      ? recent.reduce((acc, s) => acc + s.skinPct, 0) / recent.length
      : 0;
  const avgLuma =
    recent.length > 0
      ? recent.reduce((acc, s) => acc + s.luma, 0) / recent.length
      : 0;
  const avgSpec =
    recent.length > 0
      ? recent.reduce((acc, s) => acc + (s.specularRejectedPct ?? 0), 0) /
        recent.length
      : 0;

  let fps = 0;
  if (recent.length >= 2) {
    const dtSec = (recent[recent.length - 1].t - recent[0].t) / 1000;
    fps = dtSec > 0 ? Math.round((recent.length - 1) / dtSec) : 0;
  }

  const uniform = resampleUniform(
    samples,
    TARGET_FS,
    MAX_RESP_WINDOW_SECONDS,
    enableNlms,
    enableAwb,
    mode
  );

  if (n < 15 || uniform.r.length < 24) {
    return {
      bpm: null,
      rawFftBpm: null,
      confidence: 0,
      snrDb: 0,
      ambientCanceledDb: 0,
      awb: uniform.awb,
      algoWeights:
        algorithm === "FUSION"
          ? { pos: 22, chrom: 18, omit: 18, pbv: 14, lgi: 14, ica: 8, green: 6 }
          : {
              pos: algorithm === "POS" && mode !== "finger" ? 100 : 0,
              chrom: algorithm === "CHROM" && mode !== "finger" ? 100 : 0,
              omit: algorithm === "OMIT" && mode !== "finger" ? 100 : 0,
              pbv: algorithm === "PBV" && mode !== "finger" ? 100 : 0,
              lgi: algorithm === "LGI" && mode !== "finger" ? 100 : 0,
              ica: algorithm === "ICA" && mode !== "finger" ? 100 : 0,
              green: algorithm === "GREEN" || mode === "finger" ? 100 : 0,
            },
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      lfHfRatio: null,
      sqiPct: 0,
      coherencePct: null,
      poincarePoints: [],
      respirationBrpm: null,
      respSnrDb: 0,
      respFreqHz: null,
      respWaveform: [],
      respPeakIndices: [],
      respStatus: "calibrating",
      breathHoldSeconds: 0,
      respModulationPct: 0,
      roiWeights: { forehead: 34, leftCheek: 33, rightCheek: 33 },
      fps,
      skinCoveragePct: Math.round(avgSkin),
      brightness: Math.round(avgLuma),
      motionIndex: Number(avgMotion.toFixed(1)),
      specularRejectedPct: Number(avgSpec.toFixed(1)),
      signalState: n === 0 ? "idle" : "calibrating",
      waveform: [],
      peakIndices: [],
      spectrum: [],
      dominantFreqHz: null,
      bufferSeconds: Number(uniform.durationSec.toFixed(1)),
    };
  }

  const cardiacMaxSamples = Math.floor(MAX_CARDIAC_WINDOW_SECONDS * TARGET_FS);
  const cardStart = Math.max(0, uniform.r.length - cardiacMaxSamples);

  const r = uniform.r.subarray(cardStart);
  const g = uniform.g.subarray(cardStart);
  const b = uniform.b.subarray(cardStart);

  let filtered: Float64Array;
  let roiWeights = { forehead: 34, leftCheek: 33, rightCheek: 33 };
  let algoWeights: AlgoWeightsBreakdown = {
    pos: 100,
    chrom: 0,
    omit: 0,
    pbv: 0,
    lgi: 0,
    ica: 0,
    green: 0,
  };
  let roiCoherenceScore = 0.75;

  const regionPriorBpm = options?.kalman?.isLocked()
    ? options.kalman.getEstimate()
    : null;

  if (
    mode !== "finger" &&
    uniform.forehead &&
    uniform.leftCheek &&
    uniform.rightCheek
  ) {
    const regions = [
      { key: "forehead" as const, ch: uniform.forehead },
      { key: "leftCheek" as const, ch: uniform.leftCheek },
      { key: "rightCheek" as const, ch: uniform.rightCheek },
    ];

    const regionSignals: Array<{
      key: "forehead" | "leftCheek" | "rightCheek";
      sig: Float64Array;
      rawWeight: number;
      algoW: AlgoWeightsBreakdown;
    }> = [];

    for (const reg of regions) {
      if (reg.ch.validRatio < 0.25) {
        regionSignals.push({
          key: reg.key,
          sig: new Float64Array(r.length),
          rawWeight: 0,
          algoW: { pos: 0, chrom: 0, omit: 0, pbv: 0, lgi: 0, ica: 0, green: 0 },
        });
        continue;
      }
      const resReg = extractBandpassedByAlgorithm(
        reg.ch.r.subarray(cardStart),
        reg.ch.g.subarray(cardStart),
        reg.ch.b.subarray(cardStart),
        algorithm,
        mode,
        TARGET_FS,
        regionPriorBpm
      );
      const filtR = resReg.filtered;
      const specR = evaluateCardiacSpectrum(filtR, TARGET_FS, regionPriorBpm);
      const sd = stdDev(filtR) || 1;
      const normSig = new Float64Array(filtR.length);
      for (let i = 0; i < filtR.length; i++) normSig[i] = filtR[i] / sd;

      const prior = reg.key === "forehead" ? 1.15 : 1.0;
      const w = prior * Math.exp(Math.max(-5, Math.min(18, specR.snrDb)) / 3.2);
      regionSignals.push({
        key: reg.key,
        sig: normSig,
        rawWeight: w,
        algoW: resReg.weights,
      });
    }

    const baseTotalW = regionSignals.reduce((acc, item) => acc + item.rawWeight, 0);
    if (baseTotalW > 0) {
      filtered = new Float64Array(r.length);
      const refSig = regionSignals.reduce(
        (best, cur) => (cur.rawWeight > best.rawWeight ? cur : best),
        regionSignals[0]
      ).sig;

      // Inter-ROI spatial correlation weighting (pyVHR patch coherence)
      let corrAcc = 0;
      let corrCnt = 0;
      const alignedEntries = regionSignals.map((item) => {
        const alignedSig = alignPolarityToRef(item.sig, refSig);
        const corr =
          item.rawWeight > 0 ? Math.max(0, pearsonCorrelation(alignedSig, refSig)) : 0;
        if (item.rawWeight > 0) {
          corrAcc += corr;
          corrCnt++;
        }
        return {
          ...item,
          alignedSig,
          cohWeight: item.rawWeight * (0.45 + 0.55 * corr),
        };
      });
      if (corrCnt > 0) {
        roiCoherenceScore = corrAcc / corrCnt;
      }

      const totalW = alignedEntries.reduce((acc, item) => acc + item.cohWeight, 0) || 1;
      let accPos = 0,
        accChrom = 0,
        accOmit = 0,
        accPbv = 0,
        accLgi = 0,
        accIca = 0;
      for (const item of alignedEntries) {
        const wNorm = item.cohWeight / totalW;
        roiWeights[item.key] = Math.round(wNorm * 100);
        accPos += wNorm * item.algoW.pos;
        accChrom += wNorm * item.algoW.chrom;
        accOmit += wNorm * item.algoW.omit;
        accPbv += wNorm * item.algoW.pbv;
        accLgi += wNorm * item.algoW.lgi;
        accIca += wNorm * item.algoW.ica;
        for (let i = 0; i < filtered.length; i++) {
          filtered[i] += wNorm * item.alignedSig[i];
        }
      }
      const pInt = Math.round(accPos);
      const cInt = Math.round(accChrom);
      const oInt = Math.round(accOmit);
      const pbvInt = Math.round(accPbv);
      const lgiInt = Math.round(accLgi);
      const iInt = Math.round(accIca);
      algoWeights = {
        pos: pInt,
        chrom: cInt,
        omit: oInt,
        pbv: pbvInt,
        lgi: lgiInt,
        ica: iInt,
        green: Math.max(0, 100 - pInt - cInt - oInt - pbvInt - lgiInt - iInt),
      };
    } else {
      const fb = extractBandpassedByAlgorithm(
        r,
        g,
        b,
        algorithm,
        mode,
        TARGET_FS,
        regionPriorBpm
      );
      filtered = fb.filtered;
      algoWeights = fb.weights;
    }
  } else {
    const fb = extractBandpassedByAlgorithm(
      r,
      g,
      b,
      algorithm,
      mode,
      TARGET_FS,
      regionPriorBpm
    );
    filtered = fb.filtered;
    algoWeights = fb.weights;
    if (mode === "finger") {
      roiWeights = { forehead: 100, leftCheek: 0, rightCheek: 0 };
      roiCoherenceScore = 0.9;
    }
  }

  const displayLen = Math.min(180, filtered.length);
  const displaySlice = Array.from(
    filtered.slice(filtered.length - displayLen)
  );
  const displayStd = stdDev(displaySlice) || 1;
  const normalizedWave = displaySlice.map((v) =>
    Math.max(-3.2, Math.min(3.2, v / displayStd))
  );

  const priorLockedBpm = options?.kalman?.isLocked()
    ? options.kalman.getEstimate()
    : null;

  const { power, binResHz, maxPower, dominantFreqHz, snrDb } =
    evaluateCardiacSpectrum(filtered, TARGET_FS, priorLockedBpm);
  const rawEstimatedBpm = Math.round(dominantFreqHz * 60);

  const spectrum: SpectrumBin[] = [];
  const specStart = Math.floor(0.6 / binResHz);
  const specEnd = Math.min(power.length - 1, Math.ceil(3.5 / binResHz));
  const normBase = maxPower > 0 ? maxPower : 1;
  for (let i = specStart; i <= specEnd; i++) {
    const f = i * binResHz;
    spectrum.push({
      freqHz: Number(f.toFixed(3)),
      bpm: Math.round(f * 60),
      power: Number((power[i] / normBase).toFixed(3)),
    });
  }

  // Compute HRV & Poincaré geometry across full cardiac window (up to 12s)
  const fullCardSlice = Array.from(filtered);
  const fullCardStd = stdDev(fullCardSlice) || 1;
  const fullCardNorm = fullCardSlice.map((v) => v / fullCardStd);
  const hrvStats = detectSystolicPeaksAndPoincare(
    fullCardNorm,
    TARGET_FS,
    rawEstimatedBpm
  );

  // Peak indices specifically inside the 6s visible oscilloscope trace
  const wavePeaks = detectSystolicPeaksAndPoincare(
    normalizedWave,
    TARGET_FS,
    rawEstimatedBpm
  ).peakIndices;

  let signalState: SignalQualityState = "calibrating";
  if (avgSkin < 15) {
    signalState = "no_skin";
  } else if (avgLuma < 42) {
    signalState = "low_light";
  } else if (avgMotion > 11.5) {
    signalState = "motion";
  } else if (uniform.durationSec < MIN_SECONDS_FOR_ESTIMATE) {
    signalState = "calibrating";
  } else if (snrDb >= 1.0) {
    signalState = "nominal";
  } else {
    signalState = "motion";
  }

  const confidence =
    uniform.durationSec < MIN_SECONDS_FOR_ESTIMATE
      ? Math.round((uniform.durationSec / MIN_SECONDS_FOR_ESTIMATE) * 35)
      : Math.max(
          0,
          Math.min(
            99,
            Math.round(45 + snrDb * 6.5 - Math.max(0, avgMotion - 3) * 3)
          )
        );

  const sqiPct =
    uniform.durationSec < MIN_SECONDS_FOR_ESTIMATE
      ? Math.round((uniform.durationSec / MIN_SECONDS_FOR_ESTIMATE) * 35)
      : Math.max(
          0,
          Math.min(
            99,
            Math.round(
              Math.max(0, Math.min(1, (snrDb + 2) / 14)) * 45 +
                roiCoherenceScore * 30 +
                hrvStats.cleanIbiRatio * 25 -
                Math.max(0, avgMotion - 4) * 2
            )
          )
        );

  const validRawBpm =
    uniform.durationSec >= MIN_SECONDS_FOR_ESTIMATE &&
    snrDb >= 0.5 &&
    signalState !== "no_skin"
      ? rawEstimatedBpm
      : null;

  const kalmanBpm = options?.kalman
    ? options.kalman.update(
        validRawBpm,
        snrDb,
        signalState === "motion" || signalState === "no_skin"
      )
    : validRawBpm;

  const latestTimeMs = samples[n - 1]?.t ?? uniform.durationSec * 1000;
  const resp = estimateRespiration(
    uniform.r,
    uniform.g,
    uniform.b,
    uniform.durationSec,
    latestTimeMs,
    algorithm,
    mode,
    signalState,
    options?.respTracker,
    kalmanBpm ?? rawEstimatedBpm
  );

  return {
    bpm: kalmanBpm,
    rawFftBpm: validRawBpm,
    confidence,
    snrDb,
    ambientCanceledDb: uniform.ambientCanceledDb,
    awb: uniform.awb,
    algoWeights,
    rmssdMs: validRawBpm ? hrvStats.rmssdMs : null,
    sdnnMs: validRawBpm ? hrvStats.sdnnMs : null,
    sd1Ms: validRawBpm ? hrvStats.sd1Ms : null,
    sd2Ms: validRawBpm ? hrvStats.sd2Ms : null,
    lfHfRatio: validRawBpm ? hrvStats.lfHfRatio : null,
    sqiPct,
    coherencePct: resp.coherencePct,
    poincarePoints: validRawBpm ? hrvStats.poincarePoints : [],
    respirationBrpm: resp.respirationBrpm,
    respSnrDb: resp.respSnrDb,
    respFreqHz: resp.respFreqHz,
    respWaveform: resp.respWaveform,
    respPeakIndices: resp.respPeakIndices,
    respStatus: resp.respStatus,
    breathHoldSeconds: resp.breathHoldSeconds,
    respModulationPct: resp.respModulationPct,
    roiWeights,
    fps,
    skinCoveragePct: Math.round(avgSkin),
    brightness: Math.round(avgLuma),
    motionIndex: Number(avgMotion.toFixed(1)),
    specularRejectedPct: Number(avgSpec.toFixed(1)),
    signalState,
    waveform: normalizedWave,
    peakIndices: wavePeaks,
    spectrum,
    dominantFreqHz: validRawBpm ? Number(dominantFreqHz.toFixed(3)) : null,
    bufferSeconds: Number(uniform.durationSec.toFixed(1)),
  };
}

export function generateSyntheticSample(
  tMs: number,
  targetBpm: number,
  noiseLevel: number,
  targetRespBrpm = 16
): RgbSample {
  const f = targetBpm / 60;
  const fResp = targetRespBrpm / 60;
  const respPhase = (2 * Math.PI * fResp * tMs) / 1000;
  // Physiological RSA (Respiratory Sinus Arrhythmia) modulates beat timing smoothly
  const rsaFreqShift = 0.14 * Math.sin(respPhase);
  const phase = (2 * Math.PI * f * tMs) / 1000 + rsaFreqShift;

  const riavModulation = 1.0 + 0.28 * Math.sin(respPhase);
  const riivBaseline = 0.16 * Math.sin(respPhase - 0.35);

  const pulse =
    riavModulation *
    (0.72 * Math.sin(phase) +
      0.28 * Math.sin(2 * phase - 0.65) +
      0.08 * Math.sin(3 * phase - 1.1));

  // Simulated 1.9 Hz indoor LED / screen flicker present in both background & face
  const ambientFlicker = 1.45 * Math.sin((2 * Math.PI * 1.9 * tMs) / 1000);

  // Simulated slow room color-temperature drift (warm tungsten <-> cool daylight at 0.06 Hz)
  const colorDrift = Math.sin((2 * Math.PI * 0.06 * tMs) / 1000);
  const illumR = 1.0 + 0.14 * colorDrift;
  const illumG = 1.0 + 0.02 * colorDrift;
  const illumB = 1.0 - 0.16 * colorDrift;

  const motionDrift =
    noiseLevel > 0 ? Math.sin(tMs * 0.0023) * noiseLevel * 1.4 : 0;
  const rand = (Math.random() - 0.5) * noiseLevel * 0.6;

  const baseR = 186 - 0.32 * pulse - 0.08 * riivBaseline + ambientFlicker * 0.9 + motionDrift + rand;
  const baseG = 142 - 0.95 * pulse - riivBaseline + ambientFlicker + motionDrift * 1.15 + rand;
  const baseB = 124 - 0.45 * pulse - 0.12 * riivBaseline + ambientFlicker * 0.85 + motionDrift * 1.05 + rand;

  const r = baseR * illumR;
  const g = baseG * illumG;
  const b = baseB * illumB;

  const bgR = (130 + ambientFlicker * 0.9) * illumR;
  const bgG = (132 + ambientFlicker) * illumG;
  const bgB = (128 + ambientFlicker * 0.85) * illumB;

  const cheekNoise = (Math.random() - 0.5) * (noiseLevel + 0.4) * 1.8;

  return {
    t: tMs,
    r,
    g,
    b,
    bgR,
    bgG,
    bgB,
    motion: noiseLevel * 1.5 + Math.random() * 0.6,
    skinPct: 92,
    luma: 152,
    specularRejectedPct: 1.8,
    regions: {
      forehead: { r, g, b, valid: true },
      leftCheek: {
        r: (baseR + rand * 0.4) * illumR,
        g: (baseG + rand * 0.4) * illumG,
        b: (baseB + rand * 0.4) * illumB,
        valid: true,
      },
      rightCheek: {
        r: (baseR + cheekNoise) * illumR,
        g: (baseG + cheekNoise) * illumG,
        b: (baseB + cheekNoise) * illumB,
        valid: true,
      },
    },
  };
}
