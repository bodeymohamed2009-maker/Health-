import { useState } from "react";
import type { PoincarePoint } from "../types/rppg";

interface PoincarePlotProps {
  points: PoincarePoint[];
  sd1Ms: number | null;
  sd2Ms: number | null;
  coherencePct: number | null;
}

export function PoincarePlot({
  points,
  sd1Ms,
  sd2Ms,
  coherencePct,
}: PoincarePlotProps) {
  const [hovered, setHovered] = useState<PoincarePoint | null>(null);

  const size = 280;
  const pad = 34;
  const plot = size - pad * 2;
  const minIbi = 400;
  const maxIbi = 1250;

  const mapCoord = (val: number) => {
    const clamped = Math.max(minIbi, Math.min(maxIbi, val));
    return ((clamped - minIbi) / (maxIbi - minIbi)) * plot;
  };

  const hasPoints = points.length >= 2;
  const meanIbi = hasPoints
    ? points.reduce((acc, p) => acc + p.ibiN, 0) / points.length
    : 800;

  const cx = pad + mapCoord(meanIbi);
  const cy = size - pad - mapCoord(meanIbi);
  const rx = sd2Ms ? Math.max(8, (sd2Ms / (maxIbi - minIbi)) * plot * 1.4) : 14;
  const ry = sd1Ms ? Math.max(6, (sd1Ms / (maxIbi - minIbi)) * plot * 1.4) : 10;

  return (
    <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700/90 transition-colors duration-200 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-950 dark:text-white tracking-tight">
            مخطط بوانكاريه للتوازن العصبي (Poincaré Plot)
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
            العلاقة بين نبضة وأخرى (SD1 للعصب الحائر · SD2 للتوازن الكلي)
          </p>
        </div>

        <div
          dir="ltr"
          className="text-xs font-mono tabular-nums text-cyan-700 dark:text-cyan-300 shrink-0 pt-0.5 font-semibold"
        >
          {hovered
            ? `(${hovered.ibiN}, ${hovered.ibiNext}) ms`
            : sd1Ms !== null && sd2Ms !== null
            ? `SD1 ${sd1Ms} · SD2 ${sd2Ms} ms`
            : "Awaiting ≥4 beats"}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-12 gap-5 items-center">
        <div dir="ltr" className="sm:col-span-7 flex justify-center">
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className="w-full max-w-[260px] aspect-square bg-slate-100 dark:bg-[#080d16] border border-slate-200 dark:border-transparent rounded-lg select-none block"
          >
            {/* Grid lines */}
            {[500, 750, 1000].map((ms) => {
              const p = mapCoord(ms);
              return (
                <g key={ms}>
                  <line
                    x1={pad + p}
                    y1={pad}
                    x2={pad + p}
                    y2={size - pad}
                    className="stroke-slate-300 dark:stroke-slate-800"
                    strokeWidth={0.75}
                    strokeDasharray="3 3"
                    strokeOpacity={0.85}
                  />
                  <line
                    x1={pad}
                    y1={size - pad - p}
                    x2={size - pad}
                    y2={size - pad - p}
                    className="stroke-slate-300 dark:stroke-slate-800"
                    strokeWidth={0.75}
                    strokeDasharray="3 3"
                    strokeOpacity={0.85}
                  />
                  <text
                    x={pad + p}
                    y={size - 12}
                    textAnchor="middle"
                    className="fill-slate-600 dark:fill-slate-400"
                    fontSize="9"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {ms}
                  </text>
                  <text
                    x={pad - 6}
                    y={size - pad - p + 3}
                    textAnchor="end"
                    className="fill-slate-600 dark:fill-slate-400"
                    fontSize="9"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {ms}
                  </text>
                </g>
              );
            })}

            {/* Axis boundary */}
            <rect
              x={pad}
              y={pad}
              width={plot}
              height={plot}
              fill="none"
              className="stroke-slate-400 dark:stroke-slate-700"
              strokeOpacity={0.75}
              strokeWidth={0.9}
            />

            {/* Identity diagonal IBI[n] = IBI[n+1] */}
            <line
              x1={pad}
              y1={size - pad}
              x2={size - pad}
              y2={pad}
              className="stroke-slate-500 dark:stroke-slate-600"
              strokeOpacity={0.75}
              strokeWidth={1}
              strokeDasharray="4 3"
            />

            {hasPoints ? (
              <>
                <ellipse
                  cx={cx}
                  cy={cy}
                  rx={rx}
                  ry={ry}
                  transform={`rotate(-45 ${cx} ${cy})`}
                  className="fill-cyan-600/15 dark:fill-cyan-500/15 stroke-cyan-700 dark:stroke-cyan-400"
                  strokeWidth={1.35}
                />

                {points.map((pt, i) => {
                  const px = pad + mapCoord(pt.ibiN);
                  const py = size - pad - mapCoord(pt.ibiNext);
                  const isHovered = hovered === pt;
                  return (
                    <g key={`${i}-${pt.ibiN}`}>
                      {isHovered && (
                        <circle
                          cx={px}
                          cy={py}
                          r={6.5}
                          className="fill-emerald-700/20 dark:fill-emerald-500/25"
                        />
                      )}
                      <circle
                        cx={px}
                        cy={py}
                        r={isHovered ? 4.2 : 3}
                        className={`cursor-pointer stroke-slate-100 dark:stroke-[#080d16] ${
                          isHovered
                            ? "fill-emerald-600 dark:fill-emerald-400"
                            : "fill-emerald-700 dark:fill-emerald-500"
                        }`}
                        strokeWidth={1}
                        onMouseEnter={() => setHovered(pt)}
                        onMouseLeave={() => setHovered(null)}
                      />
                    </g>
                  );
                })}
              </>
            ) : (
              <text
                x={size / 2}
                y={size / 2}
                textAnchor="middle"
                className="fill-slate-600 dark:fill-slate-400"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                Collecting IBI pairs...
              </text>
            )}
          </svg>
        </div>

        {/* Hairline-Divided Autonomic Telemetry Breakdown (No Nested Boxes) */}
        <div className="sm:col-span-5 flex flex-col divide-y divide-slate-200 dark:divide-slate-800/80 bg-slate-100 dark:bg-[#080d16] border border-slate-200 dark:border-transparent rounded-lg px-4 py-1">
          <div className="py-3">
            <span className="block text-[11px] text-slate-600 dark:text-slate-400 font-medium">
              النشاط الباراسمبثاوي (SD1)
            </span>
            <div dir="ltr" className="mt-1 flex items-baseline gap-1.5">
              <span className="font-mono text-xl font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
                {sd1Ms !== null ? sd1Ms : "--"}
              </span>
              <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400 uppercase">
                ms
              </span>
            </div>
          </div>

          <div className="py-3">
            <span className="block text-[11px] text-slate-600 dark:text-slate-400 font-medium">
              التباين طويل المدى (SD2)
            </span>
            <div dir="ltr" className="mt-1 flex items-baseline gap-1.5">
              <span className="font-mono text-xl font-bold text-cyan-700 dark:text-cyan-400 tabular-nums">
                {sd2Ms !== null ? sd2Ms : "--"}
              </span>
              <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400 uppercase">
                ms
              </span>
            </div>
          </div>

          <div className="py-3">
            <span className="block text-[11px] text-slate-600 dark:text-slate-400 font-medium">
              تناغم القلب والتنفس (Coherence)
            </span>
            <div dir="ltr" className="mt-1 flex items-baseline gap-1.5">
              <span className="font-mono text-xl font-bold text-teal-700 dark:text-teal-300 tabular-nums">
                {coherencePct !== null ? coherencePct : "--"}
              </span>
              <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400 uppercase">
                %
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
