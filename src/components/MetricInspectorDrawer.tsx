import { motion } from "motion/react";
import { Activity, ShieldAlert, Sparkles, Waves, Wind, X } from "lucide-react";
import { getAgeAdjustedNorms } from "../dsp/hrvTrends";
import type { BiometricProfile, RppgMetrics } from "../types/rppg";

export type MetricInspectorKey = "bpm" | "resp" | "coherence" | "quality" | "spo2";

interface MetricInspectorDrawerProps {
  selected: MetricInspectorKey;
  metrics: RppgMetrics;
  profile: BiometricProfile;
  onClose: () => void;
  onFocusTab: (tab: "signals" | "autonomic" | "trends") => void;
  onOpenPacer: () => void;
}

export function MetricInspectorDrawer({
  selected,
  metrics,
  profile,
  onClose,
  onFocusTab,
  onOpenPacer,
}: MetricInspectorDrawerProps) {
  const norms = getAgeAdjustedNorms(profile.age);

  const renderContent = () => {
    switch (selected) {
      case "bpm": {
        const minBpm = 45;
        const maxBpm = norms.hrMaxBpm ?? 190;
        const val = metrics.bpm;
        const pct =
          val !== null
            ? Math.max(0, Math.min(100, ((val - minBpm) / (maxBpm - minBpm)) * 100))
            : 0;
        return {
          icon: <Activity className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />,
          title: "تحليل معدل ضربات القلب (Kalman-Filtered BPM)",
          subtitle:
            val !== null
              ? norms.hrMaxBpm
                ? `نطاق نبضك الحالي ${val} BPM يعادل ${Math.round((val / norms.hrMaxBpm) * 100)}% من أقصى نبض مقدّر لعمرك (${norms.hrMaxBpm} BPM).`
                : `القراءة المثبتة عبر مرشح كالمان: ${val} نبضة/دقيقة (الطيف الخام: ${metrics.rawFftBpm ?? val} BPM).`
              : "ابدأ القياس لمدة 5 ثوانٍ على الأقل لاستخراج نبض القلب عبر التحليل الطيفي ومطابقته مع مرشح كالمان.",
          rangeLabel: `${minBpm}–${maxBpm} BPM`,
          markerPct: val !== null ? pct : null,
          barColor: "bg-cyan-700 dark:bg-cyan-400",
          actionLabel: "عرض موجة النبض والطيف",
          onAction: () => onFocusTab("signals"),
        };
      }
      case "resp": {
        const isHold = metrics.respStatus === "breath_hold";
        const val = metrics.respirationBrpm;
        const pct = isHold
          ? 0
          : val !== null
          ? Math.max(0, Math.min(100, ((val - 6) / (28 - 6)) * 100))
          : null;
        return {
          icon: <Wind className="w-4 h-4 text-teal-700 dark:text-teal-300" />,
          title: isHold
            ? "رصد توقف التنفس مؤقتاً (كتم النفس)"
            : "تحليل معدل التنفس (RIAV + RIIV + RIFV)",
          subtitle: isHold
            ? `انخفض التضمين التنفسي في موجة النبض واضطراب النظم الجيبي لمدة ${(metrics.breathHoldSeconds ?? 5).toFixed(1)} ثوانٍ، مما يشير إلى كتم النفس. تنفّس بهدوء لاستئناف القراءة.`
            : val !== null
            ? `معدل التنفس الطبيعي أثناء الراحة يتراوح بين 12 و20 دورة/دقيقة. قراءتك الحالية ${val} BrPM بجودة طيف ${metrics.respSnrDb.toFixed(1)} dB.`
            : "يتطلب استخلاص موجة التنفس 12 ثانية من البيانات المستقرة عبر قياس تعديل سعة النبض واضطراب النظم الجيبي.",
          rangeLabel: isHold ? "Breath Hold Detected" : "6–28 BrPM (الطبيعي 12–20)",
          markerPct: pct,
          barColor: isHold
            ? "bg-amber-600 dark:bg-amber-400"
            : "bg-teal-700 dark:bg-teal-400",
          actionLabel: "تشغيل موجّه التنفس 0.1 Hz",
          onAction: onOpenPacer,
        };
      }
      case "coherence": {
        const val = metrics.coherencePct;
        return {
          icon: <Sparkles className="w-4 h-4 text-emerald-700 dark:text-emerald-300" />,
          title: "تناغم القلب والتنفس (RSA Coherence)",
          subtitle:
            val !== null
              ? `يعكس مدى تزامن تسارع النبض مع الشهيق وتباطؤه مع الزفير (${val}%). القيم فوق 60% تشير إلى استجابة باراسمبثاوية هادئة.`
              : "يُحسب التناغم تلقائياً بمجرد اكتمال نافذة التنفس ورصد أزواج النبضات المتعاقبة.",
          rangeLabel: "0% – 100% Coherence",
          markerPct: val !== null ? Math.max(0, Math.min(100, val)) : null,
          barColor: "bg-emerald-700 dark:bg-emerald-400",
          actionLabel: "عرض مخطط بوانكاريه",
          onAction: () => onFocusTab("autonomic"),
        };
      }
      case "quality": {
        const sqi = metrics.sqiPct ?? 0;
        return {
          icon: <Waves className="w-4 h-4 text-cyan-700 dark:text-cyan-300" />,
          title: "جودة الإشارة البصرية (SQI % & Cardiac SNR)",
          subtitle:
            metrics.bufferSeconds >= 2
              ? `مؤشر نقاء الإشارة المركب ${sqi}% ونسبة الإشارة للضوضاء ${metrics.snrDb.toFixed(1)} dB. حافظ على إضاءة ثابتة وتقليل الحركة لإبقاء SQI فوق 65%.`
              : "يعكس مدى صفاء الإشارة المستخلصة من البشرة بعد تطبيق موازنة اللون الأبيض وإلغاء وميض الإضاءة NLMS.",
          rangeLabel: "0% – 100% SQI",
          markerPct: metrics.bufferSeconds >= 2 ? Math.max(0, Math.min(100, sqi)) : null,
          barColor:
            sqi >= 65
              ? "bg-emerald-700 dark:bg-emerald-400"
              : sqi >= 40
              ? "bg-cyan-700 dark:bg-cyan-400"
              : "bg-amber-600 dark:bg-amber-400",
          actionLabel: "عرض الاتجاهات الزمنية",
          onAction: () => onFocusTab("trends"),
        };
      }
      case "spo2":
      default:
        return {
          icon: <ShieldAlert className="w-4 h-4 text-amber-700 dark:text-amber-300" />,
          title: "حدود فيزيائية: لماذا لا يعرض النظام SpO2؟",
          subtitle:
            "قياس تشبع الأكسجين بدقة يتطلب إضاءة مزدوجة الطول الموجي (أحمر 660 nm وأشعة تحت حمراء 940 nm)، بينما تمنع عدسات الهواتف وكاميرات الويب الأشعة تحت الحمراء بمرشح IR-Cut.",
          rangeLabel: "IR 940nm غير متاح في كاميرات RGB",
          markerPct: null,
          barColor: "bg-amber-600 dark:bg-amber-400",
          actionLabel: "اقرأ المنهجية العلمية",
          onAction: () => {
            document.getElementById("science")?.scrollIntoView({ behavior: "smooth" });
          },
        };
    }
  };

  const info = renderContent();

  return (
    <motion.div
      key={selected}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="bg-white dark:bg-[#0c1322] border border-cyan-600/50 dark:border-cyan-500/30 rounded-xl p-4 flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-800 flex items-center justify-center shrink-0 mt-0.5">
            {info.icon}
          </div>
          <div className="min-w-0">
            <h4 className="text-xs font-bold text-slate-950 dark:text-white">
              {info.title}
            </h4>
            <p className="text-xs text-slate-700 dark:text-slate-300 mt-1 leading-relaxed">
              {info.subtitle}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="p-2 text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800/80 rounded-lg transition-colors shrink-0 cursor-pointer"
          aria-label="إغلاق تفاصيل المؤشر"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="pt-2 border-t border-slate-200 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-[200px]">
          <div
            dir="ltr"
            className="relative flex-1 h-2 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden"
          >
            {info.markerPct !== null ? (
              <div
                className={`h-full w-full origin-left transition-transform duration-300 ${info.barColor}`}
                style={{ transform: `scaleX(${(info.markerPct / 100).toFixed(3)})` }}
              />
            ) : (
              <div className="h-full w-full bg-slate-300 dark:bg-slate-700/40" />
            )}
          </div>
          <span
            dir="ltr"
            className="font-mono text-[11px] text-slate-600 dark:text-slate-400 tabular-nums shrink-0 font-medium"
          >
            {info.rangeLabel}
          </span>
        </div>

        <button
          type="button"
          onClick={info.onAction}
          className="px-3 py-1.5 text-xs font-semibold text-cyan-800 dark:text-cyan-300 bg-cyan-50 hover:bg-cyan-100 dark:bg-cyan-500/10 dark:hover:bg-cyan-500/20 border border-cyan-600/40 dark:border-cyan-500/30 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
        >
          {info.actionLabel}
        </button>
      </div>
    </motion.div>
  );
}
