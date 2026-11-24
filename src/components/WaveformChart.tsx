import { useState } from "react";

interface WaveformChartProps {
  waveform: number[];
  peakIndices: number[];
  fps: number;
}

export function WaveformChart({
  waveform,
  peakIndices,
  fps,
}: WaveformChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 560;
  const height = 188;
  const padX = 16;
  const padY = 18;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const hasData = waveform.length >= 4;

  const coords = hasData
    ? waveform.map((val, i) => {
        const x = padX + (i / (waveform.length - 1)) * plotW;
        const clamped = Math.max(-3, Math.min(3, val));
        const y = padY + ((3 - clamped) / 6) * plotH;
        return { x, y, val };
      })
    : [];

  const points = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPoints = hasData
    ? `${padX},${padY + plotH} ${points} ${(padX + plotW).toFixed(1)},${padY + plotH}`
    : "";

  const hoveredCoord =
    hoverIdx !== null && hasData && coords[hoverIdx] ? coords[hoverIdx] : null;

  return (
    <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700/90 transition-colors duration-200 rounded-xl p-5 flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-950 dark:text-white tracking-tight">
            موجة النبض الفلترية (BVP Oscilloscope)
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
            نطاق التمرير 0.70–3.50 Hz · رصد القمم الانقباضية
          </p>
        </div>

        <div
          dir="ltr"
          className="text-xs font-mono tabular-nums text-cyan-700 dark:text-cyan-300 shrink-0 pt-0.5 font-semibold"
        >
          {hoveredCoord !== null
            ? `amp ${hoveredCoord.val >= 0 ? "+" : ""}${hoveredCoord.val.toFixed(2)}σ`
            : `${waveform.length} pts · ${fps || 30} Hz`}
        </div>
      </div>

      <div
        dir="ltr"
        className="relative w-full rounded-lg overflow-hidden bg-slate-100 dark:bg-[#080d16] border border-slate-200 dark:border-transparent"
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-44 cursor-crosshair select-none block"
          onMouseMove={(e) => {
            if (!hasData) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = (e.clientX - rect.left) / rect.width;
            const norm = Math.max(0, Math.min(1, (relX * width - padX) / plotW));
            setHoverIdx(Math.round(norm * (waveform.length - 1)));
          }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient
              id="bvpFillGrad"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
              className="text-cyan-700 dark:text-cyan-400"
            >
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>

          {[0.25, 0.5, 0.75].map((frac) => (
            <line
              key={frac}
              x1={padX}
              y1={padY + plotH * frac}
              x2={width - padX}
              y2={padY + plotH * frac}
              className="stroke-slate-300 dark:stroke-slate-800"
              strokeWidth={frac === 0.5 ? 1 : 0.75}
              strokeDasharray={frac === 0.5 ? undefined : "3 4"}
              strokeOpacity={frac === 0.5 ? 0.9 : 0.7}
            />
          ))}

          {[0.2, 0.4, 0.6, 0.8].map((frac) => (
            <line
              key={frac}
              x1={padX + plotW * frac}
              y1={padY}
              x2={padX + plotW * frac}
              y2={height - padY}
              className="stroke-slate-300 dark:stroke-slate-800"
              strokeWidth={0.75}
              strokeDasharray="2 4"
              strokeOpacity={0.65}
            />
          ))}

          {hasData ? (
            <>
              <polygon fill="url(#bvpFillGrad)" points={areaPoints} />

              {/* Subtle luminance halo under main signal trace */}
              <polyline
                fill="none"
                className="stroke-cyan-600/20 dark:stroke-cyan-400/20"
                strokeWidth="4.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={points}
              />

              <polyline
                fill="none"
                className="stroke-cyan-700 dark:stroke-cyan-400"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={points}
              />

              {peakIndices.map((idx) => {
                const pt = coords[idx];
                if (!pt) return null;
                return (
                  <g key={idx}>
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={5}
                      className="fill-emerald-700/20 dark:fill-emerald-500/25"
                    />
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r={2.9}
                      className="fill-emerald-700 dark:fill-emerald-500 stroke-slate-100 dark:stroke-[#080d16]"
                      strokeWidth={1.2}
                    />
                  </g>
                );
              })}

              {hoveredCoord && (
                <g>
                  <line
                    x1={hoveredCoord.x}
                    y1={padY}
                    x2={hoveredCoord.x}
                    y2={height - padY}
                    className="stroke-slate-600 dark:stroke-slate-400"
                    strokeWidth={0.9}
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={hoveredCoord.x}
                    cy={hoveredCoord.y}
                    r={4}
                    className="fill-slate-900 dark:fill-slate-50 stroke-cyan-700 dark:stroke-cyan-400"
                    strokeWidth={1.8}
                  />
                </g>
              )}
            </>
          ) : (
            <text
              x={width / 2}
              y={height / 2}
              textAnchor="middle"
              className="fill-slate-600 dark:fill-slate-400"
              fontSize="11.5"
              fontFamily="JetBrains Mono, monospace"
            >
              Awaiting optical pulse acquisition...
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
