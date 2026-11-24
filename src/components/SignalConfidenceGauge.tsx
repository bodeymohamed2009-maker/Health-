import { motion } from "motion/react";
import type { SignalQualityState } from "../types/rppg";

interface SignalConfidenceGaugeProps {
  confidence: number;
  signalState: SignalQualityState;
  isPausedByZone: boolean;
  bufferSeconds: number;
  className?: string;
}

interface ConfidenceFeedback {
  stroke: string;
  trackGlow: string;
  borderClass: string;
  textClass: string;
  title: string;
  hint: string;
}

function getConfidenceFeedback(
  confidence: number,
  signalState: SignalQualityState,
  isPausedByZone: boolean,
  bufferSeconds: number
): ConfidenceFeedback {
  if (isPausedByZone || signalState === "paused") {
    return {
      stroke: "#f59e0b",
      trackGlow: "rgba(245, 158, 11, 0.25)",
      borderClass: "border-amber-500/45",
      textClass: "text-amber-300",
      title: "توقف مؤقت",
      hint: "أعد الوجه داخل الإطار",
    };
  }

  if (signalState === "no_skin") {
    return {
      stroke: "#f43f5e",
      trackGlow: "rgba(244, 63, 94, 0.28)",
      borderClass: "border-rose-500/45",
      textClass: "text-rose-300",
      title: "لا توجد إشارة",
      hint: "وجّه العدسة نحو البشرة",
    };
  }

  if (signalState === "low_light") {
    return {
      stroke: "#f59e0b",
      trackGlow: "rgba(245, 158, 11, 0.25)",
      borderClass: "border-amber-500/45",
      textClass: "text-amber-300",
      title: "إضاءة ضعيفة",
      hint: "ارفع الإضاءة الأمامية",
    };
  }

  if (signalState === "calibrating" || bufferSeconds < 5) {
    return {
      stroke: "#22d3ee",
      trackGlow: "rgba(34, 211, 238, 0.25)",
      borderClass: "border-cyan-500/40",
      textClass: "text-cyan-300",
      title: "جارٍ المعايرة",
      hint: "ثبّت الجلسة لـ 5 ثوانٍ",
    };
  }

  if (confidence >= 75) {
    return {
      stroke: "#10b981",
      trackGlow: "rgba(16, 185, 129, 0.28)",
      borderClass: "border-emerald-500/45",
      textClass: "text-emerald-300",
      title: "ثبات ممتاز",
      hint: "القراءة موثوقة للتحليل",
    };
  }

  if (confidence >= 45) {
    return {
      stroke: "#22d3ee",
      trackGlow: "rgba(34, 211, 238, 0.25)",
      borderClass: "border-cyan-500/40",
      textClass: "text-cyan-300",
      title: "ثبات جيد",
      hint: "حافظ على هدوء الرأس",
    };
  }

  return {
    stroke: "#f59e0b",
    trackGlow: "rgba(245, 158, 11, 0.25)",
    borderClass: "border-amber-500/45",
    textClass: "text-amber-300",
    title: signalState === "motion" ? "تشويش حركة" : "ثبات منخفض",
    hint: "قلّل الحركة وحسّن الإضاءة",
  };
}

export function SignalConfidenceGauge({
  confidence,
  signalState,
  isPausedByZone,
  bufferSeconds,
  className = "",
}: SignalConfidenceGaugeProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(confidence)));
  const radius = 21;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped / 100);
  const feedback = getConfidenceFeedback(
    clamped,
    signalState,
    isPausedByZone,
    bufferSeconds
  );

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      role="status"
      aria-live="polite"
      aria-label={`مؤشر ثبات وجودة الإشارة ${clamped}% — ${feedback.title}`}
      className={`pointer-events-none bg-[#060911]/85 backdrop-blur-md border ${feedback.borderClass} rounded-xl px-2.5 py-2 sm:px-3 sm:py-2.5 flex items-center gap-2.5 shadow-lg ${className}`}
    >
      {/* Circular SVG Radial Gauge */}
      <div className="relative w-12 h-12 sm:w-13 sm:h-13 shrink-0 flex items-center justify-center">
        <svg
          viewBox="0 0 54 54"
          className="w-full h-full -rotate-90"
          aria-hidden="true"
        >
          {/* Calibrated Inner Reference Ring */}
          <circle
            cx="27"
            cy="27"
            r="16.5"
            fill="none"
            stroke="rgba(148, 163, 184, 0.14)"
            strokeWidth="0.75"
            strokeDasharray="2 2.5"
          />
          {/* Track Ring */}
          <circle
            cx="27"
            cy="27"
            r={radius}
            fill="none"
            stroke="rgba(30, 41, 59, 0.9)"
            strokeWidth="4.2"
          />
          {/* Real-Time Confidence Arc */}
          <circle
            cx="27"
            cy="27"
            r={radius}
            fill="none"
            stroke={feedback.stroke}
            strokeWidth="4.2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{
              transition:
                "stroke-dashoffset 240ms cubic-bezier(0.16, 1, 0.3, 1), stroke 220ms ease",
              filter: `drop-shadow(0 0 5px ${feedback.trackGlow})`,
            }}
          />
        </svg>
        <span
          dir="ltr"
          className="absolute font-mono text-[11px] font-bold text-white tabular-nums tracking-tight"
        >
          {clamped}%
        </span>
      </div>

      {/* Live Stability Text Readout */}
      <div className="min-w-0">
        <span className="hidden sm:block text-[10px] font-medium text-slate-400 leading-none">
          ثبات الإشارة (rPPG)
        </span>
        <span
          className={`block text-xs font-bold leading-tight sm:mt-1 ${feedback.textClass}`}
        >
          {feedback.title}
        </span>
        <span className="hidden sm:block text-[10px] text-slate-300 mt-0.5 leading-snug max-w-[140px]">
          {feedback.hint}
        </span>
      </div>
    </motion.div>
  );
}
