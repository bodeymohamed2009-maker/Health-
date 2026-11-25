import type {
  CaptureMode,
  FaceBox,
  RoiBox,
  RoiExtractionResult,
  RoiRgbTriplet,
  ZoneGuidance,
} from "../types/rppg";
import {
  MediaPipeFaceTracker,
  type NeuralFaceMeshHint,
} from "./faceMeshDetector";

interface NativeDetectedLandmark {
  type?: string;
  locations?: Array<{ x: number; y: number }>;
}

interface NativeDetectedFace {
  boundingBox: DOMRectReadOnly;
  landmarks?: NativeDetectedLandmark[];
}

interface NativeFaceDetectorInstance {
  detect(source: HTMLVideoElement): Promise<NativeDetectedFace[]>;
}

function estimateCorrelatedColorTempK(r: number, g: number, b: number): number {
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

/**
 * Dual-mode skin tone classifier (YCbCr + Kovac RGB ratio with dim-light adaptation)
 * covering Fitzpatrick I-VI under warm and cool lighting once Von Kries AWB gains apply.
 */
function isFacialSkinPixel(r: number, g: number, b: number): boolean {
  const Y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (Y <= 24 || Y >= 244) return false;

  const Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const ycbcrSkin = Cb >= 68 && Cb <= 134 && Cr >= 129 && Cr <= 180;
  if (!ycbcrSkin) return false;

  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const rgDiff = r - g;

  if (Y < 75) {
    // Low-luma / Fitzpatrick V-VI branch: preserves shadowed skin when chroma stays in skin locus
    const dimRgbSkin =
      r > 32 &&
      g > 18 &&
      b > 10 &&
      maxC - minC >= 8 &&
      rgDiff >= 5 &&
      r > g &&
      r > b;
    return dimRgbSkin || (Cr >= 133 && Cb <= 128);
  }

  const rgbSkin =
    r > 52 &&
    g > 28 &&
    b > 16 &&
    maxC - minC > 11 &&
    rgDiff > 8 &&
    r > g &&
    r > b;

  return rgbSkin || (Cr >= 134 && Cr <= 175 && Cb >= 76 && Cb <= 128);
}

/**
 * 2D Summed-Area Table (Integral Image) over frame luminance for O(1) Haar-like box queries.
 */
function buildLumaIntegral(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Float64Array {
  const stride = width + 1;
  const sat = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowAcc = 0;
    const rowOff = y * width;
    const satRow = (y + 1) * stride;
    const prevSatRow = y * stride;
    for (let x = 0; x < width; x++) {
      const i4 = (rowOff + x) * 4;
      const luma = 0.299 * data[i4] + 0.587 * data[i4 + 1] + 0.114 * data[i4 + 2];
      rowAcc += luma;
      sat[satRow + x + 1] = sat[prevSatRow + x + 1] + rowAcc;
    }
  }
  return sat;
}

function queryBoxMean(
  sat: Float64Array,
  width: number,
  height: number,
  x0N: number,
  y0N: number,
  x1N: number,
  y1N: number
): number {
  const stride = width + 1;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x0N * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y0N * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(x1N * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(y1N * height)));
  const area = (x1 - x0) * (y1 - y0);
  if (area <= 0) return 0;
  const sum =
    sat[y1 * stride + x1] -
    sat[y0 * stride + x1] -
    sat[y1 * stride + x0] +
    sat[y0 * stride + x0];
  return sum / area;
}

/**
 * 2-Axis Velocity-Aware Kalman Face Tracker with Secondary Stabilization.
 * Tracks [cx, vx], [cy, vy], plus adaptive bounding radii and head tilt.
 */
export class KalmanFaceTracker {
  private cx = 0.5;
  private cy = 0.46;
  private vx = 0;
  private vy = 0;
  private rx = 0.2;
  private ry = 0.32;
  private tiltDeg = 0;
  private initialized = false;
  private lastTs = 0;

  // 2x2 covariance matrices for X and Y axes
  private px00 = 0.02;
  private px01 = 0;
  private px10 = 0;
  private px11 = 0.05;
  private py00 = 0.02;
  private py01 = 0;
  private py10 = 0;
  private py11 = 0.05;

