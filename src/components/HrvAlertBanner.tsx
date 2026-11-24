import { motion } from "motion/react";
import { Activity, AlertTriangle, CheckCircle2, Sparkles, Wind } from "lucide-react";
import type { HrvFeedbackTone, HrvSmartAlert } from "../dsp/hrvInsights";

interface HrvAlertBannerProps {
  alert: HrvSmartAlert;
}

const TONE_STYLES: Record<
  HrvFeedbackTone,
  {
    container: string;
    iconBox: string;
    labelTone: string;
    headline: string;
  }
> = {
  optimal: {
    container:
      "bg-emerald-50 dark:bg-emerald-950/25 border-emerald-400/80 dark:border-emerald-500/35",
    iconBox:
      "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30",
    labelTone: "text-emerald-800 dark:text-emerald-300",
    headline: "text-emerald-950 dark:text-emerald-100",
  },
  good: {
    container:
      "bg-cyan-50 dark:bg-cyan-950/25 border-cyan-400/80 dark:border-cyan-500/35",
    iconBox:
      "bg-cyan-100 dark:bg-cyan-500/15 text-cyan-800 dark:text-cyan-300 border-cyan-300 dark:border-cyan-500/30",
    labelTone: "text-cyan-800 dark:text-cyan-300",
    headline: "text-cyan-950 dark:text-cyan-50",
  },
  respiratory: {
    container:
      "bg-sky-50 dark:bg-sky-950/25 border-sky-400/80 dark:border-sky-500/35",
    iconBox:
      "bg-sky-100 dark:bg-sky-500/15 text-sky-800 dark:text-sky-300 border-sky-300 dark:border-sky-500/30",
    labelTone: "text-sky-800 dark:text-sky-300",
    headline: "text-sky-950 dark:text-sky-100",
  },
  caution: {
    container:
      "bg-amber-50 dark:bg-amber-950/25 border-amber-400/90 dark:border-amber-500/40",
    iconBox:
      "bg-amber-100 dark:bg-amber-500/15 text-amber-900 dark:text-amber-300 border-amber-300 dark:border-amber-500/30",
    labelTone: "text-amber-800 dark:text-amber-300",
    headline: "text-amber-950 dark:text-amber-100",
  },
  pending: {
    container:
      "bg-white dark:bg-[#0c1322] border-slate-300 dark:border-slate-800/90",
    iconBox:
      "bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700",
    labelTone: "text-slate-600 dark:text-slate-400",
    headline: "text-slate-950 dark:text-slate-100",
  },
};

function renderToneIcon(tone: HrvFeedbackTone) {
  switch (tone) {
    case "optimal":
      return <Sparkles className="w-4 h-4" />;
    case "good":
      return <CheckCircle2 className="w-4 h-4" />;
    case "respiratory":
      return <Wind className="w-4 h-4" />;
    case "caution":
      return <AlertTriangle className="w-4 h-4" />;
    default:
      return <Activity className="w-4 h-4" />;
  }
}

export function HrvAlertBanner({ alert }: HrvAlertBannerProps) {
  const styles = TONE_STYLES[alert.tone];

  return (
    <motion.div
      key={alert.id}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      role="status"
      aria-live="polite"
      className={`rounded-xl border p-4 flex flex-col justify-between gap-3 transition-colors duration-200 ${styles.container}`}
    >
      <div className="flex items-start gap-3 min-w-0">
        <div
          className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 mt-0.5 ${styles.iconBox}`}
        >
          {renderToneIcon(alert.tone)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-400">
            <span>تقييم HRV الذكي</span>
            <span aria-hidden="true">·</span>
            <span className={`font-semibold ${styles.labelTone}`}>
              {alert.badgeLabel}
            </span>
            {alert.ageCalibrated && (
              <>
                <span aria-hidden="true">·</span>
                <span>مُعايَر عمرّياً</span>
              </>
            )}
          </div>

          <p className={`text-sm font-bold mt-1 leading-snug ${styles.headline}`}>
            {alert.headline}
          </p>
          <p className="text-xs text-slate-700 dark:text-slate-300/90 mt-1 leading-relaxed">
            {alert.guidance}
          </p>
        </div>
      </div>

      {alert.chips.length > 0 && (
        <div
          dir="ltr"
          className="pt-2.5 border-t border-slate-300/80 dark:border-slate-800/80 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs font-mono tabular-nums"
        >
          {alert.chips.map((chip) => (
            <div key={chip.label} className="flex items-baseline gap-1.5">
              <span className="text-[11px] text-slate-600 dark:text-slate-400">
                {chip.label}
              </span>
              <span
                className={`font-bold ${
                  chip.status === "good"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : chip.status === "warn"
                    ? "text-amber-800 dark:text-amber-300"
                    : "text-slate-900 dark:text-slate-200"
                }`}
              >
                {chip.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
