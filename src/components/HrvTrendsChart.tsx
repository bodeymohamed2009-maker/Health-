import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, CheckCircle2, TrendingDown, TrendingUp } from "lucide-react";
import { analyzeHrvTrends, type HrvTrendPoint } from "../dsp/hrvTrends";
import type { BiometricProfile, SessionReading } from "../types/rppg";

interface HrvTrendsChartProps {
  readings: SessionReading[];
  profile?: BiometricProfile;
}

type TrendMetricKey = "rmssd" | "ratio" | "bpm" | "coherence";

const METRIC_META: Record<
  TrendMetricKey,
  {
    label: string;
    unit: string;
    strokeClass: string;
    dotFillClass: string;
    gradTextClass: string;
    yMinFloor: number;
  }
> = {
  rmssd: {
    label: "RMSSD",
    unit: "ms",
    strokeClass: "stroke-emerald-700 dark:stroke-emerald-500",
    dotFillClass: "fill-emerald-700 dark:fill-emerald-500",
    gradTextClass: "text-emerald-700 dark:text-emerald-500",
    yMinFloor: 0,
  },
  ratio: {
    label: "SD2 / SD1",
    unit: "x",
    strokeClass: "stroke-cyan-700 dark:stroke-cyan-400",
    dotFillClass: "fill-cyan-700 dark:fill-cyan-400",
    gradTextClass: "text-cyan-700 dark:text-cyan-400",
    yMinFloor: 0,
  },
  bpm: {
    label: "BPM",
    unit: "bpm",
    strokeClass: "stroke-sky-700 dark:stroke-sky-400",
    dotFillClass: "fill-sky-700 dark:fill-sky-400",
    gradTextClass: "text-sky-700 dark:text-sky-400",
    yMinFloor: 40,
  },
  coherence: {
    label: "Coherence",
    unit: "%",
    strokeClass: "stroke-teal-700 dark:stroke-teal-400",
    dotFillClass: "fill-teal-700 dark:fill-teal-400",
    gradTextClass: "text-teal-700 dark:text-teal-400",
    yMinFloor: 0,
  },
};

function getMetricValue(pt: HrvTrendPoint, key: TrendMetricKey): number | null {
  if (key === "rmssd") return pt.rmssdMs;
  if (key === "ratio") return pt.sdRatio;
  if (key === "bpm") return pt.bpm;
  return pt.coherencePct;
}