  public reset(): void {
    this.cx = 0.5;
    this.cy = 0.46;
    this.vx = 0;
    this.vy = 0;
    this.rx = 0.2;
    this.ry = 0.32;
    this.tiltDeg = 0;
    this.initialized = false;
    this.lastTs = 0;
    this.px00 = 0.02;
    this.px01 = 0;
    this.px10 = 0;
    this.px11 = 0.05;
    this.py00 = 0.02;
    this.py01 = 0;
    this.py10 = 0;
    this.py11 = 0.05;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public getState(): FaceBox {
    return {
      cx: this.cx,
      cy: this.cy,
      rx: this.rx,
      ry: this.ry,
      headTiltDeg: this.tiltDeg,
    };
  }

  public predict(nowMs: number): FaceBox {
    if (!this.initialized) {
      return this.getState();
    }
    const rawDt = this.lastTs > 0 ? (nowMs - this.lastTs) / 1000 : 0.033;
    const dt = Math.max(0.01, Math.min(0.12, rawDt));
    this.lastTs = nowMs;

    // Velocity damping prevents runaway coasting during occlusion
    const damp = 0.85;
    this.cx = Math.max(0.04, Math.min(0.96, this.cx + this.vx * dt));
    this.cy = Math.max(0.04, Math.min(0.96, this.cy + this.vy * dt));
    this.vx *= damp;
    this.vy *= damp;

    const qPos = 0.00045;
    const qVel = 0.004;

    const nx00 = this.px00 + dt * (this.px10 + this.px01) + dt * dt * this.px11 + qPos;
    const nx01 = damp * (this.px01 + dt * this.px11);
    const nx10 = damp * (this.px10 + dt * this.px11);
    const nx11 = damp * damp * this.px11 + qVel;
    this.px00 = nx00;
    this.px01 = nx01;
    this.px10 = nx10;
    this.px11 = nx11;

    const ny00 = this.py00 + dt * (this.py10 + this.py01) + dt * dt * this.py11 + qPos;
    const ny01 = damp * (this.py01 + dt * this.py11);
    const ny10 = damp * (this.py10 + dt * this.py11);
    const ny11 = damp * damp * this.py11 + qVel;
    this.py00 = ny00;
    this.py01 = ny01;
    this.py10 = ny10;
    this.py11 = ny11;

    return this.getState();
  }

  public evaluateGate(obsCx: number, obsCy: number, obsRx: number): {
    inGate: boolean;
    innovation: number;
    gateRadius: number;
  } {
    const innovation = Math.hypot(obsCx - this.cx, obsCy - this.cy);
    const gateRadius = Math.max(0.19, this.rx * 1.35);
    const sizeRatio = obsRx / Math.max(0.07, this.rx);
    return {
      inGate: innovation <= gateRadius && sizeRatio >= 0.55 && sizeRatio <= 1.8,
      innovation,
      gateRadius,
    };
  }

  private kalmanUpdateAxis(
    pos: number,
    vel: number,
    p00: number,
    p01: number,
    p10: number,
    p11: number,
    obs: number,
    rMeas: number
  ): { pos: number; vel: number; p00: number; p01: number; p10: number; p11: number } {
    const innov = obs - pos;
    const s = p00 + rMeas;
    const k0 = p00 / s;
    const k1 = p10 / s;
    const nextPos = Math.max(0.04, Math.min(0.96, pos + k0 * innov));
    const nextVel = Math.max(-1.2, Math.min(1.2, vel + k1 * innov));
    return {
      pos: nextPos,
      vel: nextVel,
      p00: (1 - k0) * p00,
      p01: (1 - k0) * p01,
      p10: p10 - k1 * p00,
      p11: p11 - k1 * p01,
    };
  }

  public updatePrimary(
    obsCx: number,
    obsCy: number,
    obsRx: number,
    obsRy: number,
    nowMs: number,
    fastSnap = false
  ): FaceBox {
    if (!this.initialized || fastSnap) {
      this.cx = obsCx;
      this.cy = obsCy;
      this.vx = 0;
      this.vy = 0;
      this.rx = obsRx;
      this.ry = obsRy;
      this.initialized = true;
      this.lastTs = nowMs;
      this.px00 = 0.008;
      this.py00 = 0.008;
      return this.getState();
    }

    const shift = Math.hypot(obsCx - this.cx, obsCy - this.cy);
    const rMeas = shift > 0.12 ? 0.00018 : shift > 0.035 ? 0.00065 : 0.0024;
    const ux = this.kalmanUpdateAxis(
      this.cx,
      this.vx,
      this.px00,
      this.px01,
      this.px10,
      this.px11,
      obsCx,
      rMeas
    );
    this.cx = ux.pos;
    this.vx = ux.vel;
    this.px00 = ux.p00;
    this.px01 = ux.p01;
    this.px10 = ux.p10;
    this.px11 = ux.p11;

    const uy = this.kalmanUpdateAxis(
      this.cy,
      this.vy,
      this.py00,
      this.py01,
      this.py10,
      this.py11,
      obsCy,
      rMeas
    );
    this.cy = uy.pos;
    this.vy = uy.vel;
    this.py00 = uy.p00;
    this.py01 = uy.p01;
    this.py10 = uy.p10;
    this.py11 = uy.p11;

    const sizeAlpha = shift > 0.05 ? 0.28 : 0.12;
    this.rx = this.rx * (1 - sizeAlpha) + obsRx * sizeAlpha;
    this.ry = this.ry * (1 - sizeAlpha) + obsRy * sizeAlpha;
    this.lastTs = nowMs;
    return this.getState();
  }

  /**
   * Secondary stabilization update when head tilts or user glances momentarily sideways:
   * uses elevated measurement noise R so asymmetric half-face centroids don't yank ROI boxes,
   * and preserves locked face dimensions.
   */
  public updateSecondary(obsCx: number, obsCy: number, nowMs: number): FaceBox {
    if (!this.initialized) {
      return this.getState();
    }
    const rSecondary = 0.0045;
    const ux = this.kalmanUpdateAxis(
      this.cx,
      this.vx * 0.7,
      this.px00,
      this.px01,
      this.px10,
      this.px11,
      obsCx,
      rSecondary
    );
    this.cx = ux.pos;
    this.vx = ux.vel * 0.75;
    this.px00 = ux.p00;
    this.px01 = ux.p01;
    this.px10 = ux.p10;
    this.px11 = ux.p11;

    const uy = this.kalmanUpdateAxis(
      this.cy,
      this.vy * 0.7,
      this.py00,
      this.py01,
      this.py10,
      this.py11,
      obsCy,
      rSecondary
    );
    this.cy = uy.pos;
    this.vy = uy.vel * 0.75;
    this.py00 = uy.p00;
    this.py01 = uy.p01;
    this.py10 = uy.p10;
    this.py11 = uy.p11;
    this.lastTs = nowMs;
    return this.getState();
  }

  public updateTilt(targetTiltDeg: number): number {
    this.tiltDeg = this.tiltDeg * 0.8 + targetTiltDeg * 0.2;
    return this.tiltDeg;
  }

  public relaxTowardCenter(alpha = 0.1): void {
    this.cx = this.cx * (1 - alpha) + 0.5 * alpha;
    this.cy = this.cy * (1 - alpha) + 0.46 * alpha;
    this.rx = this.rx * (1 - alpha) + 0.2 * alpha;
    this.ry = this.ry * (1 - alpha) + 0.32 * alpha;
    this.vx *= 0.6;
    this.vy *= 0.6;
    this.tiltDeg *= 0.85;
  }
}

export class RoiFrameExtractor {
  private prevLuma: Float32Array | null = null;
  private kalmanFace = new KalmanFaceTracker();
  private smoothCx = 0.5;
  private smoothCy = 0.46;
  private smoothRx = 0.2;
  private smoothRy = 0.32;
  private smoothTiltDeg = 0;
  private awbGainR = 1;
  private awbGainG = 1;
  private awbGainB = 1;
  private smoothColorTempK = 5500;

  private nativeDetector: NativeFaceDetectorInstance | null = null;
  private nativeHint: { box: FaceBox; ts: number } | null = null;
  private nativeSupportConfirmed = false;
  private nativeLastEmptyTs = 0;
  private lastNativeDetectAttempt = 0;
  private nativeDetectInFlight = false;

  private neuralMesh = new MediaPipeFaceTracker();
  private neuralHint: NeuralFaceMeshHint | null = null;
  private neuralLastEmptyTs = 0;
  private lastNeuralAttemptTs = 0;
  private neuralWarmupTriggered = false;

  private consecutiveFaceFrames = 0;
  private consecutiveMissFrames = 0;
  private hasLockedFace = false;
  private lastPrimaryVerifiedTs = 0;

  constructor() {
    if (typeof window !== "undefined") {
      const Ctor = (
        window as unknown as {
          FaceDetector?: new (opts: {
            fastMode?: boolean;
            maxDetectedFaces?: number;
          }) => NativeFaceDetectorInstance;
        }
      ).FaceDetector;
      if (typeof Ctor === "function") {
        try {
          this.nativeDetector = new Ctor({ fastMode: true, maxDetectedFaces: 1 });
        } catch {
          this.nativeDetector = null;
        }
      }
    }
  }

  public reset(): void {
    this.prevLuma = null;
    this.kalmanFace.reset();
    this.smoothCx = 0.5;
    this.smoothCy = 0.46;
    this.smoothRx = 0.2;
    this.smoothRy = 0.32;
    this.smoothTiltDeg = 0;
    this.awbGainR = 1;
    this.awbGainG = 1;
    this.awbGainB = 1;
    this.smoothColorTempK = 5500;
    this.nativeHint = null;
    this.nativeSupportConfirmed = false;
    this.nativeLastEmptyTs = 0;
    this.lastNativeDetectAttempt = 0;
    this.nativeDetectInFlight = false;
    this.neuralHint = null;
    this.neuralLastEmptyTs = 0;
    this.lastNeuralAttemptTs = 0;
    this.consecutiveFaceFrames = 0;
    this.consecutiveMissFrames = 0;
    this.hasLockedFace = false;
    this.lastPrimaryVerifiedTs = 0;
  }

  public warmupNeuralMesh(): void {
    if (this.neuralWarmupTriggered || this.neuralMesh.hasFailed()) return;
    this.neuralWarmupTriggered = true;
    void this.neuralMesh.warmup();
  }

  public setNeuralLandmarkHint(hint: NeuralFaceMeshHint | null): void {
    this.neuralHint = hint;
    if (!hint) {
      this.neuralLastEmptyTs = performance.now();
    } else {
      this.neuralLastEmptyTs = 0;
    }
  }

  /**
   * 478-point MediaPipe FaceLandmarker polling (~15 Hz) running in browser WASM/WebGL
   * with non-blocking initialization and zero-downtime fallback to CV Haar + Kalman.
   */
  public pollNeuralFaceMesh(video: HTMLVideoElement, nowMs: number): void {
    this.warmupNeuralMesh();
    if (
      !this.neuralMesh.isReady() ||
      nowMs - this.lastNeuralAttemptTs < 65 ||
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return;
    }
    this.lastNeuralAttemptTs = nowMs;
    const res = this.neuralMesh.detectVideoFrame(video, nowMs);
    if (!res) return;
    if (res.detected && res.hint) {
      this.neuralHint = res.hint;
      this.neuralLastEmptyTs = 0;
    } else {
      this.neuralHint = null;
      this.neuralLastEmptyTs = nowMs;
    }
  }

