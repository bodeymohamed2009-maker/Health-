import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

const PIPELINE_STEPS = [
  {
    num: "01",
    title: "رصد تغيّر لون البشرة",
    short: "تدفّق الدم في الشعيرات الدقيقة مع كل نبضة",
    detail:
      "مع كل نبضة قلب، يتدفق الدم في الشعيرات الدقيقة بالوجه فيتغير امتصاص الضوء الأخضر والأحمر والأزرق بنسبة مجهرية لا تراها العين، وتلتقطها الكاميرا بمعدل 30 إطاراً في الثانية.",
    spec: "Sampling 30 Hz · RGB Multi-ROI (Forehead + Bilateral Cheeks)",
  },
  {
    num: "02",
    title: "تنظيف الإضاءة والوميض",
    short: "تثبيت توازن اللون وعزل تذبذب الغرفة",
    detail:
      "يثبّت نظام Von Kries AWB توازن الألوان، بينما يراقب المرشح التكيفي NLMS إضاءة الخلفية لطرح أي وميض من المصابيح أو الشاشات، مع دمج المناطق الثلاث بأوزان SoftMax.",
    spec: "Von Kries AWB + Background NLMS + Specular Highlight Rejection",
  },
  {
    num: "03",
    title: "استخراج النبض والتنفس",
    short: "دمج POS وCHROM وICA مع FFT وKalman",
    detail:
      "تفصل المرشحات الرقمية إيقاع القلب السريع عن إيقاع الشهيق والزفير الأبطأ، ثم يدمج المحرك الرباعي (POS + CHROM + ICA + GREEN) الطيف مع مرشح كالمان لتثبيت القراءة.",
    spec: "Quad-Fusion + 1024-pt Welch FFT + Kalman State Tracker",
  },
  {
    num: "04",
    title: "التوازن العصبي والتوثيق",
    short: "مخطط بوانكاريه وتناغم القلب مع التنفس",
    detail:
      "يقيس النظام الفارق الزمني بين كل نبضة والتي تليها لرسم مخطط بوانكاريه (SD1/SD2) وحساب نسبة تناغم RSA بين القلب والتنفس مع حفظ التقارير محلياً بصيغة CSV وPDF.",
    spec: "Poincaré SD1/SD2 · LF/HF Ratio · Local Encrypted Storage",
  },
];

export function InteractivePipeline() {
  const [activeStep, setActiveStep] = useState(0);
  const current = PIPELINE_STEPS[activeStep];

  return (
    <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 rounded-xl p-6 flex flex-col gap-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            03 · مسار العمل التفاعلي في 4 مراحل
          </span>
          <h3 className="text-base font-bold text-slate-950 dark:text-white mt-1">
            كيف يعمل النظام من العدسة حتى التقرير؟ (اضغط على أي مرحلة)
          </h3>
        </div>
        <span
          dir="ltr"
          className="font-mono text-xs text-slate-600 dark:text-slate-400 tabular-nums font-semibold"
        >
          Stage {current.num} / 04
        </span>
      </div>

      {/* Interactive Stage Selectors */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {PIPELINE_STEPS.map((step, idx) => {
          const isActive = activeStep === idx;
          return (
            <button
              key={step.num}
              type="button"
              onClick={() => setActiveStep(idx)}
              className={`relative text-right p-4 rounded-xl border transition-colors duration-200 cursor-pointer ${
                isActive
                  ? "border-cyan-600/60 dark:border-cyan-500/45 bg-cyan-50/75 dark:bg-cyan-950/20"
                  : "border-slate-300 dark:border-slate-800/80 bg-slate-50 dark:bg-[#080d16]/70 hover:border-slate-400 dark:hover:border-slate-700"
              }`}
            >
              {isActive && (
                <motion.span
                  layoutId="pipeline-active-ring"
                  transition={{ type: "spring", stiffness: 360, damping: 32 }}
                  className="pointer-events-none absolute inset-0 rounded-xl border-2 dark:border border-cyan-700/70 dark:border-cyan-400/50"
                />
              )}
              <span
                dir="ltr"
                className={`block font-mono text-xs font-bold ${
                  isActive
                    ? "text-cyan-800 dark:text-cyan-300"
                    : "text-slate-600 dark:text-slate-400"
                }`}
              >
                {step.num}.
              </span>
              <h4
                className={`text-sm font-bold mt-1.5 ${
                  isActive
                    ? "text-slate-950 dark:text-white"
                    : "text-slate-800 dark:text-slate-200"
                }`}
              >
                {step.title}
              </h4>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                {step.short}
              </p>
            </button>
          );
        })}
      </div>

      {/* Animated Stage Detail Readout */}
      <AnimatePresence mode="wait">
        <motion.div
          key={current.num}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="pt-4 border-t border-slate-200 dark:border-slate-800/80 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        >
          <p className="text-xs sm:text-sm text-slate-800 dark:text-slate-200 leading-relaxed max-w-3xl">
            {current.detail}
          </p>
          <span
            dir="ltr"
            className="font-mono text-[11px] text-cyan-800 dark:text-cyan-300 font-semibold shrink-0 tabular-nums"
          >
            {current.spec}
          </span>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