export function HrvTrendsChart({ readings, profile }: HrvTrendsChartProps) {
  const [selectedMetric, setSelectedMetric] = useState<TrendMetricKey>("rmssd");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const analysis = useMemo(
    () => analyzeHrvTrends(readings, undefined, profile),
    [readings, profile]
  );
  const { points, alert, direction } = analysis;

  const width = 640;
  const height = 210;
  const padL = 42;
  const padR = 18;
  const padT = 18;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const plotted = useMemo(() => {
    const items: Array<{ index: number; point: HrvTrendPoint; value: number }> = [];
    points.forEach((pt, idx) => {
      const val = getMetricValue(pt, selectedMetric);
      if (val !== null) {
        items.push({ index: idx, point: pt, value: val });
      }
    });
    return items;
  }, [points, selectedMetric]);

  const meta = METRIC_META[selectedMetric];

  const baselineVal =
    selectedMetric === "rmssd"
      ? analysis.baselineRmssdMs
      : selectedMetric === "ratio"
      ? analysis.baselineSdRatio
      : selectedMetric === "bpm"
      ? analysis.baselineBpm
      : analysis.baselineCoherencePct;

  const { minVal, maxVal } = useMemo(() => {
    const vals = plotted.map((p) => p.value);
    if (baselineVal !== null) vals.push(baselineVal);
    if (vals.length === 0) return { minVal: 0, maxVal: 100 };
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    const span = Math.max(selectedMetric === "ratio" ? 1.2 : 12, rawMax - rawMin);
    return {
      minVal: Math.max(meta.yMinFloor, Math.floor(rawMin - span * 0.25)),
      maxVal: Math.ceil(rawMax + span * 0.25),
    };
  }, [plotted, baselineVal, meta.yMinFloor, selectedMetric]);

  const mapX = (pos: number, count: number) => {
    if (count <= 1) return padL + plotW / 2;
    return padL + (pos / (count - 1)) * plotW;
  };

  const mapY = (val: number) => {
    const ratio = (val - minVal) / Math.max(1e-6, maxVal - minVal);
    return padT + plotH - Math.max(0, Math.min(1, ratio)) * plotH;
  };

  const polylineStr = plotted
    .map((item, idx) => `${mapX(idx, plotted.length).toFixed(1)},${mapY(item.value).toFixed(1)}`)
    .join(" ");

  const areaPathStr =
    plotted.length >= 2
      ? `M ${mapX(0, plotted.length).toFixed(1)} ${(padT + plotH).toFixed(1)} ` +
        plotted
          .map(
            (item, idx) =>
              `L ${mapX(idx, plotted.length).toFixed(1)} ${mapY(item.value).toFixed(1)}`
          )
          .join(" ") +
        ` L ${mapX(plotted.length - 1, plotted.length).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
      : "";

  const hoveredItem = hoveredIdx !== null ? plotted[hoveredIdx] ?? null : null;

  const directionStatus =
    direction === "declining"
      ? {
          text:
            alert.consecutiveCount >= 2
              ? `انحراف متتالي (${alert.consecutiveCount} قراءات)`
              : "اتجاه هابط في HRV",
          cls: "text-amber-700 dark:text-amber-300",
          icon: <TrendingDown className="w-3.5 h-3.5" />,
        }
      : direction === "improving"
      ? {
          text: "تحسّن في التعافي العصبي",
          cls: "text-emerald-700 dark:text-emerald-300",
          icon: <TrendingUp className="w-3.5 h-3.5" />,
        }
      : direction === "stable"
      ? {
          text: "اتجاه مستقر ومتوازن",
          cls: "text-cyan-700 dark:text-cyan-300",
          icon: <CheckCircle2 className="w-3.5 h-3.5" />,
        }
      : {
          text: "بانتظار قراءتين على الأقل",
          cls: "text-slate-600 dark:text-slate-400",
          icon: null,
        };

  return (
    <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <h3 className="text-sm font-semibold text-slate-950 dark:text-white tracking-tight">
              تحليل اتجاهات النبض والتوازن العصبي (HRV Trends)
            </h3>
            <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <span className={`inline-flex items-center gap-1 font-semibold ${directionStatus.cls}`}>
              {directionStatus.icon}
              <span>{directionStatus.text}</span>
            </span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            تتبّع زمني لمؤشرات التعافي العصبي واكتشاف الانحرافات المتتالية مقارنة بخط
            الأساس الشخصي
          </p>
        </div>

        <div
          dir="ltr"
          className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#080d16] border border-slate-300 dark:border-slate-800/90 rounded-lg self-start md:self-auto"
        >
          {(["rmssd", "ratio", "bpm", "coherence"] as TrendMetricKey[]).map(
            (key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSelectedMetric(key);
                  setHoveredIdx(null);
                }}
                className={`relative px-2.5 py-1.5 text-[11px] font-mono font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  selectedMetric === key
                    ? "text-cyan-800 dark:text-cyan-300"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200"
                }`}
              >
                {selectedMetric === key && (
                  <motion.span
                    layoutId="trend-metric-active"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    className="absolute inset-0 bg-white dark:bg-slate-800 border border-slate-300/80 dark:border-transparent rounded-md shadow-xs dark:shadow-none"
                  />
                )}
                <span className="relative z-10">{METRIC_META[key].label}</span>
              </button>
            )
          )}
        </div>
      </div>

      {/* Interactive Trend Chart */}
      <div className="relative bg-slate-100 dark:bg-[#080d16] border border-slate-200 dark:border-transparent rounded-lg p-3.5">
        {hoveredItem && (
          <div
            dir="ltr"
            className="mb-2 flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-300 dark:border-slate-800/80 text-[11px] font-mono tabular-nums text-slate-900 dark:text-slate-200"
          >
            <span className="text-cyan-700 dark:text-cyan-300 font-semibold">
              {hoveredItem.point.timestamp}
            </span>
            <span>
              RMSSD {hoveredItem.point.rmssdMs ?? "--"} ms · SD1/SD2{" "}
              {hoveredItem.point.sd1Ms ?? "--"}/{hoveredItem.point.sd2Ms ?? "--"} ·{" "}
              {hoveredItem.point.bpm} BPM · Coh{" "}
              {hoveredItem.point.coherencePct ?? "--"}%
            </span>
          </div>
        )}

        {plotted.length >= 2 ? (
          <div dir="ltr" className="w-full">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-48 select-none overflow-visible"
            >
              <defs>
                <linearGradient
                  id="trendAreaGrad"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                  className={meta.gradTextClass}
                >
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>

              {[0, 0.5, 1].map((frac) => {
                const y = padT + frac * plotH;
                const val = maxVal - frac * (maxVal - minVal);
                return (
                  <g key={frac}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={width - padR}
                      y2={y}
                      className="stroke-slate-300 dark:stroke-slate-800"
                      strokeWidth={0.75}
                      strokeDasharray="3 3"
                      strokeOpacity={0.85}
                    />
                    <text
                      x={padL - 6}
                      y={y + 3}
                      textAnchor="end"
                      className="fill-slate-600 dark:fill-slate-400"
                      fontSize="9"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      {selectedMetric === "ratio" ? val.toFixed(1) : Math.round(val)}
                    </text>
                  </g>
                );
              })}

              {baselineVal !== null && (
                <g>
                  <line
                    x1={padL}
                    y1={mapY(baselineVal)}
                    x2={width - padR}
                    y2={mapY(baselineVal)}
                    className="stroke-slate-500 dark:stroke-slate-500"
                    strokeWidth={1}
                    strokeDasharray="5 4"
                    strokeOpacity={0.75}
                  />
                  <text
                    x={width - padR}
                    y={mapY(baselineVal) - 4}
                    textAnchor="end"
                    className="fill-slate-700 dark:fill-slate-400"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    Baseline {baselineVal}
                    {meta.unit}
                  </text>
                </g>
              )}

              {areaPathStr && <path d={areaPathStr} fill="url(#trendAreaGrad)" />}

              <polyline
                fill="none"
                className={meta.strokeClass}
                strokeWidth={2.2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={polylineStr}
              />

              {hoveredIdx !== null && plotted[hoveredIdx] && (
                <line
                  x1={mapX(hoveredIdx, plotted.length)}
                  y1={padT}
                  x2={mapX(hoveredIdx, plotted.length)}
                  y2={padT + plotH}
                  className="stroke-slate-600 dark:stroke-slate-400"
                  strokeWidth={0.9}
                  strokeDasharray="2 2"
                />
              )}

              {plotted.map((item, idx) => {
                const px = mapX(idx, plotted.length);
                const py = mapY(item.value);
                const flagged = item.point.isAnomalous;
                const isHovered = hoveredIdx === idx;
                return (
                  <g key={item.point.id}>
                    {isHovered && (
                      <circle
                        cx={px}
                        cy={py}
                        r={8}
                        className={
                          flagged
                            ? "fill-rose-600/20 dark:fill-rose-500/25"
                            : `${meta.dotFillClass} opacity-25`
                        }
                      />
                    )}
                    <circle
                      cx={px}
                      cy={py}
                      r={flagged ? 5 : isHovered ? 4.8 : 3.8}
                      className={`cursor-pointer stroke-slate-100 dark:stroke-[#080d16] ${
                        flagged ? "fill-rose-600 dark:fill-rose-500" : meta.dotFillClass
                      }`}
                      strokeWidth={1.5}
                      onMouseEnter={() => setHoveredIdx(idx)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    />
                    {(idx === 0 ||
                      idx === plotted.length - 1 ||
                      plotted.length <= 7) && (
                      <text
                        x={px}
                        y={height - 7}
                        textAnchor="middle"
                        className="fill-slate-600 dark:fill-slate-400"
                        fontSize="8.5"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {item.point.timestamp.slice(0, 5)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        ) : (
          <div className="h-40 flex flex-col items-center justify-center text-center px-4">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-300">
              تظهر رسمة اتجاهات {meta.label} وتنبيهات الانحراف العصبي تلقائياً فور
              تسجيل جلستين (قراءتين) أو أكثر.
            </p>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
              أكمل مسحاً مدته 15 أو 30 ثانية أو اضغط «حفظ لقطة القراءة الحالية» لبناء
              منحناك المرجعي الشخصي.
            </p>
          </div>
        )}
      </div>

      {/* Hairline-Divided Telemetry Footer Strip (No Nested Cards) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x lg:divide-x-reverse divide-slate-200 dark:divide-slate-800/80 border-t border-slate-200 dark:border-slate-800/80 pt-3">
        <div className="py-1.5 lg:pl-4">
          <span className="block text-[11px] text-slate-600 dark:text-slate-400 font-medium">
            متوسط RMSSD المرجعي
          </span>
          <span
            dir="ltr"
            className="block font-mono text-base font-bold text-emerald-700 dark:text-emerald-400 tabular-nums mt-0.5"
          >
            {analysis.baselineRmssdMs !== null
              ? `${analysis.baselineRmssdMs} ms`
              : "--"}
          </span>
          <span
            dir="ltr"
            className="block font-mono text-[10px] text-slate-600 dark:text-slate-400 mt-0.5"
          >
            {analysis.rmssdDeltaPct !== null
              ? `Latest ${analysis.rmssdDeltaPct >= 0 ? "+" : ""}${analysis.rmssdDeltaPct}%`
              : "Needs ≥2 readings"}
          </span>
        </div>

        <div className="py-1.5 lg:px-4">
          <span className="block text-[11px] text-slate-600 dark:text-slate-400 font-medium">
            توازن SD2 / SD1 الحالي
          </span>
          <span
            dir="ltr"
            className="block font-mono text-base font-bold text-cyan-700 dark:text-cyan-300 tabular-nums mt-0.5"
          >
            {analysis.latestSdRatio !== null ? `${analysis.latestSdRatio}x` : "--"}
          </span>
          <span
            dir="ltr"
            className="block font-mono text-[10px] text-slate-600 dark:text-slate-400 mt-0.5"
          >
            {analysis.baselineSdRatio !== null
              ? `Baseline ${analysis.baselineSdRatio}x`
              : "Optimal 1.0–2.5x"}
          </span>
        </div>

        <div className="py-1.5 lg:px-4">
          <span className="block text-[11px] text-slate-600 dark:text-slate-400 font-medium">
            ميل التغير (Slope / جلسة)
          </span>
          <span
            dir="ltr"
            className="block font-mono text-base font-bold text-slate-900 dark:text-slate-100 tabular-nums mt-0.5"
          >
            {analysis.rmssdSlopePerSession !== null
              ? `${analysis.rmssdSlopePerSession >= 0 ? "+" : ""}${analysis.rmssdSlopePerSession} ms`
              : "--"}
          </span>
          <span className="block text-[10px] text-slate-600 dark:text-slate-400 mt-0.5">
            عبر {points.length} قراءات مسجلة
          </span>
        </div>

        <div className="py-1.5 lg:pr-4">
          <span className="block text-[11px] text-slate-600 dark:text-slate-400 font-medium">
            رصد الانحراف المتتالي
          </span>
          <div className="flex items-center gap-1.5 mt-0.5">
            {(alert.severity === "warning" || alert.severity === "caution") && (
              <AlertTriangle
                className={`w-4 h-4 shrink-0 ${
                  alert.severity === "warning"
                    ? "text-rose-700 dark:text-rose-400"
                    : "text-amber-700 dark:text-amber-400"
                }`}
              />
            )}
            <span
              className={`text-xs font-bold ${
                alert.severity === "warning"
                  ? "text-rose-700 dark:text-rose-300"
                  : alert.severity === "caution"
                  ? "text-amber-800 dark:text-amber-300"
                  : "text-slate-950 dark:text-white"
              }`}
            >
              {alert.severity === "warning"
                ? `تنبيه (${alert.consecutiveCount} متتالية)`
                : alert.severity === "caution"
                ? `ملاحظة (${alert.consecutiveCount} متتالية)`
                : alert.severity === "nominal"
                ? "متزن ولا توجد انحرافات"
                : "قيد التجميع"}
            </span>
          </div>
          <span className="block text-[10px] text-slate-600 dark:text-slate-400 mt-0.5">
            يظهر التفصيل داخل نافذة التقرير
          </span>
        </div>
      </div>
    </div>
  );
}
