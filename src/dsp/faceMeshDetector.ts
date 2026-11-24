import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export interface NormalizedBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface NeuralFaceMeshHint {
  box: {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    headTiltDeg: number;
  };
  regions: {
    forehead: NormalizedBox;
    leftCheek: NormalizedBox;
    rightCheek: NormalizedBox;
  };
  yawRatio: number; // -1 (turned right) .. 0 (frontal) .. +1 (turned left)
  ts: number;
}

// MediaPipe 478-point canonical face mesh landmark index groups (FaceMesh / pyVHR standard):
const FOREHEAD_LANDMARKS = [103, 67, 109, 10, 338, 297, 332, 105, 334];
const LEFT_CHEEK_LANDMARKS = [50, 101, 118, 119, 123, 187, 205];
const RIGHT_CHEEK_LANDMARKS = [280, 330, 347, 348, 352, 411, 425];
const FACE_OVAL_BOUNDARY = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];

function clamp01(v: number): number {
  return Math.max(0.01, Math.min(0.99, v));
}

function computeLandmarkSubBox(
  landmarks: Array<{ x: number; y: number }>,
  indices: number[],
  padX = 0.004,
  padY = 0.004
): NormalizedBox | null {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  for (const idx of indices) {
    const pt = landmarks[idx];
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
    count++;
  }

  if (count < 4 || maxX - minX < 0.015 || maxY - minY < 0.01) {
    return null;
  }

  return {
    x0: clamp01(minX - padX),
    y0: clamp01(minY - padY),
    x1: clamp01(maxX + padX),
    y1: clamp01(maxY + padY),
  };
}

/**
 * Browser-local 478-point Neural FaceMesh wrapper built on @mediapipe/tasks-vision.
 * Loads self-hosted WASM + float16 task weights under ./mediapipe/ with graceful fallback
 * if WebGL or WASM cannot run in the current environment.
 */