  /**
   * Optional non-blocking native FaceDetector hint (Chromium) with eye-landmark tilt
   * to reinforce cluster-based facial geometry at ~7 Hz without blocking the 30 FPS DSP loop.
   */
  public pollNativeFaceDetector(video: HTMLVideoElement, nowMs: number): void {
    if (
      !this.nativeDetector ||
      this.nativeDetectInFlight ||
      nowMs - this.lastNativeDetectAttempt < 140 ||
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return;
    }

    this.lastNativeDetectAttempt = nowMs;
    this.nativeDetectInFlight = true;
    this.nativeDetector
      .detect(video)
      .then((faces) => {
        this.nativeSupportConfirmed = true;
        if (faces && faces.length > 0) {
          const face = faces[0];
          const bb = face.boundingBox;
          const vw = video.videoWidth || 640;
          const vh = video.videoHeight || 480;
          const cx = Math.max(0.08, Math.min(0.92, (bb.x + bb.width * 0.5) / vw));
          const cy = Math.max(0.08, Math.min(0.92, (bb.y + bb.height * 0.48) / vh));
          const rx = Math.max(0.08, Math.min(0.36, (bb.width * 0.5) / vw));
          const ry = Math.max(0.12, Math.min(0.46, (bb.height * 0.52) / vh));

          let headTiltDeg = 0;
          const eyePoints =
            face.landmarks
              ?.filter((lm) => lm.type === "eye" && lm.locations && lm.locations.length > 0)
              .map((lm) => lm.locations![0]) ?? [];
          if (eyePoints.length >= 2) {
            const sortedEyes = [...eyePoints].sort((a, b) => a.x - b.x);
            const dx = sortedEyes[1].x - sortedEyes[0].x;
            const dy = sortedEyes[1].y - sortedEyes[0].y;
            if (dx > 8) {
              headTiltDeg = Math.max(
                -30,
                Math.min(30, (Math.atan2(dy, dx) * 180) / Math.PI)
              );
            }
          }

          this.nativeHint = {
            box: { cx, cy, rx, ry, headTiltDeg },
            ts: performance.now(),
          };
          this.nativeLastEmptyTs = 0;
        } else {
          this.nativeHint = null;
          this.nativeLastEmptyTs = performance.now();
        }
      })
      .catch(() => {
        // Fallback structural detector remains active on any browser restriction
      })
      .finally(() => {
        this.nativeDetectInFlight = false;
      });
  }

  public extract(
    imageData: ImageData,
    mode: CaptureMode,
    enableAwb = true,
    nowMs?: number
  ): RoiExtractionResult {
    const { width, height, data } = imageData;

    if (mode === "finger") {
      return this.extractFingerRoi(width, height, data);
    }

    return this.extractFaceRoi(width, height, data, enableAwb, nowMs);
  }

  private extractFaceRoi(
    width: number,
    height: number,
    data: Uint8ClampedArray,
    enableAwb: boolean,
    nowMs?: number
  ): RoiExtractionResult {
    // Background ambient illumination reference zones (corners), excluding facial skin pixels
    const bgZones = [
      { x0: 0.03, y0: 0.05, x1: 0.15, y1: 0.23, label: "Ambient Ref L" },
      { x0: 0.85, y0: 0.05, x1: 0.97, y1: 0.23, label: "Ambient Ref R" },
    ];

    let bgSumR = 0;
    let bgSumG = 0;
    let bgSumB = 0;
    let bgCount = 0;
    let fallbackBgR = 0;
    let fallbackBgG = 0;
    let fallbackBgB = 0;
    let fallbackBgCount = 0;

    for (const bz of bgZones) {
      const px0 = Math.floor(bz.x0 * width);
      const py0 = Math.floor(bz.y0 * height);
      const px1 = Math.floor(bz.x1 * width);
      const py1 = Math.floor(bz.y1 * height);
      for (let y = py0; y <= py1; y++) {
        for (let x = px0; x <= px1; x++) {
          const idx = (y * width + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          fallbackBgR += r;
          fallbackBgG += g;
          fallbackBgB += b;
          fallbackBgCount++;
          if (!isFacialSkinPixel(r * this.awbGainR, g * this.awbGainG, b * this.awbGainB)) {
            bgSumR += r;
            bgSumG += g;
            bgSumB += b;
            bgCount++;
          }
        }
      }
    }

    const rawBgR =
      bgCount >= 16
        ? bgSumR / bgCount
        : fallbackBgCount > 0
        ? fallbackBgR / fallbackBgCount
        : 128;
    const rawBgG =
      bgCount >= 16
        ? bgSumG / bgCount
        : fallbackBgCount > 0
        ? fallbackBgG / fallbackBgCount
        : 128;
    const rawBgB =
      bgCount >= 16
        ? bgSumB / bgCount
        : fallbackBgCount > 0
        ? fallbackBgB / fallbackBgCount
        : 128;

    // Pass 0: Gray-World non-saturated illuminant estimate + frame luma
    let gwR = 0;
    let gwG = 0;
    let gwB = 0;
    let gwCount = 0;
    let frameLumaSum = 0;
    let frameLumaCount = 0;

    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;

        if (x > width * 0.1 && x < width * 0.9 && y > height * 0.1 && y < height * 0.9) {
          frameLumaSum += luma;
          frameLumaCount++;
        }

        if (luma >= 20 && luma <= 238) {
          gwR += r;
          gwG += g;
          gwB += b;
          gwCount++;
        }
      }
    }

    const centerRawLuma = frameLumaCount > 0 ? frameLumaSum / frameLumaCount : 0;
    const frameR = gwCount > 0 ? gwR / gwCount : rawBgR;
    const frameG = gwCount > 0 ? gwG / gwCount : rawBgG;
    const frameB = gwCount > 0 ? gwB / gwCount : rawBgB;

    const illumR = 0.65 * rawBgR + 0.35 * frameR;
    const illumG = 0.65 * rawBgG + 0.35 * frameG;
    const illumB = 0.65 * rawBgB + 0.35 * frameB;
    const grayTarget = (illumR + illumG + illumB) / 3 || 128;

    const clampGain = (g: number) => Math.max(0.55, Math.min(1.85, g));
    const targetGainR = clampGain(grayTarget / Math.max(12, illumR));
    const targetGainG = clampGain(grayTarget / Math.max(12, illumG));
    const targetGainB = clampGain(grayTarget / Math.max(12, illumB));

    this.awbGainR = this.awbGainR * 0.84 + targetGainR * 0.16;
    this.awbGainG = this.awbGainG * 0.84 + targetGainG * 0.16;
    this.awbGainB = this.awbGainB * 0.84 + targetGainB * 0.16;

    const frameCct = estimateCorrelatedColorTempK(illumR, illumG, illumB);
    this.smoothColorTempK = Math.round(this.smoothColorTempK * 0.82 + frameCct * 0.18);

    const gR = enableAwb ? this.awbGainR : 1;
    const gG = enableAwb ? this.awbGainG : 1;
    const gB = enableAwb ? this.awbGainB : 1;

    const bgR = Math.min(255, rawBgR * gR);
    const bgG = Math.min(255, rawBgG * gG);
    const bgB = Math.min(255, rawBgB * gB);

    // Pass 1A: High-resolution 12x9 spatial skin-density grid + Multi-Hypothesis peak selection
    const sx0 = Math.floor(width * 0.03);
    const sy0 = Math.floor(height * 0.03);
    const sx1 = Math.floor(width * 0.97);
    const sy1 = Math.floor(height * 0.95);

    const nowTs = nowMs ?? performance.now();
    const hasFreshNeuralHint =
      this.neuralHint !== null && nowTs - this.neuralHint.ts < 350;
    const hasFreshNativeHint =
      !hasFreshNeuralHint &&
      this.nativeHint !== null &&
      nowTs - this.nativeHint.ts < 450;
    const hasFreshAiHint = hasFreshNeuralHint || hasFreshNativeHint;
    const aiBox = hasFreshNeuralHint
      ? this.neuralHint!.box
      : hasFreshNativeHint
      ? this.nativeHint!.box
      : null;

