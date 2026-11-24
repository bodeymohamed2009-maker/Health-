import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  Activity,
  AlertTriangle,
  BookmarkPlus,
  Camera,
  CheckCircle2,
  Droplets,
  Eye,
  EyeOff,
  FileText,
  Flashlight,
  HeartPulse,
  Info,
  Moon,
  Play,
  ShieldAlert,
  Sparkles,
  Square,
  Sun,
  Volume2,
  VolumeX,
  Waves,
  Wind,
} from "lucide-react";
import { BreathingPacer } from "./components/BreathingPacer";
import { HrvAlertBanner } from "./components/HrvAlertBanner";
import { HydrationAlertCard } from "./components/HydrationAlertCard";
import { HrvTrendsChart } from "./components/HrvTrendsChart";
import { InteractivePipeline } from "./components/InteractivePipeline";
import {
  MetricInspectorDrawer,
  type MetricInspectorKey,
} from "./components/MetricInspectorDrawer";
import { PoincarePlot } from "./components/PoincarePlot";
import { RespirationChart } from "./components/RespirationChart";
import { SessionLogTable } from "./components/SessionLogTable";
import { SessionReportModal } from "./components/SessionReportModal";
import { SignalConfidenceGauge } from "./components/SignalConfidenceGauge";
import { SpectrumChart } from "./components/SpectrumChart";
import { WaveformChart } from "./components/WaveformChart";
import { WeeklyAveragesPanel } from "./components/WeeklyAveragesPanel";
import { PulseAudioSynthesizer } from "./dsp/pulseAudio";
import { RoiFrameExtractor } from "./dsp/roiExtractor";
import {
  createInitialHydrationState,
  evaluateHydrationAlert,
  getLocalDateKey,
  getTodayReadings,
  type HydrationDailyState,
} from "./dsp/hydrationAlerts";
import { evaluateHrvSmartAlert } from "./dsp/hrvInsights";
import { getAgeAdjustedNorms } from "./dsp/hrvTrends";
import { KalmanBpmTracker, analyzeRppgBuffer } from "./dsp/rppgEngine";
import type {
  BiometricProfile,
  CaptureMode,
  FaceBox,
  RgbSample,
  RoiBox,
  RppgAlgorithm,
  RppgMetrics,
  ScanDuration,
  SessionReading,
  SignalQualityState,
  ZoneGuidance,
} from "./types/rppg";

const INITIAL_METRICS: RppgMetrics = {
  bpm: null,
  rawFftBpm: null,
  confidence: 0,
  snrDb: 0,
  ambientCanceledDb: 0,
  awb: {
    enabled: true,
    gainR: 1,
    gainG: 1,
    gainB: 1,
    colorTempK: 5500,
    driftReducedPct: 0,
  },
  algoWeights: { pos: 36, chrom: 30, ica: 18, green: 16 },
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
  roiWeights: { forehead: 34, leftCheek: 33, rightCheek: 33 },
  fps: 0,
  skinCoveragePct: 0,
  brightness: 0,
  motionIndex: 0,
  specularRejectedPct: 0,
  signalState: "idle",
  waveform: [],
  peakIndices: [],
  spectrum: [],
  dominantFreqHz: null,
  bufferSeconds: 0,
};

function getZoneGuidanceText(guidance: ZoneGuidance, mode: CaptureMode): string {
  if (mode === "finger") {
    return "أعد تغطية عدسة الكاميرا بإصبعك بلطف لاستئناف القياس";
  }
  switch (guidance) {
    case "off_center":
      return "وجهك قريب جداً من حافة الكاميرا — اقترب قليلاً نحو داخل الكادر للاستئناف";
    case "too_far":
      return "وجهك بعيد عن العدسة — قرّب وجهك قليلاً لاستئناف القياس";
    case "too_close":
      return "وجهك قريب جداً من العدسة — أبعد وجهك قليلاً لاستئناف القياس";
    case "low_light":
      return "الإضاءة منخفضة — وجّه إضاءة خفيفة نحو الوجه للاستئناف";
    case "no_face":
    default:
      return "لم يتم رصد الوجه في الكادر — اظهر أمام الكاميرا ليلتقطه الإطار تلقائياً";
  }
}

