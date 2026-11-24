import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Wind, X } from "lucide-react";

interface BreathingPacerProps {
  onClose: () => void;
}

// 0.1 Hz Coherent Resonant Breathing Cycle (4.0s Inhale + 6.0s Exhale = 10.0s -> 6 BrPM)
const INHALE_MS = 4000;
const EXHALE_MS = 6000;
const CYCLE_MS = INHALE_MS + EXHALE_MS;

export function BreathingPacer({ onClose }: BreathingPacerProps) {
  const [elapsedInCycle, setElapsedInCycle] = useState(0);

  useEffect(() => {
    let rafId = 0;
    const start = performance.now();
    const loop = (now: number) => {
      setElapsedInCycle((now - start) % CYCLE_MS);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const isInhale = elapsedInCycle < INHALE_MS;
  const phaseProgress = isInhale
    ? elapsedInCycle / INHALE_MS
    : (elapsedInCycle - INHALE_MS) / EXHALE_MS;

  // Smooth cosine easing 0 -> 1 on inhale, 1 -> 0 on exhale
  const ease = 0.5 - 0.5 * Math.cos(Math.PI * phaseProgress);
  const orbScale = isInhale ? 0.58 + ease * 0.42 : 1.0 - ease * 0.42;
  const remainingSec = isInhale
    ? ((INHALE_MS - elapsedInCycle) / 1000).toFixed(1)
    : ((CYCLE_MS - elapsedInCycle) / 1000).toFixed(1);

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="bg-teal-50/80 dark:bg-gradient-to-l dark:from-teal-950/35 dark:via-[#0c1322] dark:to-[#0c1322] border border-teal-400/80 dark:border-teal-500/35 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4"
    >
      <div className="flex items-center gap-4 min-w-0">
        {/* Interactive Resonant Breathing Orb */}
        <div className="relative w-14 h-14 flex items-center justify-center shrink-0">
          <div className="absolute inset-0 rounded-full border border-teal-600/30 dark:border-teal-500/25" />
          <div
            className="w-12 h-12 rounded-full bg-gradient-to-tr from-teal-600/30 to-cyan-600/35 dark:from-teal-500/40 dark:to-cyan-400/50 border border-teal-700/60 dark:border-teal-300/60 shadow-[0_0_24px_rgba(20,184,166,0.22)] will-change-transform flex items-center justify-center"
            style={{ transform: `scale(${orbScale.toFixed(3)})` }}
          >
            <Wind className="w-4 h-4 text-teal-900 dark:text-teal-100" />
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <span className="font-semibold text-teal-800 dark:text-teal-300">
              موجّه التنفس الرنيني (0.1 Hz)
            </span>
            <span aria-hidden="true">·</span>
            <span dir="ltr" className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
              6.0 BrPM Target
            </span>
          </div>
          <div className="flex items-baseline gap-2.5 mt-1">
            <span className="text-base font-bold text-slate-950 dark:text-white">
              {isInhale ? "شهيق عميق بهدوء" : "زفير بطيء ومستمر"}
            </span>
            <span
              dir="ltr"
              className="font-mono text-sm font-bold text-teal-800 dark:text-teal-300 tabular-nums"
            >
              {remainingSec}s
            </span>
          </div>
          <p className="text-xs text-slate-700 dark:text-slate-400 mt-0.5 leading-snug">
            اتّبع حركة الدائرة لرفع التناغم القلبي والتنفسي (RSA Coherence) أثناء الفحص.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end shrink-0">
        <div
          dir="ltr"
          className="w-28 sm:w-32 h-1.5 bg-teal-200 dark:bg-slate-800 rounded-full overflow-hidden"
        >
          <div
            className={`h-full w-full origin-left will-change-transform ${
              isInhale
                ? "bg-cyan-700 dark:bg-cyan-400"
                : "bg-teal-700 dark:bg-teal-400"
            }`}
            style={{
              transform: `scaleX(${(isInhale ? phaseProgress : 1 - phaseProgress).toFixed(3)})`,
            }}
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-2 text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-white hover:bg-teal-100 dark:hover:bg-slate-800/80 rounded-lg transition-colors cursor-pointer"
          aria-label="إغلاق موجّه التنفس"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </motion.div>
  );
}