    const neuralConfirmedNoFace =
      this.neuralMesh.isReady() &&
      !hasFreshNeuralHint &&
      this.neuralLastEmptyTs > 0 &&
      nowTs - this.neuralLastEmptyTs < 480;
    const nativeConfirmedNoFace =
      neuralConfirmedNoFace ||
      (this.nativeSupportConfirmed &&
        !hasFreshAiHint &&
        this.nativeLastEmptyTs > 0 &&
        nowTs - this.nativeLastEmptyTs < 650);

    const lumaSat = buildLumaIntegral(data, width, height);

    const GRID_COLS = 12;
    const GRID_ROWS = 9;
    const gridCounts = new Int32Array(GRID_COLS * GRID_ROWS);
    const gridTotals = new Int32Array(GRID_COLS * GRID_ROWS);
    const gridSumX = new Float64Array(GRID_COLS * GRID_ROWS);
    const gridSumY = new Float64Array(GRID_COLS * GRID_ROWS);
    let totalSkin1A = 0;
    let totalSamples1A = 0;

    for (let y = sy0; y <= sy1; y += 2) {
      for (let x = sx0; x <= sx1; x += 2) {
        const nx = x / width;
        const ny = y / height;
        const gc = Math.min(GRID_COLS - 1, Math.floor(nx * GRID_COLS));
        const gr = Math.min(GRID_ROWS - 1, Math.floor(ny * GRID_ROWS));
        const gi = gr * GRID_COLS + gc;
        gridTotals[gi]++;
        totalSamples1A++;

        const idx = (y * width + x) * 4;
        const rawR = data[idx];
        const rawG = data[idx + 1];
        const rawB = data[idx + 2];
        const r = Math.min(255, rawR * gR);
        const g = Math.min(255, rawG * gG);
        const b = Math.min(255, rawB * gB);
        if (
          isFacialSkinPixel(r, g, b) ||
          (enableAwb && isFacialSkinPixel(rawR, rawG, rawB))
        ) {
          gridCounts[gi]++;
          gridSumX[gi] += nx;
          gridSumY[gi] += ny;
          totalSkin1A++;
        }
      }
    }

    // Measure whether skin pixels form a compact face cluster vs a full-frame wall/backdrop
    let edgeSkinCount = 0;
    let edgeTotalCount = 0;
    for (let gr = 0; gr < GRID_ROWS; gr++) {
      for (let gc = 0; gc < GRID_COLS; gc++) {
        if (gr === 0 || gr === GRID_ROWS - 1 || gc === 0 || gc === GRID_COLS - 1) {
          const gi = gr * GRID_COLS + gc;
          edgeSkinCount += gridCounts[gi];
          edgeTotalCount += gridTotals[gi];
        }
      }
    }
    const edgeSkinRatio = edgeTotalCount > 0 ? edgeSkinCount / edgeTotalCount : 0;
    const frameSkinRatio = totalSamples1A > 0 ? totalSkin1A / totalSamples1A : 0;

    const uniformBackdropSuspect =
      !hasFreshAiHint &&
      edgeSkinRatio > 0.5 &&
      frameSkinRatio > 0.55 &&
      edgeSkinRatio > frameSkinRatio * 0.8;

    // Gather Top-3 spatially separated 3x3 skin-density peaks (replaces naive single 2x2 argmax)
    const roughSeeds: Array<{ cx: number; cy: number; seedScore: number }> = [];
    if (aiBox) {
      roughSeeds.push({
        cx: aiBox.cx,
        cy: aiBox.cy,
        seedScore: 1000,
      });
    } else if (totalSkin1A >= 36 && !uniformBackdropSuspect) {
      const blocks: Array<{ cx: number; cy: number; score: number; cnt: number }> = [];
      for (let gr = 0; gr < GRID_ROWS - 2; gr++) {
        for (let gc = 0; gc < GRID_COLS - 2; gc++) {
          let cnt = 0;
          let tot = 0;
          let sx = 0;
          let sy = 0;
          for (let dr = 0; dr <= 2; dr++) {
            for (let dc = 0; dc <= 2; dc++) {
              const gi = (gr + dr) * GRID_COLS + (gc + dc);
              cnt += gridCounts[gi];
              tot += gridTotals[gi];
              sx += gridSumX[gi];
              sy += gridSumY[gi];
            }
          }
          if (cnt >= 28) {
            const density = tot > 0 ? cnt / tot : 0;
            const cyCand = sy / cnt;
            // Upper-center facial prior softly favors heads over hands/neck near bottom border
            const yPrior = cyCand > 0.8 ? 0.72 : 1.0;
            blocks.push({
              cx: sx / cnt,
              cy: cyCand,
              score: cnt * (0.6 + density) * yPrior,
              cnt,
            });
          }
        }
      }
      blocks.sort((a, b) => b.score - a.score);
      for (const blk of blocks) {
        const farEnough = roughSeeds.every(
          (s) => Math.hypot(s.cx - blk.cx, s.cy - blk.cy) >= 0.18
        );
        if (farEnough) {
          roughSeeds.push({ cx: blk.cx, cy: blk.cy, seedScore: blk.score });
          if (roughSeeds.length >= 3) break;
        }
      }
    }

    if (
      this.hasLockedFace &&
      !uniformBackdropSuspect &&
      roughSeeds.every((s) => Math.hypot(s.cx - this.smoothCx, s.cy - this.smoothCy) >= 0.12)
    ) {
      roughSeeds.push({ cx: this.smoothCx, cy: this.smoothCy, seedScore: 120 });
    }
    if (roughSeeds.length === 0) {
      roughSeeds.push({ cx: this.smoothCx, cy: this.smoothCy, seedScore: 0 });
    }

    const minClusterSkinPts = Math.max(85, Math.round((width * height) / 480));

