import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { CalendarRange, HeartHandshake, Wind } from "lucide-react";
import {
  analyzeWeeklyAverages,
  type DailyWeeklyBucket,
} from "../dsp/weeklyAverages";
import type { SessionReading } from "../types/rppg";

interface WeeklyAveragesPanelProps {
  readings: SessionReading[];
}

type ChannelView = "both" | "respiration" | "coherence";

function getRespStatusTone(
  status: ReturnType<typeof analyzeWeeklyAverages>["respiration"]["status"]
) {
  if (status === "normal") {
    return {
      glyph: "●",
      cls: "text-teal-700 dark:text-teal-300",
    };
  }
  if (status === "tachypnea") {
    return {
      glyph: "▲",
      cls: "text-amber-800 dark:text-amber-300",
    };
  }
  if (status === "bradypnea") {
    return {
      glyph: "▼",
      cls: "text-amber-800 dark:text-amber-300",
    };
  }
  return {
    glyph: "○",
    cls: "text-slate-600 dark:text-slate-400",
  };
}

function getCohStatusTone(
  status: ReturnType<typeof analyzeWeeklyAverages>["coherence"]["status"]
) {
  if (status === "optimal") {
    return {
      glyph: "●",
      cls: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (status === "moderate") {
    return {
      glyph: "▲",
      cls: "text-amber-800 dark:text-amber-300",
    };
  }
  if (status === "low") {
    return {
      glyph: "✖",
      cls: "text-rose-700 dark:text-rose-300",
    };
  }
  return {
    glyph: "○",
    cls: "text-slate-600 dark:text-slate-400",
  };
}

function getDailyClinicalNote(day: DailyWeeklyBucket): {
  label: string;
  cls: string;
} {
  if (day.sessionCount === 0) {
    return { label: "لا توجد قراءات", cls: "text-slate-500 dark:text-slate-500" };
  }
  const respOk =
    day.respirationAvgBrpm !== null &&
    day.respirationAvgBrpm >= 12 &&
    day.respirationAvgBrpm <= 20;
  const cohHigh = day.coherenceAvgPct !== null && day.coherenceAvgPct >= 60;
  const cohLow = day.coherenceAvgPct !== null && day.coherenceAvgPct < 40;

  if (respOk && cohHigh) {
    return {
      label: "● مستقر ومتناغم",
      cls: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (cohLow || (day.respirationAvgBrpm !== null && day.respirationAvgBrpm > 20)) {
    return {
      label: "▲ يحتاج متابعة",
      cls: "text-amber-800 dark:text-amber-300",
    };
  }
  if (respOk || (day.coherenceAvgPct !== null && day.coherenceAvgPct >= 40)) {
    return {
      label: "● مقبول سريرياً",
      cls: "text-cyan-700 dark:text-cyan-300",
    };
  }
  return {
    label: "○ قياس جزئي",
    cls: "text-slate-700 dark:text-slate-300",
  };
}

export function WeeklyAveragesPanel({ readings }: WeeklyAveragesPanelProps) {
  const [channelView, setChannelView] = useState<ChannelView>("both");
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);

  const summary = useMemo(() => analyzeWeeklyAverages(readings), [readings]);
  const { days, respiration, coherence } = summary;

  const respTone = getRespStatusTone(respiration.status);
  const cohTone = getCohStatusTone(coherence.status);

  // SVG chart geometry (7-day rolling plot)
  const width = 640;
  const height = 196;
  const padL = 44;
  const padR = 44;
  const padT = 18;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const respMinScale = 6;
  const respMaxScale = 28;
  const cohMinScale = 0;
  const cohMaxScale = 100;

  const mapDayX = (idx: number) => {
    const slotW = plotW / days.length;
    return padL + slotW * idx + slotW / 2;
  };

  const mapRespY = (brpm: number) => {
    const ratio = (brpm - respMinScale) / (respMaxScale - respMinScale);
    return padT + plotH - Math.max(0, Math.min(1, ratio)) * plotH;
  };

  const mapCohY = (pct: number) => {
    const ratio = (pct - cohMinScale) / (cohMaxScale - cohMinScale);
    return padT + plotH - Math.max(0, Math.min(1, ratio)) * plotH;
  };

  // Build connected respiration segments across days that have valid BrPM values
  const respPoints = useMemo(() => {
    return days
      .map((d, idx) =>
        d.respirationAvgBrpm !== null
          ? { idx, x: mapDayX(idx), y: mapRespY(d.respirationAvgBrpm), day: d }
          : null
      )
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [days]);

  const respPolyline = respPoints
    .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");

  const cohPoints = useMemo(() => {
    return days
      .map((d, idx) =>
        d.coherenceAvgPct !== null
          ? { idx, x: mapDayX(idx), y: mapCohY(d.coherenceAvgPct), day: d }
          : null
      )
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [days]);

  const cohPolyline = cohPoints
    .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");

  const hoveredDay = hoveredDayIdx !== null ? days[hoveredDayIdx] ?? null : null;
  const hasAnyWeeklyData =
    respiration.sampleCount > 0 || coherence.sampleCount > 0;

  // Normal respiration clinical band (12 - 20 BrPM)
  const respBandTop = mapRespY(20);
  const respBandBottom = mapRespY(12);

  return (
    <section
      id="weekly-averages"
      aria-label="لوحة المتوسطات الأسبوعية للتنفس والتناغم"
      className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 rounded-xl p-5 flex flex-col gap-5"
    >
      {/* Header Row (Zero-Pill Discipline) */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <CalendarRange
              className="w-4 h-4 text-teal-700 dark:text-teal-400 shrink-0"
              aria-hidden="true"
            />
            <h3 className="text-sm font-bold text-slate-950 dark:text-white tracking-tight">
              المتوسطات الأسبوعية لمعدل التنفس ونسبة التناغم
            </h3>
            <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <span
              dir="ltr"
              className="font-mono text-slate-600 dark:text-slate-400 tabular-nums"
            >
              {summary.windowStartLabel} – {summary.windowEndLabel}
            </span>
            <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <span className="text-slate-600 dark:text-slate-400 tabular-nums">
              {summary.totalSessionsCount} قراءة خلال {summary.activeDaysCount}/7 أيام
            </span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            ملخص سريري مرجعي لمتوسطات آخر 7 أيام لمراقبة استقرار التنفس وتناغم القلب
            العصبي عبر الجلسات اليومية.
          </p>
        </div>

        {/* Channel View Segmented Switch */}
        <div
          role="tablist"
          aria-label="تحديد مؤشرات المتوسط الأسبوعي"
          className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-[#080d16] border border-slate-300 dark:border-slate-800/90 rounded-lg self-start lg:self-auto"
        >
          {(
            [
              { id: "both", label: "مقارنة ثنائية" },
              { id: "respiration", label: "التنفس (BrPM)" },
              { id: "coherence", label: "التناغم (%)" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={channelView === tab.id}
              onClick={() => setChannelView(tab.id)}
              className={`relative px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                channelView === tab.id
                  ? "text-teal-800 dark:text-teal-300 font-semibold"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200"
              }`}
            >
              {channelView === tab.id && (
                <motion.span
                  layoutId="weekly-channel-active"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  className="absolute inset-0 bg-white dark:bg-slate-800 border border-slate-300/80 dark:border-transparent rounded-md shadow-xs dark:shadow-none"
                />
              )}
              <span className="relative z-10">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 2-Column Clinical KPI Summary Strip (Hairline-Divided, No Nested Cards) */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x md:divide-x-reverse divide-slate-200 dark:divide-slate-800/80 border-y border-slate-200 dark:border-slate-800/80 py-4 gap-y-4 md:gap-y-0">
        {/* Respiration Weekly Metric */}
        <div className="md:pl-6 flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
              <Wind
                className="w-3.5 h-3.5 text-teal-700 dark:text-teal-400"
                aria-hidden="true"
              />
              <span>متوسط معدل التنفس الأسبوعي</span>
            </span>
            <span className={`text-xs font-semibold ${respTone.cls}`}>
              {respTone.glyph} {respiration.statusLabel}
            </span>
          </div>

          <div className="flex items-baseline gap-2 mt-0.5">
            <span
              dir="ltr"
              className="font-mono text-3xl font-bold text-slate-950 dark:text-white tabular-nums tracking-tight"
            >
              {respiration.weeklyAvgBrpm !== null
                ? respiration.weeklyAvgBrpm.toFixed(1)
                : "--"}
            </span>
            <span
              dir="ltr"
              className="font-mono text-xs font-semibold uppercase text-slate-600 dark:text-slate-400"
            >
              BrPM (7D Mean)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-400 tabular-nums">
            <span>
              المدى:{" "}
              {respiration.minBrpm !== null && respiration.maxBrpm !== null
                ? `${respiration.minBrpm.toFixed(1)} – ${respiration.maxBrpm.toFixed(1)} BrPM`
                : "--"}
            </span>
            <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <span>العينة: {respiration.sampleCount} قراءات</span>
            {respiration.deltaVsPrevWeekBrpm !== null && (
              <>
                <span
                  className="text-slate-400 dark:text-slate-600"
                  aria-hidden="true"
                >
                  ·
                </span>
                <span
                  dir="ltr"
                  className="text-teal-700 dark:text-teal-300 font-semibold"
                >
                  {respiration.deltaVsPrevWeekBrpm >= 0 ? "+" : ""}
                  {respiration.deltaVsPrevWeekBrpm.toFixed(1)} BrPM vs prior 7d
                </span>
              </>
            )}
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mt-0.5">
            {respiration.clinicalNote}
          </p>
        </div>

        {/* Coherence Weekly Metric */}
        <div className="pt-4 md:pt-0 md:pr-6 flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
              <HeartHandshake
                className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400"
                aria-hidden="true"
              />
              <span>متوسط نسبة التناغم القلبي الأسبوعي</span>
            </span>
            <span className={`text-xs font-semibold ${cohTone.cls}`}>
              {cohTone.glyph} {coherence.statusLabel}
            </span>
          </div>

          <div className="flex items-baseline gap-2 mt-0.5">
            <span
              dir="ltr"
              className="font-mono text-3xl font-bold text-slate-950 dark:text-white tabular-nums tracking-tight"
            >
              {coherence.weeklyAvgPct !== null
                ? coherence.weeklyAvgPct.toFixed(1)
                : "--"}
            </span>
            <span
              dir="ltr"
              className="font-mono text-xs font-semibold uppercase text-slate-600 dark:text-slate-400"
            >
              % Coherence (7D Mean)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-400 tabular-nums">
            <span>
              المدى:{" "}
              {coherence.minPct !== null && coherence.maxPct !== null
                ? `${coherence.minPct}% – ${coherence.maxPct}%`
                : "--"}
            </span>
            <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <span>العينة: {coherence.sampleCount} قراءات</span>
            {coherence.deltaVsPrevWeekPct !== null && (
              <>
                <span
                  className="text-slate-400 dark:text-slate-600"
                  aria-hidden="true"
                >
                  ·
                </span>
                <span
                  dir="ltr"
                  className={`font-semibold ${
                    coherence.deltaVsPrevWeekPct >= 0
                      ? "text-emerald-700 dark:text-emerald-300"
                      : "text-amber-800 dark:text-amber-300"
                  }`}
                >
                  {coherence.deltaVsPrevWeekPct >= 0 ? "+" : ""}
                  {coherence.deltaVsPrevWeekPct.toFixed(1)}% vs prior 7d
                </span>
              </>
            )}
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mt-0.5">
            {coherence.clinicalNote}
          </p>
        </div>
      </div>

      {/* 7-Day Daily Telemetry Chart */}
      <div className="bg-slate-100 dark:bg-[#080d16] border border-slate-200 dark:border-transparent rounded-lg p-3.5 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-300/80 dark:border-slate-800/80 text-[11px]">
          {hoveredDay ? (
            <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-slate-900 dark:text-slate-200">
              <span className="font-sans font-bold text-teal-800 dark:text-teal-300">
                {hoveredDay.dayLabel} ({hoveredDay.shortDateLabel})
              </span>
              <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
                ·
              </span>
              <span>
                التنفس:{" "}
                {hoveredDay.respirationAvgBrpm !== null
                  ? `${hoveredDay.respirationAvgBrpm.toFixed(1)} BrPM`
                  : "--"}
              </span>
              <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
                ·
              </span>
              <span>
                التناغم:{" "}
                {hoveredDay.coherenceAvgPct !== null
                  ? `${hoveredDay.coherenceAvgPct.toFixed(1)}%`
                  : "--"}
              </span>
              <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
                ·
              </span>
              <span>الجلسات: {hoveredDay.sessionCount}</span>
            </div>
          ) : (
            <span className="text-slate-600 dark:text-slate-400">
              مرّر المؤشر فوق أي عمود يومي لعرض متوسط التنفس والتناغم وعدد الجلسات
            </span>
          )}

          {/* Explicit Chart Legend */}
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-700 dark:text-slate-300">
            {(channelView === "both" || channelView === "respiration") && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block w-3 h-0.5 bg-teal-700 dark:bg-teal-400"
                  aria-hidden="true"
                />
                <span>معدل التنفس (BrPM)</span>
              </span>
            )}
            {(channelView === "both" || channelView === "coherence") && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-xs bg-emerald-600/35 dark:bg-emerald-400/35 border border-emerald-700 dark:border-emerald-400"
                  aria-hidden="true"
                />
                <span>التناغم (%)</span>
              </span>
            )}
          </div>
        </div>

        {hasAnyWeeklyData ? (
          <div dir="ltr" className="w-full">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-48 select-none overflow-visible"
              role="img"
              aria-label="رسم بياني للمتوسطات اليومية للتنفس والتناغم خلال آخر 7 أيام"
            >
              {/* Normal Adult Resting Respiration Band (12-20 BrPM) */}
              {(channelView === "both" || channelView === "respiration") && (
                <g>
                  <rect
                    x={padL}
                    y={respBandTop}
                    width={plotW}
                    height={Math.max(0, respBandBottom - respBandTop)}
                    className="fill-teal-600/10 dark:fill-teal-400/10"
                  />
                  <text
                    x={padL + 6}
                    y={respBandTop + 11}
                    className="fill-teal-800 dark:fill-teal-300"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    Normal Resp 12–20 BrPM
                  </text>
                </g>
              )}

              {/* Coherence Target Line (60%) */}
              {(channelView === "both" || channelView === "coherence") && (
                <g>
                  <line
                    x1={padL}
                    y1={mapCohY(60)}
                    x2={width - padR}
                    y2={mapCohY(60)}
                    className="stroke-emerald-700 dark:stroke-emerald-400"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    strokeOpacity={0.7}
                  />
                  <text
                    x={width - padR - 4}
                    y={mapCohY(60) - 4}
                    textAnchor="end"
                    className="fill-emerald-800 dark:fill-emerald-300"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    Target ≥ 60%
                  </text>
                </g>
              )}

              {/* Horizontal Gridlines + Left/Right Axis Ticks */}
              {[0, 0.5, 1].map((frac) => {
                const y = padT + frac * plotH;
                const respTick = Math.round(
                  respMaxScale - frac * (respMaxScale - respMinScale)
                );
                const cohTick = Math.round(
                  cohMaxScale - frac * (cohMaxScale - cohMinScale)
                );
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
                    />
                    {(channelView === "both" || channelView === "respiration") && (
                      <text
                        x={padL - 6}
                        y={y + 3}
                        textAnchor="end"
                        className="fill-teal-800 dark:fill-teal-400"
                        fontSize="9"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {respTick}
                      </text>
                    )}
                    {(channelView === "both" || channelView === "coherence") && (
                      <text
                        x={width - padR + 6}
                        y={y + 3}
                        textAnchor="start"
                        className="fill-emerald-800 dark:fill-emerald-400"
                        fontSize="9"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {cohTick}%
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Axis Header Labels */}
              {(channelView === "both" || channelView === "respiration") && (
                <text
                  x={padL - 6}
                  y={10}
                  textAnchor="end"
                  className="fill-slate-600 dark:fill-slate-400"
                  fontSize="8"
                  fontFamily="JetBrains Mono, monospace"
                >
                  BrPM
                </text>
              )}
              {(channelView === "both" || channelView === "coherence") && (
                <text
                  x={width - padR + 6}
                  y={10}
                  textAnchor="start"
                  className="fill-slate-600 dark:fill-slate-400"
                  fontSize="8"
                  fontFamily="JetBrains Mono, monospace"
                >
                  COH
                </text>
              )}

              {/* Day Columns, Interactive Targets, Coherence Bars, Respiration Points */}
              {days.map((day, idx) => {
                const slotW = plotW / days.length;
                const cx = mapDayX(idx);
                const isHovered = hoveredDayIdx === idx;
                const barW = Math.min(26, slotW * 0.44);
                const cohVal = day.coherenceAvgPct;
                const cohY = cohVal !== null ? mapCohY(cohVal) : null;
                const barH = cohY !== null ? padT + plotH - cohY : 0;

                return (
                  <g
                    key={day.dateKey}
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredDayIdx(idx)}
                    onMouseLeave={() => setHoveredDayIdx(null)}
                  >
                    {/* Hover Backdrop Column */}
                    <rect
                      x={padL + slotW * idx + 2}
                      y={padT}
                      width={Math.max(4, slotW - 4)}
                      height={plotH}
                      rx={4}
                      className={
                        isHovered
                          ? "fill-slate-200/80 dark:fill-slate-800/65"
                          : "fill-transparent"
                      }
                    />

                    {/* Coherence Bar */}
                    {(channelView === "both" || channelView === "coherence") &&
                      cohY !== null && (
                        <rect
                          x={cx - barW / 2}
                          y={cohY}
                          width={barW}
                          height={Math.max(2, barH)}
                          rx={3}
                          className={`transition-opacity ${
                            isHovered
                              ? "fill-emerald-600/45 dark:fill-emerald-400/45 stroke-emerald-700 dark:stroke-emerald-300"
                              : "fill-emerald-600/25 dark:fill-emerald-400/25 stroke-emerald-700/75 dark:stroke-emerald-400/75"
                          }`}
                          strokeWidth={1.2}
                        />
                      )}

                    {/* X-Axis Day + Date Labels */}
                    <text
                      x={cx}
                      y={height - 15}
                      textAnchor="middle"
                      className={
                        day.isToday
                          ? "fill-cyan-800 dark:fill-cyan-300 font-bold"
                          : "fill-slate-700 dark:fill-slate-300"
                      }
                      fontSize="9"
                      fontFamily="IBM Plex Sans Arabic, sans-serif"
                    >
                      {day.dayLabel}
                    </text>
                    <text
                      x={cx}
                      y={height - 4}
                      textAnchor="middle"
                      className="fill-slate-500 dark:fill-slate-500"
                      fontSize="8"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      {day.shortDateLabel}
                    </text>
                  </g>
                );
              })}

              {/* Coherence Trend Polyline in Coherence-only mode */}
              {channelView === "coherence" && cohPoints.length >= 2 && (
                <polyline
                  fill="none"
                  className="stroke-emerald-700 dark:stroke-emerald-400"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={cohPolyline}
                />
              )}

              {/* Respiration Polyline + Min/Max Spread + Markers */}
              {(channelView === "both" || channelView === "respiration") && (
                <g className="pointer-events-none">
                  {respPoints.length >= 2 && (
                    <polyline
                      fill="none"
                      className="stroke-teal-700 dark:stroke-teal-400"
                      strokeWidth={2.2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      points={respPolyline}
                    />
                  )}
                  {respPoints.map((pt) => {
                    const isHovered = hoveredDayIdx === pt.idx;
                    const minVal = pt.day.respirationMinBrpm;
                    const maxVal = pt.day.respirationMaxBrpm;
                    return (
                      <g key={pt.day.dateKey}>
                        {channelView === "respiration" &&
                          minVal !== null &&
                          maxVal !== null &&
                          maxVal > minVal && (
                            <line
                              x1={pt.x}
                              y1={mapRespY(maxVal)}
                              x2={pt.x}
                              y2={mapRespY(minVal)}
                              className="stroke-teal-700/60 dark:stroke-teal-400/60"
                              strokeWidth={2}
                              strokeLinecap="round"
                            />
                          )}
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={isHovered ? 5.2 : 4}
                          className="fill-teal-700 dark:fill-teal-300 stroke-slate-100 dark:stroke-[#080d16]"
                          strokeWidth={1.6}
                        />
                      </g>
                    );
                  })}
                </g>
              )}
            </svg>
          </div>
        ) : (
          <div className="h-36 flex flex-col items-center justify-center text-center px-4">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-300">
              لا توجد قياسات مسجلة في آخر 7 أيام لعرض المنحنى الأسبوعي بعد.
            </p>
            <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
              سجّل جلستك الأولى وسيبدأ النظام تلقائياً بتجميع متوسطات التنفس
              والتناغم اليومية والأسبوعية.
            </p>
          </div>
        )}
      </div>

      {/* Compact 7-Day Clinical Monitoring Matrix */}
      <div className="border-t border-slate-200 dark:border-slate-800/80 pt-3">
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <h4 className="text-xs font-bold text-slate-900 dark:text-slate-200">
            التفصيل اليومي لآخر 7 أيام
          </h4>
          <span className="text-[11px] text-slate-600 dark:text-slate-400">
            النطاق المرجعي: تنفس 12–20 BrPM · تناغم ≥ 60%
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800/80 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                <th className="py-2 px-2.5">اليوم</th>
                <th className="py-2 px-2.5">التاريخ</th>
                <th className="py-2 px-2.5">الجلسات</th>
                <th className="py-2 px-2.5">متوسط التنفس</th>
                <th className="py-2 px-2.5">متوسط التناغم</th>
                <th className="py-2 px-2.5">الحالة السريرية</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/60">
              {days.map((day, idx) => {
                const clinicalNote = getDailyClinicalNote(day);
                const isHovered = hoveredDayIdx === idx;
                return (
                  <tr
                    key={day.dateKey}
                    onMouseEnter={() => setHoveredDayIdx(idx)}
                    onMouseLeave={() => setHoveredDayIdx(null)}
                    className={`transition-colors ${
                      isHovered
                        ? "bg-slate-100 dark:bg-slate-800/45"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/30"
                    }`}
                  >
                    <td className="py-2 px-2.5 font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {day.dayLabel}
                    </td>
                    <td
                      dir="ltr"
                      className="py-2 px-2.5 font-mono text-[11px] text-slate-600 dark:text-slate-400 tabular-nums text-right whitespace-nowrap"
                    >
                      {day.shortDateLabel}
                    </td>
                    <td
                      dir="ltr"
                      className="py-2 px-2.5 font-mono text-slate-800 dark:text-slate-200 tabular-nums text-right"
                    >
                      {day.sessionCount}
                    </td>
                    <td
                      dir="ltr"
                      className="py-2 px-2.5 font-mono font-semibold text-teal-800 dark:text-teal-300 tabular-nums text-right whitespace-nowrap"
                    >
                      {day.respirationAvgBrpm !== null
                        ? `${day.respirationAvgBrpm.toFixed(1)} BrPM`
                        : "—"}
                    </td>
                    <td
                      dir="ltr"
                      className="py-2 px-2.5 font-mono font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums text-right whitespace-nowrap"
                    >
                      {day.coherenceAvgPct !== null
                        ? `${day.coherenceAvgPct.toFixed(1)}%`
                        : "—"}
                    </td>
                    <td className={`py-2 px-2.5 font-medium whitespace-nowrap ${clinicalNote.cls}`}>
                      {clinicalNote.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
