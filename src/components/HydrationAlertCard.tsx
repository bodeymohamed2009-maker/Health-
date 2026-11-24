import { motion } from "motion/react";
import { Check, Droplets } from "lucide-react";
import type { HydrationAlertStatus, HydrationSmartAlert } from "../dsp/hydrationAlerts";

interface HydrationAlertCardProps {
  alert: HydrationSmartAlert;
  onAcknowledgeDrink: () => void;
  onSnooze: () => void;
}

const STATUS_STYLES: Record<
  HydrationAlertStatus,
  {
    container: string;
    iconBox: string;
    labelTone: string;
    title: string;
    progressBar: string;
  }
> = {
  urgent: {
    container:
      "bg-sky-50 dark:bg-sky-950/35 border-sky-400 dark:border-sky-400/50",
    iconBox:
      "bg-sky-100 dark:bg-sky-500/20 text-sky-800 dark:text-sky-300 border-sky-300 dark:border-sky-400/40",
    labelTone: "text-sky-800 dark:text-sky-300",
    title: "text-sky-950 dark:text-sky-50",
    progressBar: "bg-sky-700 dark:bg-sky-400",
  },
  remind: {
    container:
      "bg-cyan-50 dark:bg-cyan-950/25 border-cyan-400/80 dark:border-cyan-500/40",
    iconBox:
      "bg-cyan-100 dark:bg-cyan-500/15 text-cyan-800 dark:text-cyan-300 border-cyan-300 dark:border-cyan-500/35",
    labelTone: "text-cyan-800 dark:text-cyan-300",
    title: "text-cyan-950 dark:text-cyan-50",
    progressBar: "bg-cyan-700 dark:bg-cyan-400",
  },
  hydrated: {
    container:
      "bg-teal-50 dark:bg-teal-950/20 border-teal-400/80 dark:border-teal-500/35",
    iconBox:
      "bg-teal-100 dark:bg-teal-500/15 text-teal-800 dark:text-teal-300 border-teal-300 dark:border-teal-500/30",
    labelTone: "text-teal-800 dark:text-teal-300",
    title: "text-teal-950 dark:text-teal-50",
    progressBar: "bg-teal-700 dark:bg-teal-400",
  },
  ready: {
    container:
      "bg-white dark:bg-[#0c1322] border-slate-300 dark:border-slate-800/90",
    iconBox:
      "bg-slate-100 dark:bg-slate-800/80 text-sky-700 dark:text-sky-400 border-slate-300 dark:border-slate-700",
    labelTone: "text-slate-700 dark:text-slate-300",
    title: "text-slate-950 dark:text-slate-100",
    progressBar: "bg-sky-700 dark:bg-sky-500",
  },
};

export function HydrationAlertCard({
  alert,
  onAcknowledgeDrink,
  onSnooze,
}: HydrationAlertCardProps) {
  const styles = STATUS_STYLES[alert.status];
  const pct = Math.min(
    100,
    Math.round((alert.glassesDrank / Math.max(1, alert.dailyGoalGlasses)) * 100)
  );

  return (
    <motion.div
      key={`${alert.status}-${alert.todayCount}-${alert.glassesDrank}`}
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
          <Droplets className="w-4 h-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-400">
            <span>تذكير الترطيب</span>
            <span aria-hidden="true">·</span>
            <span className={`font-semibold ${styles.labelTone}`}>
              {alert.badgeLabel}
            </span>
            <span aria-hidden="true">·</span>
            <span dir="ltr" className="font-mono tabular-nums">
              {alert.todayCount} scans · {alert.glassesDrank}/{alert.dailyGoalGlasses} cups
            </span>
          </div>

          <p className={`text-sm font-bold mt-1 leading-snug ${styles.title}`}>
            {alert.title}
          </p>
          <p className="text-xs text-slate-700 dark:text-slate-300/90 mt-1 leading-relaxed">
            {alert.message}
          </p>
        </div>
      </div>

      <div className="pt-2.5 border-t border-slate-300/80 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-1 min-w-[130px]">
          <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-800/90 rounded-full overflow-hidden">
            <div
              className={`h-full origin-right transition-transform duration-300 ${styles.progressBar}`}
              style={{ transform: `scaleX(${pct / 100})` }}
            />
          </div>
          <span
            dir="ltr"
            className="font-mono text-[11px] text-slate-700 dark:text-slate-400 tabular-nums shrink-0 font-semibold"
          >
            {pct}%
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {alert.canAcknowledge && (
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={onAcknowledgeDrink}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-sky-700 hover:bg-sky-800 dark:text-slate-950 dark:bg-sky-400 dark:hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>تم شرب كوب ماء</span>
            </motion.button>
          )}
          {alert.canSnooze && (
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={onSnooze}
              className="px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-300 bg-white dark:bg-[#060911] border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              لاحقاً
            </motion.button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