export class MediaPipeFaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;
  private lastVideoTs = -1;

  public isReady(): boolean {
    return this.landmarker !== null;
  }

  public hasFailed(): boolean {
    return this.initFailed;
  }

  public async warmup(): Promise<boolean> {
    if (this.landmarker) return true;
    if (this.initFailed || typeof window === "undefined") return false;

    if (!this.initPromise) {
      this.initPromise = this.initializeInternal();
    }
    await this.initPromise;
    return this.landmarker !== null;
  }

  private async initializeInternal(): Promise<void> {
    try {
      const base = (import.meta.env?.BASE_URL ?? "./").replace(/\/?$/, "/");
      const wasmPath = `${base}mediapipe/wasm`;
      const modelPath = `${base}mediapipe/models/face_landmarker.task`;

      const vision = await FilesetResolver.forVisionTasks(wasmPath);

      try {
        this.landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelPath,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numFaces: 1,
          minFaceDetectionConfidence: 0.45,
          minFacePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });
      } catch {
        // Fallback to CPU delegate when WebGL context isn't available
        this.landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelPath,
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numFaces: 1,
          minFaceDetectionConfidence: 0.45,
          minFacePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });
      }
    } catch {
      this.initFailed = true;
      this.landmarker = null;
    }
  }

  public detectVideoFrame(
    video: HTMLVideoElement,
    nowMs: number
  ): { detected: boolean; hint: NeuralFaceMeshHint | null } | null {
    if (
      !this.landmarker ||
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return null;
    }

    // MediaPipe VIDEO mode requires strictly monotonically increasing integer ms timestamps
    const tsMs = Math.max(this.lastVideoTs + 1, Math.round(nowMs));
    this.lastVideoTs = tsMs;

    let result;
    try {
      result = this.landmarker.detectForVideo(video, tsMs);
    } catch {
      return null;
    }

    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks || landmarks.length < 468) {
      return { detected: false, hint: null };
    }

    // Compute exact oval face bounds
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    for (const idx of FACE_OVAL_BOUNDARY) {
      const pt = landmarks[idx];
      if (!pt) continue;
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    if (maxX <= minX || maxY <= minY) {
      return { detected: false, hint: null };
    }

    const cx = Math.max(0.06, Math.min(0.94, (minX + maxX) * 0.5));
    const cy = Math.max(0.06, Math.min(0.94, (minY + maxY) * 0.49));
    const rx = Math.max(0.075, Math.min(0.4, (maxX - minX) * 0.5));
    const ry = Math.max(0.11, Math.min(0.48, (maxY - minY) * 0.51));

    // Exact inter-ocular head roll angle in true pixel aspect coordinates
    const lEyeOuter = landmarks[33];
    const lEyeInner = landmarks[133];
    const rEyeInner = landmarks[362];
    const rEyeOuter = landmarks[263];

    let headTiltDeg = 0;
    if (lEyeOuter && lEyeInner && rEyeInner && rEyeOuter) {
      const lx = (lEyeOuter.x + lEyeInner.x) * 0.5 * video.videoWidth;
      const ly = (lEyeOuter.y + lEyeInner.y) * 0.5 * video.videoHeight;
      const rxPx = (rEyeInner.x + rEyeOuter.x) * 0.5 * video.videoWidth;
      const ryPx = (rEyeInner.y + rEyeOuter.y) * 0.5 * video.videoHeight;
      const dx = rxPx - lx;
      const dy = ryPx - ly;
      if (Math.abs(dx) > 8) {
        headTiltDeg = Math.max(
          -35,
          Math.min(35, (Math.atan2(dy, dx) * 180) / Math.PI)
        );
      }
    }

    // Head yaw symmetry check via nose tip (lm 1) vs ear tragi (lm 234 & 454)
    const nose = landmarks[1];
    const leftTragus = landmarks[234];
    const rightTragus = landmarks[454];
    let yawRatio = 0;
    if (nose && leftTragus && rightTragus) {
      const dL = Math.hypot(nose.x - leftTragus.x, nose.y - leftTragus.y);
      const dR = Math.hypot(rightTragus.x - nose.x, rightTragus.y - nose.y);
      if (dL + dR > 0.02) {
        yawRatio = Math.max(-1, Math.min(1, (dL - dR) / (dL + dR)));
      }
    }

    // Anatomical Forehead ROI anchored above brow bridge (105/334) and below hairline (10)
    const rawFh = computeLandmarkSubBox(landmarks, FOREHEAD_LANDMARKS, 0.002, 0.002);
    const browTopY = Math.min(
      landmarks[105]?.y ?? cy - 0.34 * ry,
      landmarks[334]?.y ?? cy - 0.34 * ry
    );
    const hairlineY = landmarks[10]?.y ?? cy - 0.8 * ry;
    const fhTop = clamp01(hairlineY + (browTopY - hairlineY) * 0.14);
    const fhBottom = clamp01(browTopY - (browTopY - hairlineY) * 0.12);

    const forehead: NormalizedBox = rawFh
      ? {
          x0: rawFh.x0,
          y0: Math.min(rawFh.y0, fhTop),
          x1: rawFh.x1,
          y1: Math.max(fhTop + 0.025, fhBottom),
        }
      : {
          x0: clamp01(cx - 0.5 * rx),
          y0: clamp01(cy - 0.7 * ry),
          x1: clamp01(cx + 0.5 * rx),
          y1: clamp01(cy - 0.38 * ry),
        };

    const leftCheek =
      computeLandmarkSubBox(landmarks, LEFT_CHEEK_LANDMARKS, 0.003, 0.003) ?? {
        x0: clamp01(cx - 0.72 * rx),
        y0: clamp01(cy + 0.01 * ry),
        x1: clamp01(cx - 0.2 * rx),
        y1: clamp01(cy + 0.38 * ry),
      };

    const rightCheek =
      computeLandmarkSubBox(landmarks, RIGHT_CHEEK_LANDMARKS, 0.003, 0.003) ?? {
        x0: clamp01(cx + 0.2 * rx),
        y0: clamp01(cy + 0.01 * ry),
        x1: clamp01(cx + 0.72 * rx),
        y1: clamp01(cy + 0.38 * ry),
      };

    return {
      detected: true,
      hint: {
        box: { cx, cy, rx, ry, headTiltDeg },
        regions: { forehead, leftCheek, rightCheek },
        yawRatio,
        ts: nowMs,
      },
    };
  }

  public dispose(): void {
    try {
      this.landmarker?.close();
    } catch {
      // Ignore cleanup errors
    }
    this.landmarker = null;
    this.initPromise = null;
    this.lastVideoTs = -1;
  }
}