function getSignalStatusBadge(state: SignalQualityState): {
  label: string;
  toneClass: string;
} {
  switch (state) {
    case "nominal":
      return {
        label: "● إشارة مستقرة (Kalman Lock)",
        toneClass: "text-emerald-700 dark:text-emerald-400",
      };
    case "paused":
      return {
        label: "⏸ متوقف مؤقتاً — خارج النطاق",
        toneClass: "text-amber-800 dark:text-amber-400",
      };
    case "calibrating":
      return {
        label: "○ جارٍ تجميع العينة...",
        toneClass: "text-cyan-700 dark:text-cyan-400",
      };
    case "motion":
      return {
        label: "▲ حركة أو تشويش مرتفع",
        toneClass: "text-amber-800 dark:text-amber-400",
      };
    case "low_light":
      return {
        label: "▲ إضاءة غير كافية",
        toneClass: "text-amber-800 dark:text-amber-400",
      };
    case "no_skin":
      return {
        label: "✖ لم يتم رصد البشرة داخل الإطار",
        toneClass: "text-rose-700 dark:text-rose-400",
      };
    default:
      return {
        label: "○ جاهز للمسح البصري",
        toneClass: "text-slate-600 dark:text-slate-400",
      };
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const samplesRef = useRef<RgbSample[]>([]);
  const extractorRef = useRef<RoiFrameExtractor>(new RoiFrameExtractor());
  const kalmanRef = useRef<KalmanBpmTracker>(new KalmanBpmTracker());
  const lastAnalyzeTimeRef = useRef<number>(0);
  const scanStartTimeRef = useRef<number>(0);
  const activeElapsedMsRef = useRef<number>(0);
  const lastTickTimeRef = useRef<number>(0);
  const isPausedRef = useRef<boolean>(false);
  const pauseStartedAtRef = useRef<number | null>(null);
  const outOfZoneSinceRef = useRef<number | null>(null);
  const inZoneSinceRef = useRef<number | null>(null);
  const pulseAudioRef = useRef<PulseAudioSynthesizer>(new PulseAudioSynthesizer());
  const liveBpmRef = useRef<number | null>(null);
  const liveSignalStateRef = useRef<SignalQualityState>("idle");
  const nextBeepAtRef = useRef<number>(0);
  const lastBeepTimeRef = useRef<number>(0);
  const beatFlashTimeoutRef = useRef<number | null>(null);

  const [mode, setMode] = useState<CaptureMode>("face");
  const [algorithm, setAlgorithm] = useState<RppgAlgorithm>("FUSION");
  const [scanDuration, setScanDuration] = useState<ScanDuration>(15);
  const [nlmsEnabled, setNlmsEnabled] = useState<boolean>(true);
  const [awbEnabled, setAwbEnabled] = useState<boolean>(true);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pulselab_sound_enabled_v1") !== "false";
    } catch {
      return true;
    }
  });
  const soundEnabledRef = useRef<boolean>(soundEnabled);
  const [hrvAlertsEnabled, setHrvAlertsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pulselab_hrv_alerts_enabled_v1") !== "false";
    } catch {
      return true;
    }
  });
  const [hydrationAlertsEnabled, setHydrationAlertsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pulselab_hydration_alerts_enabled_v1") !== "false";
    } catch {
      return true;
    }
  });
  const [hydrationState, setHydrationState] = useState<HydrationDailyState>(() => {
    const todayKey = getLocalDateKey();
    try {
      const raw = localStorage.getItem("pulselab_hydration_v1");
      if (!raw) return createInitialHydrationState(todayKey);
      const parsed = JSON.parse(raw) as Partial<HydrationDailyState>;
      if (parsed?.dateKey !== todayKey) {
        return createInitialHydrationState(todayKey);
      }
      return {
        dateKey: todayKey,
        glassesDrank: typeof parsed.glassesDrank === "number" ? parsed.glassesDrank : 0,
        lastAckMeasurements:
          typeof parsed.lastAckMeasurements === "number" ? parsed.lastAckMeasurements : 0,
        snoozedUntilMeasurements:
          typeof parsed.snoozedUntilMeasurements === "number"
            ? parsed.snoozedUntilMeasurements
            : 0,
      };
    } catch {
      return createInitialHydrationState(todayKey);
    }
  });
  const [beatFlash, setBeatFlash] = useState<boolean>(false);

  const [isRunning, setIsRunning] = useState(false);
  const [isPausedByZone, setIsPausedByZone] = useState(false);
  const [zoneGuidance, setZoneGuidance] = useState<ZoneGuidance>("ok");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [roiBoxes, setRoiBoxes] = useState<RoiBox[]>([]);
  const [faceBox, setFaceBox] = useState<FaceBox>({
    cx: 0.5,
    cy: 0.46,
    rx: 0.2,
    ry: 0.32,
  });
  const [metrics, setMetrics] = useState<RppgMetrics>(INITIAL_METRICS);
  const [profile, setProfile] = useState<BiometricProfile>(() => {
    try {
      const raw = localStorage.getItem("pulselab_biometric_profile_v1");
      if (!raw) return { age: null, heightCm: null, weightKg: null };
      const p = JSON.parse(raw);
      return {
        age: typeof p?.age === "number" ? p.age : null,
        heightCm: typeof p?.heightCm === "number" ? p.heightCm : null,
        weightKg: typeof p?.weightKg === "number" ? p.weightKg : null,
      };
    } catch {
      return { age: null, heightCm: null, weightKg: null };
    }
  });
  const [readings, setReadings] = useState<SessionReading[]>(() => {
    try {
      const raw = localStorage.getItem("pulselab_session_readings_v1");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SessionReading[]) : [];
    } catch {
      return [];
    }
  });
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [analyticsTab, setAnalyticsTab] = useState<
    "all" | "signals" | "autonomic" | "trends" | "weekly"
  >("all");
  const [selectedMetric, setSelectedMetric] =
    useState<MetricInspectorKey | null>(null);
  const [pacerOpen, setPacerOpen] = useState(false);
  const [showRoiOverlay, setShowRoiOverlay] = useState(true);
  const [activeSection, setActiveSection] = useState<string>("console");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("pulselab_theme_v1") === "light"
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("pulselab_theme_v1", theme);
    } catch {
      // Ignore storage errors
    }
  }, [theme]);

  useEffect(() => {
    const ids = ["console", "waveforms", "autonomic", "science", "distinction"];
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0 || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]?.target?.id) {
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: "-25% 0px -55% 0px", threshold: [0.1, 0.35, 0.6] }
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [analyticsTab]);

  const handleInspectorFocusTab = useCallback(
    (tab: "signals" | "autonomic" | "trends") => {
      setAnalyticsTab(tab);
      const targetId =
        tab === "signals"
          ? "waveforms"
          : tab === "autonomic"
          ? "autonomic"
          : "analytics-workspace";
      window.setTimeout(() => {
        document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth" });
      }, 60);
    },
    []
  );

  useEffect(() => {
    try {
      localStorage.setItem("pulselab_biometric_profile_v1", JSON.stringify(profile));
    } catch {
      // Ignore storage errors
    }
  }, [profile]);

  useEffect(() => {
    try {
      localStorage.setItem("pulselab_session_readings_v1", JSON.stringify(readings));
    } catch {
      // Ignore storage quota or private browsing errors
    }
  }, [readings]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    try {
      localStorage.setItem(
        "pulselab_sound_enabled_v1",
        soundEnabled ? "true" : "false"
      );
    } catch {
      // Ignore storage errors
    }
  }, [soundEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "pulselab_hrv_alerts_enabled_v1",
        hrvAlertsEnabled ? "true" : "false"
      );
    } catch {
      // Ignore storage errors
    }
  }, [hrvAlertsEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "pulselab_hydration_alerts_enabled_v1",
        hydrationAlertsEnabled ? "true" : "false"
      );
    } catch {
      // Ignore storage errors
    }
  }, [hydrationAlertsEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem("pulselab_hydration_v1", JSON.stringify(hydrationState));
    } catch {
      // Ignore storage errors
    }
  }, [hydrationState]);

  const triggerBeatFlash = useCallback(() => {
    if (beatFlashTimeoutRef.current !== null) {
      window.clearTimeout(beatFlashTimeoutRef.current);
    }
    setBeatFlash(true);
    beatFlashTimeoutRef.current = window.setTimeout(() => {
      setBeatFlash(false);
      beatFlashTimeoutRef.current = null;
    }, 115);
  }, []);

  const stopAcquisition = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsRunning(false);
    setIsPausedByZone(false);
    isPausedRef.current = false;
    pauseStartedAtRef.current = null;
    outOfZoneSinceRef.current = null;
    inZoneSinceRef.current = null;
    liveBpmRef.current = null;
    liveSignalStateRef.current = "idle";
    nextBeepAtRef.current = 0;
    lastBeepTimeRef.current = 0;
    if (beatFlashTimeoutRef.current !== null) {
      window.clearTimeout(beatFlashTimeoutRef.current);
      beatFlashTimeoutRef.current = null;
    }
    setBeatFlash(false);
    setTorchEnabled(false);
    setTorchSupported(false);
  }, []);

  const recordSnapshot = useCallback(
    (
      currentMetrics: RppgMetrics,
      activeMode: CaptureMode,
      activeAlgo: RppgAlgorithm,
      duration: number
    ) => {
      if (currentMetrics.bpm === null) return;
      const now = new Date();
      const timeLabel = now.toLocaleTimeString("en-GB", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const entry: SessionReading = {
        id: `${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
        dateKey: getLocalDateKey(now),
        timestamp: timeLabel,
        mode: activeMode,
        algorithm: activeAlgo,
        bpm: currentMetrics.bpm,
        respirationBrpm: currentMetrics.respirationBrpm,
        rmssdMs: currentMetrics.rmssdMs,
        sdnnMs: currentMetrics.sdnnMs,
        sd1Ms: currentMetrics.sd1Ms,
        sd2Ms: currentMetrics.sd2Ms,
        coherencePct: currentMetrics.coherencePct,
        snrDb: currentMetrics.snrDb,
        durationSec: Math.round(duration),
      };
      setReadings((prev) => [entry, ...prev].slice(0, 50));
      setSaveNotice(
        `تم تسجيل القراءة: ${currentMetrics.bpm} BPM${
          currentMetrics.respirationBrpm !== null
            ? ` · ${currentMetrics.respirationBrpm} BrPM`
            : ""
        }`
      );
    },
    []
  );

  const toggleTorch = useCallback(async (nextState: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ torch: nextState } as MediaTrackConstraintSet],
      });
      setTorchEnabled(nextState);
    } catch {
      setTorchSupported(false);
    }
  }, []);

  const startAcquisition = useCallback(async () => {
    stopAcquisition();
    pulseAudioRef.current.unlock();
    setCameraError(null);
    setSaveNotice(null);
    samplesRef.current = [];
    extractorRef.current.reset();
    kalmanRef.current.reset();
    lastAnalyzeTimeRef.current = 0;
    const nowTs = performance.now();
    scanStartTimeRef.current = nowTs;
    activeElapsedMsRef.current = 0;
    lastTickTimeRef.current = nowTs;
    isPausedRef.current = false;
    pauseStartedAtRef.current = null;
    outOfZoneSinceRef.current = null;
    inZoneSinceRef.current = null;
    liveBpmRef.current = null;
    liveSignalStateRef.current = "calibrating";
    nextBeepAtRef.current = 0;
    lastBeepTimeRef.current = 0;
    setIsPausedByZone(false);
    setZoneGuidance("ok");
    setElapsedSec(0);
    setFaceBox({ cx: 0.5, cy: 0.46, rx: 0.2, ry: 0.32 });
    setMetrics({ ...INITIAL_METRICS, signalState: "calibrating" });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        "المتصفح أو البيئة الحالية لا تدعم الوصول للكاميرا. يرجى فتح التطبيق في متصفح حديث يدعم الكاميرا."
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode === "finger" ? { ideal: "environment" } : "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];

      if (track && typeof track.getCapabilities === "function") {
        const caps = track.getCapabilities() as MediaTrackCapabilities & {
          torch?: boolean;
          whiteBalanceMode?: string[];
        };
        if (caps.torch) {
          setTorchSupported(true);
          if (mode === "finger") {
            try {
              await track.applyConstraints({
                advanced: [{ torch: true } as MediaTrackConstraintSet],
              });
              setTorchEnabled(true);
            } catch {
              setTorchEnabled(false);
            }
          }
        }
        if (caps.whiteBalanceMode?.includes("manual")) {
          try {
            await track.applyConstraints({
              advanced: [{ whiteBalanceMode: "manual" } as MediaTrackConstraintSet],
            });
          } catch {
            // Optional hardware lock
          }
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setIsRunning(true);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "تعذر الوصول إلى الكاميرا";
      setCameraError(
        `تعذر تشغيل الكاميرا (${msg}). تأكد من منح إذن الكاميرا وعدم استخدامها في تطبيق آخر.`
      );
      stopAcquisition();
    }
  }, [mode, stopAcquisition]);

  useEffect(() => {
    if (!isRunning) return;

    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;

      const dtMs =
        lastTickTimeRef.current > 0
          ? Math.min(120, Math.max(0, now - lastTickTimeRef.current))
          : 0;
      lastTickTimeRef.current = now;

      let frameInZone = false;

      const video = videoRef.current;
      const canvas = analysisCanvasRef.current;
      if (video && canvas && video.readyState >= 2) {
        if (mode === "face") {
          extractorRef.current.pollNativeFaceDetector(video, now);
        }
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const roi = extractorRef.current.extract(imgData, mode, awbEnabled);
          setRoiBoxes(roi.roiBoxes);
          setFaceBox(roi.faceBox);
          setZoneGuidance(roi.zoneGuidance);
          frameInZone = roi.inZone;

          // Auto-Pause / Seamless Resume Zone State Machine
          if (roi.inZone) {
            outOfZoneSinceRef.current = null;
            if (isPausedRef.current) {
              inZoneSinceRef.current ??= now;
              if (now - inZoneSinceRef.current >= 220) {
                const pauseDuration =
                  pauseStartedAtRef.current !== null
                    ? now - pauseStartedAtRef.current
                    : 0;
                if (pauseDuration > 18000) {
                  // Long absence: start clean window without stale beats
                  samplesRef.current = [];
                  kalmanRef.current.reset();
                } else if (pauseDuration > 0) {
                  // Temporary departure: shift timestamps forward for gap-free continuity
                  for (const s of samplesRef.current) {
                    s.t += pauseDuration;
                  }
                }
                isPausedRef.current = false;
                pauseStartedAtRef.current = null;
                inZoneSinceRef.current = null;
                setIsPausedByZone(false);
              }
            }
          } else {
            inZoneSinceRef.current = null;
            if (!isPausedRef.current) {
              outOfZoneSinceRef.current ??= now;
              if (now - outOfZoneSinceRef.current >= 320) {
                isPausedRef.current = true;
                pauseStartedAtRef.current = now;
                setIsPausedByZone(true);
                setMetrics((prev) => ({
                  ...prev,
                  skinCoveragePct: Math.round(roi.skinCoveragePct),
                  brightness: Math.round(roi.brightness),
                  motionIndex: Number(roi.motionIndex.toFixed(1)),
                  specularRejectedPct: Number(roi.specularRejectedPct.toFixed(1)),
                  signalState: "paused",
                }));
              }
            }
          }

          if (!isPausedRef.current && roi.inZone) {
            activeElapsedMsRef.current += dtMs;
            setElapsedSec(activeElapsedMsRef.current / 1000);

            if (roi.hasValidTarget) {
              samplesRef.current.push({
                t: now,
                r: roi.r,
                g: roi.g,
                b: roi.b,
                bgR: roi.bgR,
                bgG: roi.bgG,
                bgB: roi.bgB,
                motion: roi.motionIndex,
                skinPct: roi.skinCoveragePct,
                luma: roi.brightness,
                specularRejectedPct: roi.specularRejectedPct,
                awb: roi.awb,
                regions: roi.regions,
              });
              if (samplesRef.current.length > 960) {
                samplesRef.current.shift();
              }
            }
          }
        }
      }

      const activeElapsed = activeElapsedMsRef.current / 1000;

      if (
        !isPausedRef.current &&
        frameInZone &&
        now - lastAnalyzeTimeRef.current >= 200
      ) {
        lastAnalyzeTimeRef.current = now;
        const computed = analyzeRppgBuffer(
          samplesRef.current,
          algorithm,
          mode,
          {
            enableNlms: nlmsEnabled,
            enableAwb: awbEnabled,
            kalman: kalmanRef.current,
          }
        );
        setMetrics(computed);
        liveBpmRef.current = computed.bpm;
        liveSignalStateRef.current = computed.signalState;

        if (
          computed.bpm !== null &&
          computed.bpm > 0 &&
          computed.waveform.length > 0 &&
          computed.peakIndices.length > 0
        ) {
          const periodMs = 60000 / computed.bpm;
          const lastPeakIdx =
            computed.peakIndices[computed.peakIndices.length - 1];
          const framesAgo = computed.waveform.length - 1 - lastPeakIdx;
          if (framesAgo >= 0 && framesAgo <= 6) {
            const dtSampleMs =
              samplesRef.current.length >= 2
                ? Math.min(
                    50,
                    Math.max(
                      20,
                      (samplesRef.current[samplesRef.current.length - 1].t -
                        samplesRef.current[0].t) /
                        Math.max(1, samplesRef.current.length - 1)
                    )
                  )
                : 33.3;
            const estimatedLastPeakAt = now - framesAgo * dtSampleMs;
            const predictedNextPeakAt = estimatedLastPeakAt + periodMs;
            if (
              predictedNextPeakAt >= now - 40 &&
              predictedNextPeakAt - lastBeepTimeRef.current >= periodMs * 0.55
            ) {
              nextBeepAtRef.current = predictedNextPeakAt;
            }
          }
        }

        if (scanDuration > 0 && activeElapsed >= scanDuration) {
          if (computed.bpm !== null) {
            recordSnapshot(computed, mode, algorithm, scanDuration);
          }
          stopAcquisition();
          return;
        }
      }

      const audioReady =
        !isPausedRef.current &&
        frameInZone &&
        liveBpmRef.current !== null &&
        liveBpmRef.current > 0 &&
        liveSignalStateRef.current !== "idle" &&
        liveSignalStateRef.current !== "no_skin" &&
        liveSignalStateRef.current !== "low_light";

      if (audioReady && soundEnabledRef.current) {
        const periodMs = 60000 / liveBpmRef.current!;
        if (nextBeepAtRef.current <= 0) {
          nextBeepAtRef.current = now + Math.min(350, periodMs * 0.45);
        } else if (now >= nextBeepAtRef.current) {
          if (now - lastBeepTimeRef.current >= periodMs * 0.6) {
            pulseAudioRef.current.playHeartbeatBeep(liveBpmRef.current);
            lastBeepTimeRef.current = now;
            triggerBeatFlash();
          }
          nextBeepAtRef.current = now + periodMs;
        }
      } else {
        nextBeepAtRef.current = 0;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [
    isRunning,
    mode,
    algorithm,
    nlmsEnabled,
    awbEnabled,
    scanDuration,
    recordSnapshot,
    stopAcquisition,
    triggerBeatFlash,
  ]);

  useEffect(() => {
    const synth = pulseAudioRef.current;
    return () => {
      stopAcquisition();
      synth.dispose();
    };
  }, [stopAcquisition]);

  function handleToggleSound() {
    const next = !soundEnabled;
    soundEnabledRef.current = next;
    setSoundEnabled(next);
    if (next) {
      pulseAudioRef.current.unlock();
      if (
        !isRunning ||
        liveBpmRef.current === null ||
        isPausedRef.current
      ) {
        pulseAudioRef.current.playHeartbeatBeep(liveBpmRef.current ?? 72);
        triggerBeatFlash();
      }
    } else {
      nextBeepAtRef.current = 0;
      if (beatFlashTimeoutRef.current !== null) {
        window.clearTimeout(beatFlashTimeoutRef.current);
        beatFlashTimeoutRef.current = null;
      }
      setBeatFlash(false);
    }
  }

  function handleModeChange(nextMode: CaptureMode) {
    if (isRunning) stopAcquisition();
    setMode(nextMode);
    setCameraError(null);
    setRoiBoxes([]);
    kalmanRef.current.reset();
    setMetrics(INITIAL_METRICS);
  }

  function handleExportCsv() {
    if (readings.length === 0) return;
    const header = [
      "timestamp",
      "mode",
      "algorithm",
      "bpm",
      "respiration_brpm",
      "coherence_pct",
      "rmssd_ms",
      "sdnn_ms",
      "sd1_ms",
      "sd2_ms",
      "snr_db",
      "duration_sec",
    ].join(",");
    const rows = readings.map((r) =>
      [
        r.timestamp,
        r.mode,
        r.algorithm,
        r.bpm,
        r.respirationBrpm ?? "",
        r.coherencePct ?? "",
        r.rmssdMs ?? "",
        r.sdnnMs ?? "",
        r.sd1Ms ?? "",
        r.sd2Ms ?? "",
        r.snrDb,
        r.durationSec,
      ].join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pulselab-rppg-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const hrvSmartAlert = useMemo(
    () =>
      evaluateHrvSmartAlert({
        metrics,
        profile,
        readings,
        isRunning,
        isPausedByZone,
      }),
    [metrics, profile, readings, isRunning, isPausedByZone]
  );

  const todayKey = getLocalDateKey();
  const todayMeasurementsCount = useMemo(
    () => getTodayReadings(readings, todayKey).length,
    [readings, todayKey]
  );

  const hydrationAlert = useMemo(
    () =>
      evaluateHydrationAlert({
        readings,
        hydrationState,
        profile,
        liveMetrics: metrics,
        todayKey,
      }),
    [readings, hydrationState, profile, metrics, todayKey]
  );

  function handleAcknowledgeDrink() {
    const key = getLocalDateKey();
    const count = getTodayReadings(readings, key).length;
    setHydrationState((prev) => {
      const base = prev.dateKey === key ? prev : createInitialHydrationState(key);
      return {
        dateKey: key,
        glassesDrank: Math.min(20, base.glassesDrank + 1),
        lastAckMeasurements: count,
        snoozedUntilMeasurements: 0,
      };
    });
  }

  function handleSnoozeHydration() {
    const key = getLocalDateKey();
    const count = getTodayReadings(readings, key).length;
    setHydrationState((prev) => {
      const base = prev.dateKey === key ? prev : createInitialHydrationState(key);
      return {
        ...base,
        dateKey: key,
        snoozedUntilMeasurements: count + 1,
      };
    });
  }

  const statusBadge = getSignalStatusBadge(metrics.signalState);
  const progressPct =
    scanDuration > 0
      ? Math.min(100, Math.round((elapsedSec / scanDuration) * 100))
      : 0;

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-slate-50 dark:bg-[#060911] dark:bg-[radial-gradient(ellipse_80%_42%_at_50%_-6%,rgba(34,211,238,0.085),rgba(20,184,166,0.025)_45%,transparent_75%)] text-slate-900 dark:text-slate-200 flex flex-col transition-colors duration-200">
        {/* Top Bar Contract: Single Row, 3 Zones */}
        <header className="sticky top-0 z-30 bg-white/95 dark:bg-[#060911]/90 backdrop-blur-md border-b border-slate-300 dark:border-slate-800/80 no-print">
          <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between gap-8">
            <a
              href="#"
              dir="ltr"
              className="text-lg font-bold tracking-tight text-slate-950 dark:text-white whitespace-nowrap shrink-0 hover:text-cyan-700 dark:hover:text-cyan-300 transition-colors"
            >
              PulseLab Pro
            </a>

            <nav
              aria-label="التنقل الرئيسي"
              className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400"
            >
              {[
                { id: "console", href: "#console", label: "جهاز القياس" },
                { id: "waveforms", href: "#waveforms", label: "التحليل الطيفي" },
                { id: "autonomic", href: "#autonomic", label: "التوازن العصبي" },
                { id: "science", href: "#science", label: "الابتكارات العلمية" },
                { id: "distinction", href: "#distinction", label: "تميّز" },
              ].map((link) => {
                const isActive = activeSection === link.id;
                return (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => {
                      setActiveSection(link.id);
                      if (
                        link.id === "waveforms" &&
                        analyticsTab !== "all" &&
                        analyticsTab !== "signals"
                      ) {
                        setAnalyticsTab("all");
                      } else if (
                        link.id === "autonomic" &&
                        analyticsTab !== "all" &&
                        analyticsTab !== "autonomic"
                      ) {
                        setAnalyticsTab("all");
                      }
                    }}
                    className={`relative py-1.5 transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? "text-slate-950 dark:text-white font-semibold"
                        : "hover:text-slate-950 dark:hover:text-slate-200"
                    }`}
                  >
                    <span>{link.label}</span>
                    {isActive && (
                      <motion.span
                        layoutId="nav-active-bar"
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        className="absolute inset-x-0 bottom-0 h-[1.5px] bg-cyan-700 dark:bg-cyan-400"
                      />
                    )}
                  </a>
                );
              })}
            </nav>

            <div className="flex items-center gap-2.5 shrink-0">
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                aria-label={
                  theme === "dark"
                    ? "التبديل إلى الوضع السريري الفاتح عالي التباين"
                    : "التبديل إلى الوضع الداكن"
                }
                aria-pressed={theme === "light"}
                title={theme === "dark" ? "الوضع السريري الفاتح" : "الوضع الداكن"}
                className="inline-flex items-center justify-center w-10 h-10 rounded-lg border border-slate-300 dark:border-slate-700/80 bg-white dark:bg-[#0c1322] text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 hover:border-slate-400 dark:hover:border-slate-600 transition-colors shrink-0 cursor-pointer"
              >
                {theme === "dark" ? (
                  <Sun className="w-4 h-4 text-amber-300" />
                ) : (
                  <Moon className="w-4 h-4 text-cyan-800" />
                )}
              </motion.button>

              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={isRunning ? stopAcquisition : startAcquisition}
                className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isRunning
                    ? "bg-rose-700 hover:bg-rose-800 dark:bg-rose-600 dark:hover:bg-rose-500 text-white"
                    : "bg-cyan-700 hover:bg-cyan-800 text-white dark:bg-cyan-400 dark:hover:bg-cyan-300 dark:text-slate-950 dark:shadow-[0_0_20px_rgba(34,211,238,0.18)]"
                }`}
              >
                {isRunning ? (
                  <>
                    <Square className="w-3.5 h-3.5" />
                    <span>إيقاف القياس</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>بدء القياس</span>
                  </>
                )}
              </motion.button>
            </div>
          </div>
        </header>

        <main className="flex-1 no-print">
          {/* Sleek Clinical Telemetry Ribbon */}
          <div className="bg-slate-100 dark:bg-[#080d16]/85 border-b border-slate-300 dark:border-slate-800/75">
            <div className="max-w-7xl mx-auto px-6 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-400">
              <div className="flex items-center gap-2 min-w-0">
                <Info className="w-3.5 h-3.5 text-cyan-700 dark:text-cyan-400 shrink-0" />
                <span className="truncate">
                  محطة قياس بصرية للبحث العلمي (rPPG) · معالجة محلية 100% داخل المتصفح دون رفع أي بيانات
                </span>
              </div>
              <div
                dir="ltr"
                className="flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-slate-800 dark:text-slate-300 tabular-nums shrink-0"
              >
                <span className="text-cyan-800 dark:text-cyan-300 font-semibold">
                  {mode === "finger"
                    ? "Contact PPG"
                    : algorithm === "FUSION"
                    ? "Quad-Fusion"
                    : algorithm}
                </span>
                <span className="text-slate-400 dark:text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span>
                  {mode === "finger"
                    ? "AWB Contact"
                    : awbEnabled
                    ? `AWB ${metrics.awb.colorTempK}K`
                    : "AWB OFF"}
                </span>
                <span className="text-slate-400 dark:text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span>
                  {nlmsEnabled
                    ? `NLMS -${metrics.ambientCanceledDb.toFixed(1)} dB`
                    : "NLMS OFF"}
                </span>
              </div>
            </div>
          </div>

          {/* Asymmetric Split Console */}
          <section
            id="console"
            className="max-w-7xl mx-auto px-6 py-7 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
          >
            {/* Left Control & Calibration Column (4 cols) */}
            <motion.aside
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              className="lg:col-span-4 bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 rounded-xl p-5 flex flex-col divide-y divide-slate-200 dark:divide-slate-800/80 shadow-xs dark:shadow-[0_12px_40px_-24px_rgba(6,182,212,0.16)]"
            >
              <div className="flex items-start justify-between gap-3 pb-4">
                <div>
                  <h1 className="text-lg font-bold text-slate-950 dark:text-white tracking-wide">
                    وحدة التحكم والمعايرة
                  </h1>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                    معالجة محلية كاملة 30 Hz دون رفع أي صور
                  </p>
                </div>
                {metrics.bpm !== null && (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.96 }}
                    onClick={() => setReportOpen(true)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-cyan-800 dark:text-cyan-300 bg-slate-50 dark:bg-[#060911] border border-slate-300 dark:border-slate-700 hover:border-cyan-600 dark:hover:border-cyan-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>التقرير</span>
                  </motion.button>
                )}
              </div>

              {/* Pre-Scan Biometric Profile (Age, Height & Weight Calibration) */}
              {(() => {
                const norms = getAgeAdjustedNorms(profile.age);
                const bmi =
                  profile.heightCm && profile.weightKg && profile.heightCm > 0
                    ? (
                        profile.weightKg /
                        Math.pow(profile.heightCm / 100, 2)
                      ).toFixed(1)
                    : null;
                return (
                  <div className="py-4 flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-200">
                        بياناتك قبل القياس
                      </span>
                      <span className="text-[11px] font-medium text-cyan-700 dark:text-cyan-400">
                        {profile.age && profile.heightCm
                          ? "✓ مُعايَر عمرّياً"
                          : "اختياري · يُحفظ تلقائياً"}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <label className="block">
                        <span className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1">
                          السن (سنة)
                        </span>
                        <input
                          type="number"
                          min={8}
                          max={110}
                          placeholder="25"
                          value={profile.age ?? ""}
                          onChange={(e) => {
                            const v = e.target.value === "" ? null : Number(e.target.value);
                            setProfile((prev) => ({
                              ...prev,
                              age: v !== null && Number.isFinite(v) ? v : null,
                            }));
                          }}
                          dir="ltr"
                          className="w-full bg-slate-50 dark:bg-[#060911] border border-slate-300 dark:border-slate-700/80 focus:border-cyan-700 dark:focus:border-cyan-400 rounded-md px-2.5 py-1.5 text-xs font-mono text-slate-950 dark:text-white placeholder:text-slate-400 outline-none tabular-nums transition-colors"
                        />
                      </label>

                      <label className="block">
                        <span className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1">
                          الطول (سم)
                        </span>
                        <input
                          type="number"
                          min={90}
                          max={230}
                          placeholder="175"
                          value={profile.heightCm ?? ""}
                          onChange={(e) => {
                            const v = e.target.value === "" ? null : Number(e.target.value);
                            setProfile((prev) => ({
                              ...prev,
                              heightCm: v !== null && Number.isFinite(v) ? v : null,
                            }));
                          }}
                          dir="ltr"
                          className="w-full bg-slate-50 dark:bg-[#060911] border border-slate-300 dark:border-slate-700/80 focus:border-cyan-700 dark:focus:border-cyan-400 rounded-md px-2.5 py-1.5 text-xs font-mono text-slate-950 dark:text-white placeholder:text-slate-400 outline-none tabular-nums transition-colors"
                        />
                      </label>

                      <label className="block">
                        <span className="block text-[10px] text-slate-600 dark:text-slate-400 mb-1">
                          الوزن (كجم)
                        </span>
                        <input
                          type="number"
                          min={25}
                          max={250}
                          placeholder="70"
                          value={profile.weightKg ?? ""}
                          onChange={(e) => {
                            const v = e.target.value === "" ? null : Number(e.target.value);
                            setProfile((prev) => ({
                              ...prev,
                              weightKg: v !== null && Number.isFinite(v) ? v : null,
                            }));
                          }}
                          dir="ltr"
                          className="w-full bg-slate-50 dark:bg-[#060911] border border-slate-300 dark:border-slate-700/80 focus:border-cyan-700 dark:focus:border-cyan-400 rounded-md px-2.5 py-1.5 text-xs font-mono text-slate-950 dark:text-white placeholder:text-slate-400 outline-none tabular-nums transition-colors"
                        />
                      </label>
                    </div>

                    {profile.age || bmi ? (
                      <div
                        dir="ltr"
                        className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[10px] font-mono text-slate-600 dark:text-slate-400 tabular-nums"
                      >
                        {norms.hrMaxBpm && (
                          <span>
                            HRmax: <strong className="text-cyan-800 dark:text-cyan-300">{norms.hrMaxBpm}</strong> BPM
                          </span>
                        )}
                        {profile.age && (
                          <span>
                            RMSSD Norm:{" "}
                            <strong className="text-emerald-700 dark:text-emerald-300">
                              {norms.expectedRmssdRange[0]}–{norms.expectedRmssdRange[1]} ms
                            </strong>
                          </span>
                        )}
                        {bmi && (
                          <span>
                            BMI: <strong className="text-slate-900 dark:text-slate-200">{bmi}</strong>
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                        يُضبط العمر تلقائياً أقصى نبض (Tanaka) والمدى الطبيعي لـ HRV وهدف الترطيب.
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Capture Mode, Algorithm & Scan Window */}
              <div className="py-4 flex flex-col gap-4">
                <div>
                  <span className="block text-xs font-semibold text-slate-800 dark:text-slate-300 mb-2">
                    نمط الالتقاط البصري
                  </span>
                  <div className="grid grid-cols-1 gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleModeChange("face")}
                      className={`flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                        mode === "face"
                          ? "bg-slate-900 dark:bg-slate-800/90 border-slate-900 dark:border-slate-700 text-white"
                          : "bg-slate-50 dark:bg-transparent border-slate-300 dark:border-slate-800/70 text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:border-slate-400 dark:hover:border-slate-700"
                      }`}
                    >
                      <span>كاميرا الوجه (تتبع ديناميكي)</span>
                      <span
                        dir="ltr"
                        className={`font-mono text-[11px] ${
                          mode === "face"
                            ? "text-cyan-300"
                            : "text-cyan-700 dark:text-cyan-400"
                        }`}
                      >
                        Multi-ROI
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleModeChange("finger")}
                      className={`flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                        mode === "finger"
                          ? "bg-slate-900 dark:bg-slate-800/90 border-slate-900 dark:border-slate-700 text-white"
                          : "bg-slate-50 dark:bg-transparent border-slate-300 dark:border-slate-800/70 text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:border-slate-400 dark:hover:border-slate-700"
                      }`}
                    >
                      <span>الإصبع + الفلاش الخلفي (Contact PPG)</span>
                      <span
                        dir="ltr"
                        className={`font-mono text-[11px] ${
                          mode === "finger"
                            ? "text-emerald-300"
                            : "text-emerald-700 dark:text-emerald-400"
                        }`}
                      >
                        R+G Contact
                      </span>
                    </button>
                  </div>
                </div>

                {mode !== "finger" && (
                  <div>
                    <span className="block text-xs font-semibold text-slate-800 dark:text-slate-300 mb-2">
                      خوارزمية استخلاص النبض
                    </span>
                    <div
                      dir="ltr"
                      className="grid grid-cols-5 gap-1 p-1 bg-slate-100 dark:bg-[#080d16] border border-slate-300 dark:border-slate-800/90 rounded-lg"
                    >
                      {(["FUSION", "POS", "CHROM", "ICA", "GREEN"] as RppgAlgorithm[]).map((algo) => (
                        <button
                          key={algo}
                          type="button"
                          onClick={() => setAlgorithm(algo)}
                          className={`relative py-1.5 text-[10px] font-mono font-semibold rounded-md transition-colors cursor-pointer ${
                            algorithm === algo
                              ? "text-cyan-800 dark:text-cyan-300"
                              : "text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200"
                          }`}
                        >
                          {algorithm === algo && (
                            <motion.span
                              layoutId="algo-active-pill"
                              transition={{ type: "spring", stiffness: 380, damping: 32 }}
                              className="absolute inset-0 bg-white dark:bg-slate-800 border border-slate-300/80 dark:border-transparent rounded-md shadow-xs dark:shadow-none"
                            />
                          )}
                          <span className="relative z-10">{algo}</span>
                        </button>
                      ))}
                    </div>
                    {algorithm === "FUSION" && (
                      <div
                        dir="ltr"
                        className="mt-2 flex items-center justify-between gap-2 text-[10px] font-mono text-slate-600 dark:text-slate-400 tabular-nums"
                      >
                        <span className="shrink-0">Quad-Fusion</span>
                        <span className="text-cyan-800 dark:text-cyan-300 truncate font-medium">
                          POS {metrics.algoWeights.pos}% · CHROM {metrics.algoWeights.chrom}% · ICA {metrics.algoWeights.ica ?? 0}% · GRN {metrics.algoWeights.green}%
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <span className="block text-xs font-semibold text-slate-800 dark:text-slate-300 mb-2">
                    مدة جلسة الفحص
                  </span>
                  <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-100 dark:bg-[#080d16] border border-slate-300 dark:border-slate-800/90 rounded-lg">
                    {(
                      [
                        { val: 15, label: "15 ثانية" },
                        { val: 30, label: "30 ثانية" },
                        { val: 0, label: "مستمر" },
                      ] as Array<{ val: ScanDuration; label: string }>
                    ).map((item) => (
                      <button
                        key={item.val}
                        type="button"
                        onClick={() => setScanDuration(item.val)}
                        className={`relative py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                          scanDuration === item.val
                            ? "text-slate-950 dark:text-white font-semibold"
                            : "text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200"
                        }`}
                      >
                        {scanDuration === item.val && (
                          <motion.span
                            layoutId="duration-active-pill"
                            transition={{ type: "spring", stiffness: 380, damping: 32 }}
                            className="absolute inset-0 bg-white dark:bg-slate-800 border border-slate-300/80 dark:border-transparent rounded-md shadow-xs dark:shadow-none"
                          />
                        )}
                        <span className="relative z-10">{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Signal Conditioning & Smart Alerts Hardware Switch Matrix */}
              <div className="py-4 flex flex-col divide-y divide-slate-200 dark:divide-slate-800/60">
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-300 pb-2.5">
                  معالجة الإشارة والتنبيهات الذكية
                </span>

                {mode !== "finger" && (
                  <>
                    <div className="py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span className="block text-xs font-semibold text-slate-900 dark:text-slate-200">
                            توازن اللون الأبيض التكيفي (AWB)
                          </span>
                          <span className="block text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 truncate">
                            تثبيت ألوان البشرة تحت إضاءة الغرفة
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={awbEnabled}
                          aria-label="توازن اللون الأبيض التكيفي AWB"
                          dir="ltr"
                          onClick={() => setAwbEnabled((v) => !v)}
                          className={`w-10 h-5 rounded-full p-0.5 flex items-center transition-colors duration-200 shrink-0 cursor-pointer ${
                            awbEnabled
                              ? "bg-emerald-600 dark:bg-emerald-500 justify-end"
                              : "bg-slate-300 dark:bg-slate-700/80 justify-start"
                          }`}
                        >
                          <motion.span
                            layout
                            transition={{ type: "spring", stiffness: 450, damping: 30 }}
                            className="w-4 h-4 rounded-full bg-white shadow-sm"
                          />
                        </button>
                      </div>
                      {awbEnabled && (
                        <div
                          dir="ltr"
                          className="mt-1.5 flex items-center justify-between text-[10px] font-mono text-slate-600 dark:text-slate-400 tabular-nums"
                        >
                          <span>CCT {metrics.awb.colorTempK}K</span>
                          <span>
                            R×{metrics.awb.gainR.toFixed(2)} G×{metrics.awb.gainG.toFixed(2)} B×{metrics.awb.gainB.toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="block text-xs font-semibold text-slate-900 dark:text-slate-200">
                          إلغاء وميض الإضاءة الخلفي (NLMS)
                        </span>
                        <span className="block text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 truncate">
                          طرح تذبذب الشاشة وLED تلقائياً
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={nlmsEnabled}
                        aria-label="إلغاء وميض الإضاءة الخلفي NLMS"
                        dir="ltr"
                        onClick={() => setNlmsEnabled((v) => !v)}
                        className={`w-10 h-5 rounded-full p-0.5 flex items-center transition-colors duration-200 shrink-0 cursor-pointer ${
                          nlmsEnabled
                            ? "bg-cyan-700 dark:bg-cyan-400 justify-end"
                            : "bg-slate-300 dark:bg-slate-700/80 justify-start"
                        }`}
                      >
                        <motion.span
                          layout
                          transition={{ type: "spring", stiffness: 450, damping: 30 }}
                          className="w-4 h-4 rounded-full bg-white shadow-sm"
                        />
                      </button>
                    </div>
                  </>
                )}

                <div className="py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                        soundEnabled
                          ? beatFlash
                            ? "bg-cyan-100 dark:bg-cyan-400/25 text-cyan-800 dark:text-cyan-300"
                            : "bg-cyan-50 dark:bg-cyan-500/10 text-cyan-700 dark:text-cyan-400"
                          : "bg-slate-100 dark:bg-slate-800/80 text-slate-500"
                      }`}
                    >
                      {soundEnabled ? (
                        <Volume2 className="w-3.5 h-3.5" />
                      ) : (
                        <VolumeX className="w-3.5 h-3.5" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-slate-200">
                        <span>التنبيه الصوتي للنبض</span>
                        {soundEnabled && isRunning && metrics.bpm !== null && !isPausedByZone && (
                          <span
                            className={`inline-block w-1.5 h-1.5 rounded-full transition-transform duration-100 ${
                              beatFlash
                                ? "bg-cyan-700 dark:bg-cyan-300 scale-125"
                                : "bg-cyan-600/40 dark:bg-cyan-500/40 scale-100"
                            }`}
                          />
                        )}
                      </span>
                      <span className="block text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 truncate">
                        {soundEnabled
                          ? "نغمة متزامنة مع النبضة"
                          : "الصوت مكتوم"}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={soundEnabled}
                    aria-label="التنبيه الصوتي للنبض"
                    dir="ltr"
                    onClick={handleToggleSound}
                    className={`w-10 h-5 rounded-full p-0.5 flex items-center transition-colors duration-200 shrink-0 cursor-pointer ${
                      soundEnabled
                        ? "bg-cyan-700 dark:bg-cyan-400 justify-end"
                        : "bg-slate-300 dark:bg-slate-700/80 justify-start"
                    }`}
                  >
                    <motion.span
                      layout
                      transition={{ type: "spring", stiffness: 450, damping: 30 }}
                      className="w-4 h-4 rounded-full bg-white shadow-sm"
                    />
                  </button>
                </div>

                <div className="py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                        hrvAlertsEnabled
                          ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "bg-slate-100 dark:bg-slate-800/80 text-slate-500"
                      }`}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </span>
                    <div className="min-w-0">
                      <span className="block text-xs font-semibold text-slate-900 dark:text-slate-200">
                        ملاحظات HRV المرئية
                      </span>
                      <span className="block text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 truncate">
                        تقييم الراحة والتوازن التنفسي
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={hrvAlertsEnabled}
                    aria-label="ملاحظات HRV المرئية"
                    dir="ltr"
                    onClick={() => setHrvAlertsEnabled((v) => !v)}
                    className={`w-10 h-5 rounded-full p-0.5 flex items-center transition-colors duration-200 shrink-0 cursor-pointer ${
                      hrvAlertsEnabled
                        ? "bg-emerald-600 dark:bg-emerald-500 justify-end"
                        : "bg-slate-300 dark:bg-slate-700/80 justify-start"
                    }`}
                  >
                    <motion.span
                      layout
                      transition={{ type: "spring", stiffness: 450, damping: 30 }}
                      className="w-4 h-4 rounded-full bg-white shadow-sm"
                    />
                  </button>
                </div>

                <div className="pt-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                        hydrationAlertsEnabled
                          ? "bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-400"
                          : "bg-slate-100 dark:bg-slate-800/80 text-slate-500"
                      }`}
                    >
                      <Droplets className="w-3.5 h-3.5" />
                    </span>
                    <div className="min-w-0">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-slate-200">
                        <span>تذكير شرب الماء الذكي</span>
                        <span
                          dir="ltr"
                          className="font-mono text-[10px] text-sky-700 dark:text-sky-300 tabular-nums font-semibold"
                        >
                          ({todayMeasurementsCount})
                        </span>
                      </span>
                      <span className="block text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 truncate">
                        حسب قياسات اليوم المسجلة
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={hydrationAlertsEnabled}
                    aria-label="تذكير شرب الماء الذكي"
                    dir="ltr"
                    onClick={() => setHydrationAlertsEnabled((v) => !v)}
                    className={`w-10 h-5 rounded-full p-0.5 flex items-center transition-colors duration-200 shrink-0 cursor-pointer ${
                      hydrationAlertsEnabled
                        ? "bg-sky-700 dark:bg-sky-400 justify-end"
                        : "bg-slate-300 dark:bg-slate-700/80 justify-start"
                    }`}
                  >
                    <motion.span
                      layout
                      transition={{ type: "spring", stiffness: 450, damping: 30 }}
                      className="w-4 h-4 rounded-full bg-white shadow-sm"
                    />
                  </button>
                </div>
              </div>

              {/* Live Diagnostics & Multi-ROI Fusion */}
              <div className="py-4 flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 bg-slate-100 dark:bg-[#080d16] border border-slate-200 dark:border-transparent rounded-lg p-3">
                  <div>
                    <span className="block text-[11px] text-slate-600 dark:text-slate-400">
                      تغطية البشرة
                    </span>
                    <span
                      dir="ltr"
                      className="block font-mono text-sm font-semibold text-slate-950 dark:text-white tabular-nums mt-0.5"
                    >
                      {metrics.skinCoveragePct}%
                    </span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-600 dark:text-slate-400">
                      معدل الإطارات
                    </span>
                    <span
                      dir="ltr"
                      className="block font-mono text-sm font-semibold text-slate-950 dark:text-white tabular-nums mt-0.5"
                    >
                      {metrics.fps} FPS
                    </span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-600 dark:text-slate-400">
                      السطوع / عزل اللمعان
                    </span>
                    <span
                      dir="ltr"
                      className="block font-mono text-sm font-semibold text-slate-950 dark:text-white tabular-nums mt-0.5"
                    >
                      {metrics.brightness} · {metrics.specularRejectedPct}%
                    </span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-600 dark:text-slate-400">
                      مؤشر الحركة
                    </span>
                    <span
                      dir="ltr"
                      className="block font-mono text-sm font-semibold text-slate-950 dark:text-white tabular-nums mt-0.5"
                    >
                      {metrics.motionIndex.toFixed(1)} ΔY
                    </span>
                  </div>
                </div>

                {mode !== "finger" && (
                  <div className="pt-1">
                    <div className="flex items-center justify-between text-[11px] font-semibold text-slate-800 dark:text-slate-300 mb-2">
                      <span>دمج المناطق (Multi-ROI SNR)</span>
                      <span dir="ltr" className="font-mono text-cyan-700 dark:text-cyan-400">
                        Live Weights
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {[
                        { label: "الجبهة", val: metrics.roiWeights.forehead },
                        { label: "الخد الأيسر", val: metrics.roiWeights.leftCheek },
                        { label: "الخد الأيمن", val: metrics.roiWeights.rightCheek },
                      ].map((reg) => (
                        <div
                          key={reg.label}
                          className="flex items-center gap-2 text-[11px]"
                        >
                          <span className="w-16 text-slate-600 dark:text-slate-400 shrink-0">
                            {reg.label}
                          </span>
                          <div
                            dir="ltr"
                            className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden"
                          >
                            <div
                              className="h-full w-full bg-cyan-700 dark:bg-cyan-400 origin-left transition-transform duration-200 will-change-transform"
                              style={{ transform: `scaleX(${Math.max(0, Math.min(1, reg.val / 100))})` }}
                            />
                          </div>
                          <span
                            dir="ltr"
                            className="w-8 text-left font-mono text-slate-800 dark:text-slate-200 tabular-nums shrink-0"
                          >
                            {reg.val}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="pt-4 flex flex-col gap-2">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.985 }}
                  onClick={isRunning ? stopAcquisition : startAcquisition}
                  className={`w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg transition-colors cursor-pointer ${
                    isRunning
                      ? "bg-rose-700 hover:bg-rose-800 dark:bg-rose-600 dark:hover:bg-rose-500 text-white"
                      : "bg-cyan-700 hover:bg-cyan-800 text-white dark:bg-cyan-400 dark:hover:bg-cyan-300 dark:text-slate-950"
                  }`}
                >
                  {isRunning ? (
                    <>
                      <Square className="w-4 h-4" />
                      <span>إيقاف الجلسة الحالية</span>
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4" />
                      <span>تشغيل الكاميرا وبدء الفحص</span>
                    </>
                  )}
                </motion.button>

                {isRunning && metrics.bpm !== null && (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.985 }}
                    onClick={() =>
                      recordSnapshot(
                        metrics,
                        mode,
                        algorithm,
                        Math.max(1, elapsedSec)
                      )
                    }
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-slate-900 dark:text-slate-200 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-300 dark:border-transparent rounded-lg transition-colors cursor-pointer"
                  >
                    <BookmarkPlus className="w-4 h-4" />
                    <span>حفظ لقطة القراءة الحالية في السجل</span>
                  </motion.button>
                )}
              </div>
            </motion.aside>

          {/* Right Main Telemetry & Optical Viewport (8 cols) */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-8 flex flex-col gap-5"
          >
            {/* 5-Card Interactive Biometric Telemetry Strip */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
              {/* Focal Primary Heart Rate Card (Kalman BPM) */}
              <button
                type="button"
                aria-pressed={selectedMetric === "bpm"}
                onClick={() =>
                  setSelectedMetric((prev) => (prev === "bpm" ? null : "bpm"))
                }
                className={`text-right bg-gradient-to-b from-cyan-50/90 to-white dark:from-cyan-950/30 dark:to-[#0c1322] border transition-all duration-200 rounded-xl p-4 cursor-pointer group ${
                  selectedMetric === "bpm"
                    ? "border-cyan-700 dark:border-cyan-400/70 ring-1 ring-cyan-600/40 dark:ring-cyan-400/40"
                    : "border-cyan-600/45 dark:border-cyan-500/35 hover:border-cyan-700/70 dark:hover:border-cyan-400/60"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 font-medium">
                  <span>نبض القلب</span>
                  <div className="flex items-center gap-1.5">
                    {isRunning && metrics.bpm !== null && !isPausedByZone && (
                      <motion.span
                        animate={{
                          scale: beatFlash ? 1.4 : 0.85,
                          opacity: beatFlash ? 1 : 0.35,
                        }}
                        transition={{ duration: 0.1 }}
                        className="inline-block w-2 h-2 rounded-full bg-cyan-700 dark:bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.85)]"
                      />
                    )}
                    <HeartPulse
                      className={`w-4 h-4 transition-transform duration-100 ${
                        beatFlash
                          ? "text-cyan-800 dark:text-cyan-300 scale-115"
                          : "text-cyan-700 dark:text-cyan-400 scale-100"
                      }`}
                    />
                  </div>
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-slate-950 dark:text-white tabular-nums tracking-tight">
                    {metrics.bpm !== null ? metrics.bpm : "--"}
                  </span>
                  <span className="font-mono text-[11px] text-cyan-800 dark:text-cyan-300/80 uppercase font-semibold">
                    BPM
                  </span>
                </div>
                <p
                  dir="ltr"
                  className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 font-mono tabular-nums group-hover:text-cyan-800 dark:group-hover:text-cyan-300/90 transition-colors"
                >
                  {metrics.rawFftBpm !== null
                    ? `Kalman · FFT ${metrics.rawFftBpm}`
                    : "5s buffer required"}
                </p>
              </button>

              {/* Respiration Rate Card */}
              <button
                type="button"
                aria-pressed={selectedMetric === "resp"}
                onClick={() =>
                  setSelectedMetric((prev) => (prev === "resp" ? null : "resp"))
                }
                className={`text-right bg-white dark:bg-[#0c1322] border transition-all duration-200 rounded-xl p-4 cursor-pointer group ${
                  selectedMetric === "resp"
                    ? "border-teal-700 dark:border-teal-400/70 ring-1 ring-teal-600/35 dark:ring-teal-400/35"
                    : "border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-medium">
                  <span>معدل التنفس</span>
                  <Wind className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-slate-950 dark:text-white tabular-nums">
                    {metrics.respirationBrpm !== null
                      ? metrics.respirationBrpm
                      : "--"}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-400 uppercase">
                    BrPM
                  </span>
                </div>
                <p
                  dir="ltr"
                  className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 font-mono tabular-nums group-hover:text-teal-800 dark:group-hover:text-teal-300/90 transition-colors"
                >
                  {metrics.respirationBrpm !== null
                    ? `SNR: ${metrics.respSnrDb.toFixed(1)} dB`
                    : `${Math.min(12, metrics.bufferSeconds).toFixed(0)}/12s buffer`}
                </p>
              </button>

              {/* Cardiorespiratory Coherence Card */}
              <button
                type="button"
                aria-pressed={selectedMetric === "coherence"}
                onClick={() =>
                  setSelectedMetric((prev) =>
                    prev === "coherence" ? null : "coherence"
                  )
                }
                className={`text-right bg-white dark:bg-[#0c1322] border transition-all duration-200 rounded-xl p-4 cursor-pointer group ${
                  selectedMetric === "coherence"
                    ? "border-emerald-700 dark:border-emerald-400/70 ring-1 ring-emerald-600/35 dark:ring-emerald-400/35"
                    : "border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-medium">
                  <span>التناغم القلبي</span>
                  <Sparkles className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-slate-950 dark:text-white tabular-nums">
                    {metrics.coherencePct !== null
                      ? metrics.coherencePct
                      : "--"}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-400 uppercase">
                    %
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 group-hover:text-emerald-800 dark:group-hover:text-emerald-300/90 transition-colors">
                  تزامن RSA والتنفس
                </p>
              </button>

              {/* Signal SNR + SQI Card */}
              <button
                type="button"
                aria-pressed={selectedMetric === "quality"}
                onClick={() =>
                  setSelectedMetric((prev) =>
                    prev === "quality" ? null : "quality"
                  )
                }
                className={`text-right bg-white dark:bg-[#0c1322] border transition-all duration-200 rounded-xl p-4 cursor-pointer group ${
                  selectedMetric === "quality"
                    ? "border-cyan-700 dark:border-cyan-400/70 ring-1 ring-cyan-600/35 dark:ring-cyan-400/35"
                    : "border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-medium">
                  <span>جودة الإشارة</span>
                  <div className="flex items-center gap-1.5">
                    {metrics.bufferSeconds >= 2 && metrics.sqiPct !== undefined && (
                      <span
                        dir="ltr"
                        className="font-mono text-[10px] text-emerald-700 dark:text-emerald-300 tabular-nums font-semibold"
                      >
                        SQI {metrics.sqiPct}%
                      </span>
                    )}
                    <Waves className="w-4 h-4 text-cyan-700 dark:text-cyan-400" />
                  </div>
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-slate-950 dark:text-white tabular-nums">
                    {metrics.bufferSeconds >= 2 ? metrics.snrDb.toFixed(1) : "--"}
                  </span>
                  <span className="font-mono text-xs text-slate-600 dark:text-slate-400 uppercase">
                    dB
                  </span>
                </div>
                <p className={`text-[11px] font-semibold mt-1 ${statusBadge.toneClass}`}>
                  {statusBadge.label}
                </p>
              </button>

              {/* Honest SpO2 Limitation Card */}
              <button
                type="button"
                aria-pressed={selectedMetric === "spo2"}
                onClick={() =>
                  setSelectedMetric((prev) => (prev === "spo2" ? null : "spo2"))
                }
                className={`text-right bg-white dark:bg-[#0c1322] border transition-all duration-200 rounded-xl p-4 col-span-2 md:col-span-1 cursor-pointer group ${
                  selectedMetric === "spo2"
                    ? "border-amber-600 dark:border-amber-400/70 ring-1 ring-amber-600/35 dark:ring-amber-400/35"
                    : "border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700"
                }`}
              >
                <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-medium">
                  <span>الأكسجين (SpO2)</span>
                  <ShieldAlert className="w-4 h-4 text-amber-700 dark:text-amber-400" />
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-xl font-bold text-slate-800 dark:text-slate-300">
                    N/A
                  </span>
                  <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400">
                    RGB Camera
                  </span>
                </div>
                <p className="text-[11px] text-amber-800 dark:text-amber-300 font-semibold mt-1 leading-snug group-hover:text-amber-900 dark:group-hover:text-amber-200 transition-colors">
                  يتطلب مستشعر 660/940nm
                </p>
              </button>
            </div>

            {/* Interactive Clinical Context Drawer for Selected Telemetry Card */}
            <AnimatePresence mode="wait">
              {selectedMetric && (
                <MetricInspectorDrawer
                  selected={selectedMetric}
                  metrics={metrics}
                  profile={profile}
                  onClose={() => setSelectedMetric(null)}
                  onFocusTab={handleInspectorFocusTab}
                  onOpenPacer={() => setPacerOpen(true)}
                />
              )}
            </AnimatePresence>

            {/* Smart Alerts Grid (Side-by-Side on wide viewports to preserve optical viewport above fold) */}
            {(hrvAlertsEnabled || hydrationAlertsEnabled) && (
              <div
                className={`grid grid-cols-1 gap-4 ${
                  hrvAlertsEnabled && hydrationAlertsEnabled ? "xl:grid-cols-2" : ""
                }`}
              >
                {hrvAlertsEnabled && <HrvAlertBanner alert={hrvSmartAlert} />}
                {hydrationAlertsEnabled && (
                  <HydrationAlertCard
                    alert={hydrationAlert}
                    onAcknowledgeDrink={handleAcknowledgeDrink}
                    onSnooze={handleSnoozeHydration}
                  />
                )}
              </div>
            )}

            <AnimatePresence>
              {cameraError && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  role="alert"
                  className="bg-rose-50 dark:bg-rose-950/60 border border-rose-400 dark:border-rose-800 rounded-xl p-4 flex items-start gap-3 text-sm text-rose-900 dark:text-rose-200"
                >
                  <AlertTriangle className="w-5 h-5 text-rose-700 dark:text-rose-400 shrink-0 mt-0.5" />
                  <p className="text-xs leading-relaxed">{cameraError}</p>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {saveNotice && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-400 dark:border-emerald-800 rounded-xl px-4 py-2.5 flex items-center justify-between text-xs font-medium text-emerald-950 dark:text-emerald-200"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                    <span>{saveNotice}</span>
                  </span>
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => setReportOpen(true)}
                      className="underline font-semibold text-cyan-800 dark:text-cyan-300 cursor-pointer"
                    >
                      عرض التقرير
                    </button>
                    <a href="#history" className="underline font-semibold">
                      السجل
                    </a>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Interactive 0.1 Hz Resonant Breathing Biofeedback Pacer */}
            <AnimatePresence>
              {pacerOpen && (
                <BreathingPacer onClose={() => setPacerOpen(false)} />
              )}
            </AnimatePresence>

            {/* Live Optical Camera & Dynamic Centroid HUD */}
            <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-200">
                  <span>
                    {mode === "finger"
                      ? "عدسة الاتصال بالإصبع (Contact PPG)"
                      : "منظور تتبع الوجه الديناميكي + مستشعرات الوميض الخلفي"}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={pacerOpen}
                    onClick={() => setPacerOpen((v) => !v)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer transition-colors ${
                      pacerOpen
                        ? "bg-teal-50 dark:bg-teal-500/15 border-teal-600/50 dark:border-teal-400/50 text-teal-800 dark:text-teal-300"
                        : "bg-slate-100 dark:bg-slate-900/90 border-slate-300 dark:border-slate-700/80 text-slate-700 dark:text-slate-300 hover:border-slate-400 dark:hover:border-slate-600"
                    }`}
                  >
                    <Wind className="w-3.5 h-3.5" />
                    <span>موجّه التنفس</span>
                  </button>

                  {mode !== "finger" && (
                    <button
                      type="button"
                      aria-pressed={showRoiOverlay}
                      onClick={() => setShowRoiOverlay((v) => !v)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer transition-colors ${
                        showRoiOverlay
                          ? "bg-cyan-50 dark:bg-cyan-500/10 border-cyan-600/45 dark:border-cyan-500/40 text-cyan-800 dark:text-cyan-300"
                          : "bg-slate-100 dark:bg-slate-900/90 border-slate-300 dark:border-slate-700/80 text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200"
                      }`}
                    >
                      {showRoiOverlay ? (
                        <Eye className="w-3.5 h-3.5" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5" />
                      )}
                      <span>مربعات التتبع</span>
                    </button>
                  )}

                  {torchSupported && mode === "finger" && isRunning && (
                    <button
                      type="button"
                      onClick={() => toggleTorch(!torchEnabled)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer transition-colors ${
                        torchEnabled
                          ? "bg-amber-50 dark:bg-amber-500/20 border-amber-500 dark:border-amber-500/40 text-amber-900 dark:text-amber-300"
                          : "bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-300"
                      }`}
                    >
                      <Flashlight className="w-3.5 h-3.5" />
                      <span>{torchEnabled ? "إيقاف الفلاش" : "تشغيل الفلاش"}</span>
                    </button>
                  )}

                  <span
                    dir="ltr"
                    className="font-mono text-xs text-cyan-800 dark:text-cyan-300 tabular-nums ps-1 font-semibold"
                  >
                    {scanDuration > 0
                      ? `${Math.min(scanDuration, elapsedSec).toFixed(1)}s / ${scanDuration}s`
                      : `Buffer: ${metrics.bufferSeconds.toFixed(1)}s`}
                  </span>
                </div>
              </div>

              <canvas
                ref={analysisCanvasRef}
                width={240}
                height={180}
                className="hidden"
              />

              <div className="relative w-full aspect-video max-h-[380px] bg-[#04070c] rounded-lg overflow-hidden border border-slate-800 flex items-center justify-center">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${
                    mode === "face" ? "-scale-x-100" : ""
                  }`}
                />

                {/* Subtle Optical Scanline Sweep during active scan */}
                {isRunning && !isPausedByZone && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-transparent via-cyan-400/12 to-transparent animate-optical-sweep"
                  />
                )}

                {/* Auto-Tracking Moving Face Zone & Dynamic ROI HUD */}
                {mode !== "finger" &&
                  (() => {
                    const useLiveZone =
                      isRunning && mode === "face" && !isPausedByZone;
                    const zCx = useLiveZone ? (1 - faceBox.cx) * 100 : 50;
                    const zCy = useLiveZone ? faceBox.cy * 100 : 46;
                    const zRx = useLiveZone
                      ? Math.max(13, Math.min(36, faceBox.rx * 112))
                      : 21;
                    const zRy = useLiveZone
                      ? Math.max(19, Math.min(44, faceBox.ry * 112))
                      : 32;
                    const bx0 = Math.max(2, zCx - zRx - 2.5);
                    const bx1 = Math.min(98, zCx + zRx + 2.5);
                    const by0 = Math.max(2, zCy - zRy - 2);
                    const by1 = Math.min(98, zCy + zRy + 2);
                    const arm = 5.5;
                    const zoneStroke = !isRunning
                      ? "#475569"
                      : isPausedByZone
                      ? "#f59e0b"
                      : metrics.signalState === "nominal"
                      ? "#10b981"
                      : "#06b6d4";

                    return (
                      <svg
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        className="pointer-events-none absolute inset-0 w-full h-full"
                      >
                        {/* Dynamic Moving Corner Targeting Brackets Locked Around Face */}
                        <path
                          d={`M ${bx0} ${by0 + arm} L ${bx0} ${by0} L ${bx0 + arm} ${by0} M ${bx1 - arm} ${by0} L ${bx1} ${by0} L ${bx1} ${by0 + arm} M ${bx0} ${by1 - arm} L ${bx0} ${by1} L ${bx0 + arm} ${by1} M ${bx1 - arm} ${by1} L ${bx1} ${by1} L ${bx1} ${by1 - arm}`}
                          fill="none"
                          stroke={zoneStroke}
                          strokeWidth="0.75"
                        />

                        {/* Auto-Moving Face Alignment Zone */}
                        <ellipse
                          cx={zCx}
                          cy={zCy}
                          rx={zRx}
                          ry={zRy}
                          fill={
                            isRunning && isPausedByZone
                              ? "rgba(245, 158, 11, 0.06)"
                              : isRunning && metrics.signalState === "nominal"
                              ? "rgba(16, 185, 129, 0.05)"
                              : isRunning
                              ? "rgba(6, 182, 212, 0.04)"
                              : "none"
                          }
                          stroke={zoneStroke}
                          strokeWidth={isRunning && !isPausedByZone ? "0.7" : "0.55"}
                          strokeDasharray={
                            isRunning &&
                            metrics.signalState === "nominal" &&
                            !isPausedByZone
                              ? undefined
                              : "2 1.5"
                          }
                        />

                        {/* Inner Face Contour Ring (rotates subtly with ocular head-tilt) */}
                        {useLiveZone && (
                          <ellipse
                            cx={(1 - faceBox.cx) * 100}
                            cy={faceBox.cy * 100}
                            rx={faceBox.rx * 100}
                            ry={faceBox.ry * 100}
                            transform={
                              faceBox.headTiltDeg
                                ? `rotate(${-faceBox.headTiltDeg} ${(1 - faceBox.cx) * 100} ${faceBox.cy * 100})`
                                : undefined
                            }
                            fill="none"
                            stroke="rgba(34, 211, 238, 0.45)"
                            strokeWidth="0.35"
                            strokeDasharray="1 1"
                          />
                        )}

                        {/* Dynamic Forehead, Cheeks & Ambient Ref ROIs */}
                        {showRoiOverlay &&
                          isRunning &&
                          !isPausedByZone &&
                          roiBoxes.map((box) => {
                            const mirroredX =
                              mode === "face"
                                ? (1 - box.x - box.w) * 100
                                : box.x * 100;
                            const isBg = box.kind === "background";
                            return (
                              <g key={box.label}>
                                <rect
                                  x={mirroredX}
                                  y={box.y * 100}
                                  width={box.w * 100}
                                  height={box.h * 100}
                                  fill={
                                    isBg
                                      ? "rgba(148, 163, 184, 0.08)"
                                      : "rgba(6, 182, 212, 0.14)"
                                  }
                                  stroke={isBg ? "#64748b" : "#22d3ee"}
                                  strokeWidth="0.45"
                                  strokeDasharray={isBg ? "1.5 1" : undefined}
                                />
                              </g>
                            );
                          })}
                      </svg>
                    );
                  })()}

                {/* Zone Status Chip (Top-Right inside HUD) */}
                {isRunning && (
                  <div className="pointer-events-none absolute top-3 right-3 z-10 flex items-center gap-2 max-w-[54%] sm:max-w-none">
                    <span
                      className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border backdrop-blur-sm truncate ${
                        isPausedByZone
                          ? "bg-amber-950/85 border-amber-500/50 text-amber-300"
                          : "bg-slate-950/80 border-emerald-500/40 text-emerald-300"
                      }`}
                    >
                      {isPausedByZone
                        ? "⏸ متوقف مؤقتاً · بانتظار ظهور الوجه"
                        : mode === "face"
                        ? `● تتبع الوجه مقفل · تغطية ${metrics.skinCoveragePct}%`
                        : "● الإصبع مثبت على العدسة"}
                    </span>
                  </div>
                )}

                {/* Real-Time rPPG Confidence Circular Gauge (Top-Left inside HUD) */}
                <AnimatePresence>
                  {isRunning && (
                    <SignalConfidenceGauge
                      key="confidence-gauge"
                      className="absolute top-3 left-3 z-10"
                      confidence={metrics.confidence}
                      signalState={metrics.signalState}
                      isPausedByZone={isPausedByZone}
                      bufferSeconds={metrics.bufferSeconds}
                    />
                  )}
                </AnimatePresence>

                {/* Translucent Pause Banner when user temporarily leaves the frame */}
                <AnimatePresence>
                  {isRunning && isPausedByZone && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                      transition={{ duration: 0.18 }}
                      className="pointer-events-none absolute inset-x-4 bottom-3 flex justify-center"
                    >
                      <div className="bg-slate-950/90 border border-amber-500/50 rounded-lg px-4 py-2.5 text-center shadow-lg max-w-md">
                        <p className="text-xs font-bold text-amber-300">
                          تم إيقاف المؤقت والبيانات مؤقتاً لحين عودتك
                        </p>
                        <p className="text-[11px] text-slate-200 mt-0.5">
                          {getZoneGuidanceText(zoneGuidance, mode)}
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {mode === "finger" && isRunning && !isPausedByZone && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="w-32 h-32 rounded-2xl border-2 border-dashed border-cyan-400 flex items-end justify-center p-2">
                      <span className="text-[11px] font-medium text-white bg-slate-900/80 px-2 py-0.5 rounded">
                        غطِّ العدسة بإصبعك بلطف
                      </span>
                    </div>
                  </div>
                )}

                {/* Live Optical Telemetry Contrast Scrim (Bottom inside Viewfinder) */}
                {isRunning && !isPausedByZone && (
                  <div
                    dir="ltr"
                    className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pt-6 pb-2.5 bg-gradient-to-t from-[#04070c]/90 via-[#04070c]/40 to-transparent flex items-center justify-between text-[11px] font-mono text-slate-300 tabular-nums"
                  >
                    <span>
                      {metrics.fps || 30} FPS · SNR{" "}
                      {metrics.bufferSeconds >= 2 ? metrics.snrDb.toFixed(1) : "--"} dB
                      {metrics.sqiPct !== undefined && metrics.bufferSeconds >= 2
                        ? ` · SQI ${metrics.sqiPct}%`
                        : ""}
                    </span>
                    {mode === "face" && faceBox.headTiltDeg !== undefined && (
                      <span>Tilt {faceBox.headTiltDeg.toFixed(1)}°</span>
                    )}
                  </div>
                )}

                {!isRunning && (
                  <div className="absolute inset-0 bg-[#04070c]/90 flex flex-col items-center justify-center gap-3.5 p-6 text-center">
                    <div className="relative w-14 h-14 flex items-center justify-center">
                      <svg
                        viewBox="0 0 64 64"
                        className="absolute inset-0 w-full h-full text-cyan-500/40"
                        aria-hidden="true"
                      >
                        <circle
                          cx="32"
                          cy="32"
                          r="29"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1"
                          strokeDasharray="4 4"
                        />
                        <circle
                          cx="32"
                          cy="32"
                          r="22"
                          fill="none"
                          stroke="currentColor"
                          strokeOpacity="0.45"
                          strokeWidth="0.8"
                        />
                      </svg>
                      <Camera className="w-6 h-6 text-cyan-400" />
                    </div>
                    <p className="text-sm font-semibold text-white text-balance max-w-md">
                      {mode === "face"
                        ? "يتحرك الإطار تلقائياً لتتبع وجهك أينما كنت في الكادر"
                        : "ضع طرف إصبعك برفق على الكاميرا الخلفية"}
                    </p>
                    <p className="text-xs text-slate-400 max-w-md leading-relaxed">
                      يتم قفل منطقة القياس على وجهك ديناميكياً وطرح وميض الإضاءة
                      الخلفي عبر NLMS محلياً على جهازك دون إرسال أي بيانات.
                    </p>
                  </div>
                )}
              </div>

              {scanDuration > 0 && (
                <div
                  dir="ltr"
                  className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden"
                >
                  <div
                    className="h-full w-full bg-cyan-700 dark:bg-cyan-400 origin-left transition-transform duration-200 will-change-transform"
                    style={{ transform: `scaleX(${Math.max(0, Math.min(1, progressPct / 100))})` }}
                  />
                </div>
              )}
            </div>

            {/* Organized Analytics Workspace Controls */}
            <div
              id="analytics-workspace"
              className="flex flex-wrap items-center justify-between gap-3 pt-1"
            >
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-cyan-700 dark:text-cyan-400" />
                <h2 className="text-sm font-bold text-slate-950 dark:text-white tracking-tight">
                  التحليل الطيفي والتوازن العصبي
                </h2>
              </div>

              <div
                role="tablist"
                aria-label="تصفية الرسوم البيانية"
                className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 rounded-lg"
              >
                {(
                  [
                    { id: "all", label: "عرض شامل" },
                    { id: "signals", label: "الموجة والطيف" },
                    { id: "autonomic", label: "التوازن العصبي والتنفس" },
                    { id: "trends", label: "الاتجاهات الزمنية" },
                    { id: "weekly", label: "المتوسطات الأسبوعية" },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={analyticsTab === tab.id}
                    onClick={() => setAnalyticsTab(tab.id)}
                    className={`relative px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      analyticsTab === tab.id
                        ? "text-cyan-800 dark:text-cyan-300 font-semibold"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200"
                    }`}
                  >
                    {analyticsTab === tab.id && (
                      <motion.span
                        layoutId="analytics-tab-active"
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        className="absolute inset-0 bg-white dark:bg-slate-800 border border-slate-300/80 dark:border-transparent rounded-md shadow-xs dark:shadow-none"
                      />
                    )}
                    <span className="relative z-10">{tab.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Analytics Views with Smooth Tab Transitions */}
            <AnimatePresence mode="wait">
              <motion.div
                key={analyticsTab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="flex flex-col gap-5"
              >
                {(analyticsTab === "all" || analyticsTab === "signals") && (
                  <div
                    id="waveforms"
                    className="grid grid-cols-1 xl:grid-cols-2 gap-5"
                  >
                    <WaveformChart
                      waveform={metrics.waveform}
                      peakIndices={metrics.peakIndices}
                      fps={metrics.fps}
                    />
                    <SpectrumChart
                      spectrum={metrics.spectrum}
                      dominantFreqHz={metrics.dominantFreqHz}
                      bpm={metrics.bpm}
                    />
                  </div>
                )}

                {(analyticsTab === "all" || analyticsTab === "autonomic") && (
                  <div
                    id="autonomic"
                    className="grid grid-cols-1 xl:grid-cols-2 gap-5"
                  >
                    <PoincarePlot
                      points={metrics.poincarePoints}
                      sd1Ms={metrics.sd1Ms}
                      sd2Ms={metrics.sd2Ms}
                      coherencePct={metrics.coherencePct}
                    />
                    <RespirationChart
                      respWaveform={metrics.respWaveform}
                      respPeakIndices={metrics.respPeakIndices}
                      respirationBrpm={metrics.respirationBrpm}
                      respFreqHz={metrics.respFreqHz}
                      respSnrDb={metrics.respSnrDb}
                      bufferSeconds={metrics.bufferSeconds}
                    />
                  </div>
                )}

                {(analyticsTab === "all" || analyticsTab === "trends") && (
                  <HrvTrendsChart readings={readings} profile={profile} />
                )}

                {(analyticsTab === "all" || analyticsTab === "weekly") && (
                  <WeeklyAveragesPanel readings={readings} />
                )}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </section>

        {/* Session Readings Log */}
        <SessionLogTable
          readings={readings}
          onExportCsv={handleExportCsv}
          onClear={() => {
            setReadings([]);
            setHydrationState((prev) => ({
              ...prev,
              dateKey: getLocalDateKey(),
              lastAckMeasurements: 0,
              snoozedUntilMeasurements: 0,
            }));
          }}
        />

        {/* Scientific Innovations & Optical Physics Section */}
        <section
          id="science"
          className="max-w-7xl mx-auto px-6 py-14 border-t border-slate-300 dark:border-slate-800/80"
        >
          <div className="mb-8 max-w-2xl">
            <h2 className="text-xl font-bold text-slate-950 dark:text-white tracking-tight text-balance">
              المنهجية الهندسية والابتكارات المطبقة لرفع الدقة
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">
              كيف يتغلب هذا النظام على ضوضاء الإضاءة المنزلية والحركة، ولماذا يظل
              صادقاً علمياً حول حدود SpO2
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                num: "01",
                title: "تصحيح توازن اللون الأبيض + NLMS",
                body: "يعادل توازن اللون الأبيض التكيفي (Von Kries AWB) انحراف حرارة اللون تحت الإضاءة المتغيرة قبل طرح وميض المصابيح والشاشات عبر مرشح NLMS.",
              },
              {
                num: "02",
                title: "تتبع ديناميكي + دمج Multi-ROI",
                body: "تتحرك مربعات الجبهة والخدين مع مركز ثقل البشرة، مع عزل بكسلات اللمعان السطحي ودمج المناطق الثلاث بأوزان SoftMax حسب جودة الطيف.",
              },
              {
                num: "03",
                title: "مرشح كالمان + مخطط بوانكاريه",
                body: "يثبت مرشح كالمان قراءة BPM ضد القفزات المفاجئة، بينما يقيس مخطط Poincaré (SD1/SD2) وتناغم RSA التوازن بين العصب الحائر والتنفس.",
              },
              {
                num: "04",
                title: "حدود قياس الأكسجين (SpO2)",
                body: "أجهزة SpO2 الطبية تحتاج طولين موجيين (660 nm و940 nm)، بينما تحجب كاميرات الهواتف الأشعة تحت الحمراء بفلتر IR-Cut؛ لذا لا نصدر أرقام SpO2 وهمية.",
              },
            ].map((item) => (
              <div
                key={item.num}
                className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700/90 transition-colors duration-200 rounded-xl p-5"
              >
                <span dir="ltr" className="block font-mono text-xs font-bold text-cyan-700 dark:text-cyan-400 mb-2">
                  {item.num}
                </span>
                <h3 className="text-sm font-bold text-slate-950 dark:text-white">{item.title}</h3>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-2 leading-relaxed">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Tamayyuz (Distinction, Achievements & Simple How-It-Works) Section */}
        <section
          id="distinction"
          className="max-w-7xl mx-auto px-6 py-14 border-t border-slate-300 dark:border-slate-800/80"
        >
          <div className="mb-8 max-w-2xl">
            <h2 className="text-xl font-bold text-slate-950 dark:text-white tracking-tight text-balance">
              تميّز — بماذا نختلف؟ وماذا أنجزنا؟ وكيف يعمل النظام ببساطة؟
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed">
              شرح مبسّط وواضح لفكرة المشروع، وقيمته الهندسية، ورحلة الإشارة من
              عدسة الكاميرا حتى القراءة النهائية
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
            {/* Column 1: What Makes This Project Stand Out */}
            <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700 transition-colors duration-200 rounded-xl p-6 flex flex-col gap-4">
              <div>
                <span className="text-xs font-semibold text-cyan-700 dark:text-cyan-400">
                  01 · التفوق الهندسي
                </span>
                <h3 className="text-base font-bold text-slate-950 dark:text-white mt-1">
                  بماذا يتميّز هذا النظام عن الحلول التقليدية؟
                </h3>
              </div>

              <ul className="space-y-3 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-slate-950 dark:text-white">مقاومة إضاءة الغرفة والحركة:</strong>{" "}
                    معظم الأدوات البسيطة تتعطل عند تغيّر الإضاءة أو وميض الشاشات،
                    بينما يدمج نظامنا موازنة اللون الأبيض (<span dir="ltr" className="font-mono text-cyan-800 dark:text-cyan-300 font-semibold">AWB</span>)
                    وإلغاء الوميض (<span dir="ltr" className="font-mono text-cyan-800 dark:text-cyan-300 font-semibold">NLMS</span>)
                    ومرشح كالمان للحفاظ على ثبات القراءة.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-slate-950 dark:text-white">خصوصية 100% محلياً:</strong>{" "}
                    جميع الحسابات ومعالجة البكسلات تتم بالكامل داخل متصفح جهازك دون
                    رفع أي صورة أو فيديو لأي خادم خارجي.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-slate-950 dark:text-white">شفافية ومصداقية علمية:</strong>{" "}
                    لا يعرض أرقام <span dir="ltr" className="font-mono">SpO2</span>{" "}
                    تخمينية غير حقيقية، بل يركّز على ما تستطيع كاميرا RGB قياسه فعلياً
                    بدقة (النبض، التنفس، HRV، والتناغم العصبي).
                  </span>
                </li>
              </ul>
            </div>

            {/* Column 2: What Was Built in This Project */}
            <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700 transition-colors duration-200 rounded-xl p-6 flex flex-col gap-4">
              <div>
                <span className="text-xs font-semibold text-teal-700 dark:text-teal-400">
                  02 · البنية التقنية
                </span>
                <h3 className="text-base font-bold text-slate-950 dark:text-white mt-1">
                  ماذا بنينا وأنجزنا داخل هذا المشروع؟
                </h3>
              </div>

              <ul className="space-y-3 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                <li className="flex items-start gap-2.5">
                  <Sparkles className="w-4 h-4 text-cyan-700 dark:text-cyan-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-slate-950 dark:text-white">محرك معالجة إشارات حي (30 Hz DSP):</strong>{" "}
                    مبني من الصفر بلغة TypeScript لدعم الدمج الرباعي{" "}
                    <span dir="ltr" className="font-mono text-cyan-800 dark:text-cyan-300 font-semibold">POS / CHROM / ICA / GREEN</span>{" "}
                    مع تحويل طيفي <span dir="ltr" className="font-mono">1024-pt FFT</span>{" "}
                    وتتبّع ديناميكي للجبهة والخدين.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Sparkles className="w-4 h-4 text-cyan-700 dark:text-cyan-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-slate-950 dark:text-white">قياس متكامل للقلب والتنفس والأعصاب:</strong>{" "}
                    استخراج معدل التنفس عبر التعديل الثلاثي، وحساب التوازن الباراسمبثاوي
                    بمخطط بوانكاريه (<span dir="ltr" className="font-mono">SD1 / SD2</span>)
                    ونسبة تناغم القلب مع التنفس.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Sparkles className="w-4 h-4 text-cyan-700 dark:text-cyan-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-slate-950 dark:text-white">واجهة قياس وتوثيق احترافية:</strong>{" "}
                    راسم ذبذبات حي، وسجل جلسات قابل للتصدير بصيغة{" "}
                    <span dir="ltr" className="font-mono">CSV</span>، مع تقرير فني جاهز
                    للطباعة والحفظ كـ <span dir="ltr" className="font-mono">PDF</span>.
                  </span>
                </li>
              </ul>
            </div>
          </div>

          {/* Interactive 4-Stage DSP Pipeline Explorer */}
          <InteractivePipeline />
        </section>
      </main>

      <footer className="border-t border-slate-300 dark:border-slate-800/90 bg-white dark:bg-[#060911] no-print">
        <div className="max-w-7xl mx-auto px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
          <span>PulseLab Pro · محطة قياس النبض والتنفس البصري</span>
          <span>معالجة محلية بالكامل داخل المتصفح · للاستخدام البحثي والتعليمي</span>
        </div>
      </footer>

      <SessionReportModal
        isOpen={reportOpen}
        onClose={() => setReportOpen(false)}
        metrics={metrics}
        readings={readings}
        profile={profile}
        mode={mode}
        algorithm={algorithm}
        nlmsEnabled={nlmsEnabled}
        awbEnabled={awbEnabled}
        durationSec={elapsedSec || metrics.bufferSeconds}
      />
      </div>
    </MotionConfig>
  );
}