    // Pass 1B + 1C: Craniofacial Neck-Trim Clustering & O(1) Haar Structural Scoring per candidate
    const evaluateCandidate = (seedCx: number, seedCy: number) => {
      const tx0 = Math.max(0, Math.floor((seedCx - 0.29) * width));
      const ty0 = Math.max(0, Math.floor((seedCy - 0.36) * height));
      const tx1 = Math.min(width - 1, Math.floor((seedCx + 0.29) * width));
      const ty1 = Math.min(height - 1, Math.floor((seedCy + 0.36) * height));

      const rowSpan = Math.max(1, Math.floor((ty1 - ty0) / 2) + 1);
      const rowCounts = new Int32Array(rowSpan);
      const rowSumX = new Float64Array(rowSpan);
      const rowYVals = new Float64Array(rowSpan);
      const rowXX = new Float64Array(rowSpan);

      let rawCount = 0;
      for (let y = ty0, ri = 0; y <= ty1; y += 2, ri++) {
        rowYVals[ri] = y / height;
        for (let x = tx0; x <= tx1; x += 2) {
          const idx = (y * width + x) * 4;
          const rawR = data[idx];
          const rawG = data[idx + 1];
          const rawB = data[idx + 2];
          const r = Math.min(255, rawR * gR);
          const g = Math.min(255, rawG * gG);
          const b = Math.min(255, rawB * gB);
          if (
            isFacialSkinPixel(r, g, b) ||
            (enableAwb && isFacialSkinPixel(rawR, rawG, rawB))
          ) {
            const nx = x / width;
            rowCounts[ri]++;
            rowSumX[ri] += nx;
            rowXX[ri] += nx * nx;
            rawCount++;
          }
        }
      }

      if (rawCount < minClusterSkinPts) {
        return null;
      }

      // Craniofacial contour neck-trimming: locate wide cheek lobe & trim thin neck tail below chin
      let maxRowCount = 0;
      let peakRi = 0;
      let firstSkinRi = -1;
      let lastSkinRi = 0;
      for (let ri = 0; ri < rowSpan; ri++) {
        if (rowCounts[ri] >= 3) {
          if (firstSkinRi === -1) firstSkinRi = ri;
          lastSkinRi = ri;
        }
        if (rowCounts[ri] > maxRowCount) {
          maxRowCount = rowCounts[ri];
          peakRi = ri;
        }
      }

      let chinCutRi = lastSkinRi;
      const verticalSkinRows = lastSkinRi - Math.max(0, firstSkinRi);
      if (verticalSkinRows >= 12 && maxRowCount >= 8) {
        const searchStartRi = Math.max(peakRi + 2, Math.floor((Math.max(0, firstSkinRi) + lastSkinRi) * 0.56));
        for (let ri = searchStartRi; ri <= lastSkinRi; ri++) {
          // Significant waist constriction (<52% of cheek width) marks chin-to-neck transition
          if (rowCounts[ri] > 0 && rowCounts[ri] < maxRowCount * 0.52) {
            const lookAhead = Math.min(lastSkinRi, ri + 2);
            if (rowCounts[lookAhead] <= maxRowCount * 0.62) {
              chinCutRi = ri + 1;
              break;
            }
          }
        }
      }

      let sumX = 0;
      let sumY = 0;
      let sumXX = 0;
      let sumYY = 0;
      let count = 0;
      const startTrimRi = Math.max(0, firstSkinRi);
      for (let ri = startTrimRi; ri <= chinCutRi; ri++) {
        const c = rowCounts[ri];
        if (c === 0) continue;
        const ryNorm = rowYVals[ri];
        sumX += rowSumX[ri];
        sumXX += rowXX[ri];
        sumY += c * ryNorm;
        sumYY += c * ryNorm * ryNorm;
        count += c;
      }

      if (count < minClusterSkinPts * 0.72) {
        // Fallback if trim was overly aggressive
        sumX = 0;
        sumY = 0;
        sumXX = 0;
        sumYY = 0;
        count = 0;
        for (let ri = 0; ri < rowSpan; ri++) {
          const c = rowCounts[ri];
          if (c === 0) continue;
          const ryNorm = rowYVals[ri];
          sumX += rowSumX[ri];
          sumXX += rowXX[ri];
          sumY += c * ryNorm;
          sumYY += c * ryNorm * ryNorm;
          count += c;
        }
      }

      if (count < minClusterSkinPts) return null;

      const meanX = sumX / count;
      const meanY = sumY / count;
      const varX = Math.max(0.002, sumXX / count - meanX * meanX);
      const varY = Math.max(0.004, sumYY / count - meanY * meanY);
      const stdX = Math.sqrt(varX);
      const stdY = Math.sqrt(varY);

      const candRx = Math.max(0.095, Math.min(0.35, stdX * 2.02));
      const candRy = Math.max(0.145, Math.min(0.45, stdY * 2.12));

      // Integral-Image Haar Facial Structure Score (forehead > eye-band & nose-bridge > ocular sockets)
      const fhBoxLuma = queryBoxMean(
        lumaSat,
        width,
        height,
        meanX - 0.42 * candRx,
        meanY - 0.58 * candRy,
        meanX + 0.42 * candRx,
        meanY - 0.34 * candRy
      );
      const eyeLBoxLuma = queryBoxMean(
        lumaSat,
        width,
        height,
        meanX - 0.56 * candRx,
        meanY - 0.28 * candRy,
        meanX - 0.14 * candRx,
        meanY - 0.02 * candRy
      );
      const eyeRBoxLuma = queryBoxMean(
        lumaSat,
        width,
        height,
        meanX + 0.14 * candRx,
        meanY - 0.28 * candRy,
        meanX + 0.56 * candRx,
        meanY - 0.02 * candRy
      );
      const bridgeLuma = queryBoxMean(
        lumaSat,
        width,
        height,
        meanX - 0.12 * candRx,
        meanY - 0.28 * candRy,
        meanX + 0.12 * candRx,
        meanY - 0.02 * candRy
      );

      const minFhEyeMargin = Math.max(3.2, fhBoxLuma * 0.045);
      const fhOverEye = fhBoxLuma - Math.min(eyeLBoxLuma, eyeRBoxLuma);
      const bridgeContrast = bridgeLuma - (eyeLBoxLuma + eyeRBoxLuma) * 0.5;
      const haarValid = fhOverEye >= minFhEyeMargin || bridgeContrast >= minFhEyeMargin * 0.9;

      const aspectRatio = (candRy * height) / Math.max(1, candRx * width);
      const aspectOk = aspectRatio >= 0.85 && aspectRatio <= 2.35;

      let totalScore = count * (aspectOk ? 1.0 : 0.65);
      if (haarValid) totalScore *= 1.45;
      totalScore += Math.max(0, fhOverEye) * 8 + Math.max(0, bridgeContrast) * 6;
      if (this.hasLockedFace) {
        const dist = Math.hypot(meanX - this.smoothCx, meanY - this.smoothCy);
        if (dist < 0.22) totalScore *= 1.28;
      }

      return {
        meanX,
        meanY,
        rx: candRx,
        ry: candRy,
        count,
        haarValid,
        totalScore,
      };
    };

    let bestCand: ReturnType<typeof evaluateCandidate> = null;
    for (const seed of roughSeeds) {
      const cand = evaluateCandidate(seed.cx, seed.cy);
      if (cand && (!bestCand || cand.totalScore > bestCand.totalScore)) {
        bestCand = cand;
      }
    }

    const clusterCandidate = bestCand !== null && !uniformBackdropSuspect;

    if (this.hasLockedFace && this.kalmanFace.isInitialized()) {
      this.kalmanFace.predict(nowTs);
    }

    let inKalmanGate = false;
    let candidateCx = this.smoothCx;
    let candidateCy = this.smoothCy;

    if (clusterCandidate && bestCand) {
      let targetCx = bestCand.meanX;
      let targetCy = bestCand.meanY;
      let targetRx = bestCand.rx;
      let targetRy = bestCand.ry;

      if (aiBox) {
        targetCx = aiBox.cx * 0.78 + bestCand.meanX * 0.22;
        targetCy = aiBox.cy * 0.78 + bestCand.meanY * 0.22;
        targetRx = aiBox.rx * 0.8 + targetRx * 0.2;
        targetRy = aiBox.ry * 0.8 + targetRy * 0.2;
      }

      candidateCx = targetCx;
      candidateCy = targetCy;

      const gate = this.kalmanFace.evaluateGate(targetCx, targetCy, targetRx);
      inKalmanGate = !this.hasLockedFace || gate.inGate || hasFreshAiHint;

      const shift = Math.hypot(targetCx - this.smoothCx, targetCy - this.smoothCy);
      if (hasFreshAiHint || !this.hasLockedFace || !nativeConfirmedNoFace) {
        const kf = this.kalmanFace.updatePrimary(
          targetCx,
          targetCy,
          targetRx,
          targetRy,
          nowTs,
          !this.hasLockedFace || shift > 0.16
        );
        this.smoothCx = kf.cx;
        this.smoothCy = kf.cy;
        this.smoothRx = kf.rx;
        this.smoothRy = kf.ry;
      } else if (inKalmanGate) {
        // Secondary Kalman stabilization update prevents centroid pull when tilting/turning
        const kf = this.kalmanFace.updateSecondary(targetCx, targetCy, nowTs);
        this.smoothCx = kf.cx;
        this.smoothCy = kf.cy;
        this.smoothRx = kf.rx;
        this.smoothRy = kf.ry;
      }
    } else if (aiBox) {
      inKalmanGate = true;
      candidateCx = aiBox.cx;
      candidateCy = aiBox.cy;
      const kf = this.kalmanFace.updatePrimary(
        aiBox.cx,
        aiBox.cy,
        aiBox.rx,
        aiBox.ry,
        nowTs,
        !this.hasLockedFace
      );
      this.smoothCx = kf.cx;
      this.smoothCy = kf.cy;
      this.smoothRx = kf.rx;
      this.smoothRy = kf.ry;
    } else if (this.hasLockedFace && this.kalmanFace.isInitialized()) {
      const kf = this.kalmanFace.getState();
      this.smoothCx = kf.cx;
      this.smoothCy = kf.cy;
      this.smoothRx = kf.rx;
      this.smoothRy = kf.ry;
    }

    let cx = this.smoothCx;
    const cy = this.smoothCy;
    const rx = this.smoothRx;
    const ry = this.smoothRy;
    const clamp01 = (v: number) => Math.max(0.01, Math.min(0.99, v));

    // Ocular luminance-valley detector + Weber-adaptive tilt-aware facial symmetry check
    let targetTiltDeg = aiBox?.headTiltDeg ?? this.smoothTiltDeg * 0.9;
    let bilateralOcularStructure = false;
    let unilateralOcularStructure = false;
    const prevTiltRad = (this.smoothTiltDeg * Math.PI) / 180;
    const tiltMarginY = Math.min(0.28, Math.abs(Math.sin(prevTiltRad)) * 0.45);

    const findEyeValley = (xStartN: number, xEndN: number, sideOffset: number) => {
      const px0 = Math.max(2, Math.floor(clamp01(xStartN) * width));
      const px1 = Math.min(width - 3, Math.floor(clamp01(xEndN) * width));
      const tiltShiftY = sideOffset * Math.sin(prevTiltRad) * 0.65;
      const py0 = Math.max(
        2,
        Math.floor(clamp01(cy + tiltShiftY - (0.38 + tiltMarginY) * ry) * height)
      );
      const py1 = Math.min(
        height - 3,
        Math.floor(clamp01(cy + tiltShiftY + (0.08 + tiltMarginY) * ry) * height)
      );
      let minAvg = 999;
      let maxAvg = 0;
      let bestX = (px0 + px1) * 0.5;
      let bestY = (py0 + py1) * 0.5;
      for (let y = py0; y <= py1; y += 2) {
        for (let x = px0; x <= px1; x += 2) {
          let lumaSum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const i4 = ((y + dy) * width + (x + dx)) * 4;
              lumaSum +=
                0.299 * data[i4] + 0.587 * data[i4 + 1] + 0.114 * data[i4 + 2];
            }
          }
          const avg = lumaSum / 9;
          if (avg > maxAvg) maxAvg = avg;
          if (avg < minAvg) {
            minAvg = avg;
            bestX = x;
            bestY = y;
          }
        }
      }
      return {
        x: bestX / width,
        y: bestY / height,
        minAvg,
        maxAvg,
        contrast: maxAvg - minAvg,
      };
    };

    if (clusterCandidate || hasFreshAiHint) {
      const leftEye = findEyeValley(cx - 0.64 * rx, cx - 0.1 * rx, -0.35 * rx);
      const rightEye = findEyeValley(cx + 0.1 * rx, cx + 0.64 * rx, 0.35 * rx);
      const eyeSeparationX = rightEye.x - leftEye.x;
      const eyeDiffY = Math.abs(leftEye.y - rightEye.y);

      const foreheadLuma = queryBoxMean(
        lumaSat,
        width,
        height,
        clamp01(cx - 0.32 * rx),
        clamp01(cy - 0.64 * ry),
        clamp01(cx + 0.32 * rx),
        clamp01(cy - 0.38 * ry)
      );

      // Luma-adaptive Weber thresholds handle both dim bedrooms (~55 luma) and daylight (~210)
      const leftEyeThresh = Math.max(6.0, leftEye.maxAvg * 0.085);
      const rightEyeThresh = Math.max(6.0, rightEye.maxAvg * 0.085);
      const fhEyeMargin = Math.max(2.5, foreheadLuma * 0.032);

      const leftStrong =
        leftEye.contrast >= leftEyeThresh && foreheadLuma >= leftEye.minAvg + fhEyeMargin;
      const rightStrong =
        rightEye.contrast >= rightEyeThresh && foreheadLuma >= rightEye.minAvg + fhEyeMargin;
      if (leftStrong || rightStrong || bestCand?.haarValid || hasFreshNeuralHint) {
        unilateralOcularStructure = true;
      }

      if (
        hasFreshNeuralHint ||
        (leftStrong &&
          rightStrong &&
          eyeSeparationX >= Math.max(0.032, 0.25 * rx) &&
          eyeDiffY <= Math.max(0.068, 0.44 * ry)) ||
        (bestCand?.haarValid && (leftStrong || rightStrong) && eyeSeparationX >= 0.03)
      ) {
        bilateralOcularStructure = true;
        if (!aiBox || aiBox.headTiltDeg === undefined) {
          const dx = (rightEye.x - leftEye.x) * width;
          const dy = (rightEye.y - leftEye.y) * height;
          if (dx > 10) {
            const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
            if (Math.abs(deg) <= 30) {
              targetTiltDeg = deg;
            }
          }
          // Subtle midpoint centering from crisp eye landmarks keeps nose bridge locked
          if (leftStrong && rightStrong) {
            const eyeMidX = (leftEye.x + rightEye.x) * 0.5;
            if (Math.abs(eyeMidX - cx) <= 0.18 * rx) {
              cx = cx * 0.72 + eyeMidX * 0.28;
              this.smoothCx = cx;
            }
          }
        }
      }
    }

    this.smoothTiltDeg = this.kalmanFace.updateTilt(targetTiltDeg);
    const tiltRad = (this.smoothTiltDeg * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const sinT = Math.sin(tiltRad);

    const buildTiltedZone = (
      key: "forehead" | "leftCheek" | "rightCheek",
      offX: number,
      offY: number,
      halfW: number,
      halfH: number,
      label: string
    ) => {
      // Rotate in true pixel aspect space so forehead & cheek ROIs stay aligned on 16:9 / 4:3 / mobile
      const dxPx = offX * width;
      const dyPx = offY * height;
      const rotX = (dxPx * cosT - dyPx * sinT) / width;
      const rotY = (dxPx * sinT + dyPx * cosT) / height;
      const zcx = cx + rotX;
      const zcy = cy + rotY;
      return {
        key,
        x0: clamp01(zcx - halfW),
        y0: clamp01(zcy - halfH),
        x1: clamp01(zcx + halfW),
        y1: clamp01(zcy + halfH),
        label,
      };
    };

    const yaw = hasFreshNeuralHint && this.neuralHint ? this.neuralHint.yawRatio : 0;
    // yaw > 0 => turned toward anatomical left/image-right (454/rightCheek occluded)
    // yaw < 0 => turned toward anatomical right/image-left (234/leftCheek occluded)
    const shrinkCheekYaw = (
      box: { x0: number; y0: number; x1: number; y1: number },
      side: "leftCheek" | "rightCheek"
    ) => {
      if (side === "rightCheek" && yaw > 0.24) {
        const w = box.x1 - box.x0;
        const trim = Math.min(0.45, (yaw - 0.2) * 1.4) * w;
        return { ...box, x1: Math.max(box.x0 + 0.015, box.x1 - trim) };
      }
      if (side === "leftCheek" && yaw < -0.24) {
        const w = box.x1 - box.x0;
        const trim = Math.min(0.45, (-yaw - 0.2) * 1.4) * w;
        return { ...box, x0: Math.min(box.x1 - 0.015, box.x0 + trim) };
      }
      return box;
    };

    const allZones = hasFreshNeuralHint
      ? [
          {
            key: "forehead" as const,
            ...this.neuralHint!.regions.forehead,
            label: "Forehead Mesh ROI",
            occluded: false,
          },
          {
            key: "leftCheek" as const,
            ...shrinkCheekYaw(this.neuralHint!.regions.leftCheek, "leftCheek"),
            label: "Cheek L Mesh",
            occluded: yaw < -0.40,
          },
          {
            key: "rightCheek" as const,
            ...shrinkCheekYaw(this.neuralHint!.regions.rightCheek, "rightCheek"),
            label: "Cheek R Mesh",
            occluded: yaw > 0.40,
          },
        ]
      : [
          {
            ...buildTiltedZone(
              "forehead",
              0,
              -0.55 * ry,
              0.54 * rx,
              0.17 * ry,
              "Forehead ROI"
            ),
            occluded: false,
          },
          {
            ...buildTiltedZone(
              "leftCheek",
              -0.49 * rx,
              0.195 * ry,
              0.27 * rx,
              0.205 * ry,
              "Cheek L"
            ),
            occluded: false,
          },
          {
            ...buildTiltedZone(
              "rightCheek",
              0.49 * rx,
              0.195 * ry,
              0.27 * rx,
              0.205 * ry,
              "Cheek R"
            ),
            occluded: false,
          },
        ];

    const zones = allZones.filter((z) => !z.occluded);

    let totalSumR = 0;
    let totalSumG = 0;
    let totalSumB = 0;
    let totalSumLuma = 0;
    let totalSkinCount = 0;
    let totalZonePixels = 0;
    let specularCount = 0;
    let signedDeltaSum = 0;
    const motionDeltas: number[] = [];

    const regionResults: Record<
      "forehead" | "leftCheek" | "rightCheek",
      RoiRgbTriplet
    > = {
      forehead: { r: 0, g: 0, b: 0, valid: false },
      leftCheek: { r: 0, g: 0, b: 0, valid: false },
      rightCheek: { r: 0, g: 0, b: 0, valid: false },
    };

    const currentLuma = new Float32Array(width * height);

    for (const z of zones) {
      const px0 = Math.max(0, Math.floor(z.x0 * width));
      const py0 = Math.max(0, Math.floor(z.y0 * height));
      const px1 = Math.min(width - 1, Math.floor(z.x1 * width));
      const py1 = Math.min(height - 1, Math.floor(z.y1 * height));

      const zoneR: number[] = [];
      const zoneG: number[] = [];
      const zoneB: number[] = [];
      const zoneY: number[] = [];

      for (let y = py0; y <= py1; y++) {
        for (let x = px0; x <= px1; x++) {
          const pixIdx = y * width + x;
          const idx = pixIdx * 4;
          const rawR = data[idx];
          const rawG = data[idx + 1];
          const rawB = data[idx + 2];
          const rawY = 0.299 * rawR + 0.587 * rawG + 0.114 * rawB;

          const r = Math.min(255, rawR * gR);
          const g = Math.min(255, rawG * gG);
          const b = Math.min(255, rawB * gB);
          const Y = 0.299 * r + 0.587 * g + 0.114 * b;

          currentLuma[pixIdx] = rawY;
          totalZonePixels++;

          // Only compare pixels that were actually sampled on previous frame (avoids false 0-border spikes)
          if (this.prevLuma && this.prevLuma[pixIdx] > 0) {
            const signedDiff = rawY - this.prevLuma[pixIdx];
            signedDeltaSum += signedDiff;
            motionDeltas.push(signedDiff);
          }

          const isSpecular =
            rawY >= 232 || (rawR > 235 && rawG > 230 && rawB > 225);
          if (isSpecular) {
            specularCount++;
            continue;
          }

          if (
            isFacialSkinPixel(r, g, b) ||
            (enableAwb && isFacialSkinPixel(rawR, rawG, rawB))
          ) {
            zoneR.push(r);
            zoneG.push(g);
            zoneB.push(b);
            zoneY.push(Y);
          }
        }
      }

      const rawRegCount = zoneY.length;
      if (rawRegCount >= 10) {
        // 2-pass luminance outlier trimming rejects stray hair/eyebrow/glasses pixels inside ROI edges
        let ySum = 0;
        for (let i = 0; i < rawRegCount; i++) ySum += zoneY[i];
        const yMean = ySum / rawRegCount;
        let yVar = 0;
        for (let i = 0; i < rawRegCount; i++) {
          const d = zoneY[i] - yMean;
          yVar += d * d;
        }
        const yStd = Math.sqrt(yVar / rawRegCount);
        const trimBand = Math.max(14, yStd * 1.85);

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let lSum = 0;
        let regCount = 0;

        for (let i = 0; i < rawRegCount; i++) {
          if (yStd > 5 && Math.abs(zoneY[i] - yMean) > trimBand) {
            continue;
          }
          rSum += zoneR[i];
          gSum += zoneG[i];
          bSum += zoneB[i];
          lSum += zoneY[i];
          regCount++;
        }

        if (regCount < 10) {
          // Fallback to untrimmed if zone is too tight
          for (let i = 0; i < rawRegCount; i++) {
            rSum += zoneR[i];
            gSum += zoneG[i];
            bSum += zoneB[i];
            lSum += zoneY[i];
          }
          regCount = rawRegCount;
        }

        regionResults[z.key] = {
          r: rSum / regCount,
          g: gSum / regCount,
          b: bSum / regCount,
          valid: true,
        };
        totalSumR += rSum;
        totalSumG += gSum;
        totalSumB += bSum;
        totalSumLuma += lSum;
        totalSkinCount += regCount;
      }
    }

    this.prevLuma = currentLuma;

    const skinCoveragePct =
      totalZonePixels > 0 ? (totalSkinCount / totalZonePixels) * 100 : 0;
    const specularRejectedPct =
      totalZonePixels > 0 ? (specularCount / totalZonePixels) * 100 : 0;

    // Illumination-compensated motion metric ignores uniform global exposure drift
    let motionIndex = 0;
    if (motionDeltas.length > 0) {
      const meanShift = (signedDeltaSum / motionDeltas.length) * 0.55;
      let absMotionSum = 0;
      for (let i = 0; i < motionDeltas.length; i++) {
        absMotionSum += Math.abs(motionDeltas[i] - meanShift);
      }
      motionIndex = absMotionSum / motionDeltas.length;
    }

    const brightness =
      totalSkinCount > 0 ? totalSumLuma / totalSkinCount : centerRawLuma;

    const validRegionCount =
      (regionResults.forehead.valid ? 1 : 0) +
      (regionResults.leftCheek.valid ? 1 : 0) +
      (regionResults.rightCheek.valid ? 1 : 0);

    // Primary verification: required to establish initial lock (strictly rejects walls/backgrounds)
    const primaryVerified =
      (hasFreshNeuralHint && validRegionCount >= 1 && skinCoveragePct >= 16) ||
      (hasFreshNativeHint && validRegionCount >= 1 && skinCoveragePct >= 18) ||
      (!nativeConfirmedNoFace &&
        clusterCandidate &&
        (bilateralOcularStructure || (Boolean(bestCand?.haarValid) && validRegionCount >= 2)) &&
        validRegionCount >= 2 &&
        skinCoveragePct >= 26);

    // Secondary Kalman stabilization check (active ONLY when face lock was previously established):
    // prevents premature 'no_face' when user tilts head (>15°) or momentarily looks away
    const timeSincePrimaryMs =
      this.lastPrimaryVerifiedTs > 0 ? nowTs - this.lastPrimaryVerifiedTs : Infinity;
    const secondarySkinSupported =
      clusterCandidate &&
      inKalmanGate &&
      validRegionCount >= 1 &&
      skinCoveragePct >= 14 &&
      (unilateralOcularStructure || validRegionCount >= 2) &&
      timeSincePrimaryMs <= 2400;
    const secondaryMomentumCoast =
      totalSkinCount >= 18 &&
      (inKalmanGate || this.kalmanFace.evaluateGate(candidateCx, candidateCy, rx).inGate) &&
      timeSincePrimaryMs <= 700;
    const secondaryTurnBlinkGrace =
      !uniformBackdropSuspect &&
      centerRawLuma >= 34 &&
      timeSincePrimaryMs <= 340;

    const secondaryStabilized =
      this.hasLockedFace &&
      !primaryVerified &&
      (secondarySkinSupported || secondaryMomentumCoast || secondaryTurnBlinkGrace);

    if (primaryVerified) {
      this.consecutiveFaceFrames++;
      this.consecutiveMissFrames = 0;
      this.lastPrimaryVerifiedTs = nowTs;
      if (this.consecutiveFaceFrames >= 2) {
        this.hasLockedFace = true;
      }
    } else if (secondaryStabilized) {
      this.consecutiveFaceFrames = Math.max(1, this.consecutiveFaceFrames);
      this.consecutiveMissFrames = 0;
    } else {
      this.consecutiveFaceFrames = 0;
      this.consecutiveMissFrames++;
      if (this.consecutiveMissFrames >= 4) {
        this.hasLockedFace = false;
      }
      // Gently return tracking reticle toward center after prolonged absence
      if (this.consecutiveMissFrames > 12) {
        this.kalmanFace.relaxTowardCenter(0.1);
        const kf = this.kalmanFace.getState();
        this.smoothCx = kf.cx;
        this.smoothCy = kf.cy;
        this.smoothRx = kf.rx;
        this.smoothRy = kf.ry;
      }
    }

    const faceDetected = primaryVerified || secondaryStabilized || this.hasLockedFace;
    const isNearEdge =
      cx - rx * 0.86 < 0.015 ||
      cx + rx * 0.86 > 0.985 ||
      cy - ry * 0.86 < 0.015 ||
      cy + ry * 0.86 > 0.985 ||
      cx < 0.085 ||
      cx > 0.915 ||
      cy < 0.085 ||
      cy > 0.915;

    const faceNormArea = rx * 2 * (ry * 2);

    // Free-roaming face zone: pauses if face vanishes, clips outside sensor edge, too dark, or wrong distance
    let zoneGuidance: ZoneGuidance = "ok";
    if (centerRawLuma < 28 || (totalSkinCount > 0 && brightness < 30)) {
      zoneGuidance = "low_light";
    } else if (
      isNearEdge &&
      (faceDetected || (clusterCandidate && validRegionCount >= 1 && skinCoveragePct >= 18))
    ) {
      zoneGuidance = "off_center";
    } else if (
      !faceDetected ||
      (!secondaryStabilized &&
        !hasFreshNeuralHint &&
        (totalSkinCount < 36 || skinCoveragePct < 22 || validRegionCount < 2)) ||
      (hasFreshNeuralHint && (totalSkinCount < 28 || validRegionCount < 1))
    ) {
      zoneGuidance = "no_face";
    } else if ((rx < 0.098 || faceNormArea < 0.042) && !hasFreshAiHint) {
      zoneGuidance = "too_far";
    } else if ((rx > 0.355 && ry > 0.435) || faceNormArea > 0.62) {
      zoneGuidance = "too_close";
    }

    const inZone = zoneGuidance === "ok" && this.hasLockedFace;

    const roiBoxes: RoiBox[] = [
      ...zones.map((z) => ({
        x: z.x0,
        y: z.y0,
        w: z.x1 - z.x0,
        h: z.y1 - z.y0,
        label: z.label,
        kind: "skin" as const,
      })),
      ...bgZones.map((bz) => ({
        x: bz.x0,
        y: bz.y0,
        w: bz.x1 - bz.x0,
        h: bz.y1 - bz.y0,
        label: bz.label,
        kind: "background" as const,
      })),
    ];

    const awbState = {
      gainR: Number(gR.toFixed(2)),
      gainG: Number(gG.toFixed(2)),
      gainB: Number(gB.toFixed(2)),
      colorTempK: this.smoothColorTempK,
      applied: enableAwb,
    };

    const trackingSource: FaceBox["trackingSource"] = hasFreshNeuralHint
      ? "mediapipe"
      : hasFreshNativeHint
      ? "native"
      : "cv";

    const faceBox: FaceBox = {
      cx,
      cy,
      rx,
      ry,
      headTiltDeg: Number(this.smoothTiltDeg.toFixed(1)),
      trackingSource,
    };

    if (!faceDetected || !inZone || (totalSkinCount < 28 && !secondaryStabilized)) {
      return {
        r: 0,
        g: 0,
        b: 0,
        bgR,
        bgG,
        bgB,
        skinCoveragePct,
        brightness,
        motionIndex,
        specularRejectedPct,
        faceCenter: { x: cx, y: cy },
        faceBox,
        inZone: false,
        zoneGuidance,
        roiBoxes,
        hasValidTarget: false,
        awb: awbState,
        regions: regionResults,
      };
    }

    const hasUsableSkinSample =
      totalSkinCount >= 28 &&
      validRegionCount >= (secondaryStabilized ? 1 : 2) &&
      skinCoveragePct >= (secondaryStabilized ? 14 : 24);

    return {
      r: hasUsableSkinSample ? totalSumR / totalSkinCount : 0,
      g: hasUsableSkinSample ? totalSumG / totalSkinCount : 0,
      b: hasUsableSkinSample ? totalSumB / totalSkinCount : 0,
      bgR,
      bgG,
      bgB,
      skinCoveragePct,
      brightness,
      motionIndex,
      specularRejectedPct,
      faceCenter: { x: cx, y: cy },
      faceBox,
      inZone,
      zoneGuidance,
      roiBoxes,
      hasValidTarget: inZone && hasUsableSkinSample,
      awb: awbState,
      regions: regionResults,
    };
  }

  private extractFingerRoi(
    width: number,
    height: number,
    data: Uint8ClampedArray
  ): RoiExtractionResult {
    const px0 = Math.floor(width * 0.3);
    const py0 = Math.floor(height * 0.3);
    const px1 = Math.floor(width * 0.7);
    const py1 = Math.floor(height * 0.7);

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumLuma = 0;
    let count = 0;
    let motionDeltaSum = 0;
    let motionSamples = 0;

    const currentLuma = new Float32Array(width * height);

    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) {
        const pixIdx = y * width + x;
        const idx = pixIdx * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;

        currentLuma[pixIdx] = Y;
        if (this.prevLuma && this.prevLuma[pixIdx] > 0) {
          motionDeltaSum += Math.abs(Y - this.prevLuma[pixIdx]);
          motionSamples++;
        }

        // Skip white-clipped glare hotspots in contact PPG
        if (r >= 253 && g >= 248 && b >= 245) continue;

        sumR += r;
        sumG += g;
        sumB += b;
        sumLuma += Y;
        count++;
      }
    }

    this.prevLuma = currentLuma;

    const meanR = count > 0 ? sumR / count : 0;
    const meanG = count > 0 ? sumG / count : 0;
    const meanB = count > 0 ? sumB / count : 0;
    const brightness = count > 0 ? sumLuma / count : 0;
    const motionIndex = motionSamples > 0 ? motionDeltaSum / motionSamples : 0;

    const isFingerCovered = meanR > 105 && meanR > meanG * 1.3;

    return {
      r: meanR,
      g: meanG,
      b: meanB,
      bgR: meanR,
      bgG: meanG,
      bgB: meanB,
      skinCoveragePct: isFingerCovered ? 100 : 5,
      brightness,
      motionIndex,
      specularRejectedPct: 0,
      faceCenter: { x: 0.5, y: 0.5 },
      faceBox: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 },
      inZone: isFingerCovered,
      zoneGuidance: isFingerCovered ? "ok" : "no_face",
      roiBoxes: [
        {
          x: 0.3,
          y: 0.3,
          w: 0.4,
          h: 0.4,
          label: "Contact PPG Zone",
          kind: "skin",
        },
      ],
      hasValidTarget: isFingerCovered,
    };
  }
}
