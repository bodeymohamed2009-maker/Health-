import { useState } from "react";
import type { SpectrumBin } from "../types/rppg";

interface SpectrumChartProps {
  spectrum: SpectrumBin[];
  dominantFreqHz: number | null;
  bpm: number | null;
}

export function SpectrumChart({
  spectrum,
  dominantFreqHz,
  bpm,
}: SpectrumChartProps) {
  const [hoverBin, setHoverBin] = useState<SpectrumBin | null>(null);

  const width = 560;
  const height = 188;
  const padX = 28;
  const padTop = 18;
  const padBottom = 26;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;

  const minFreq = 0.6;
  const maxFreq = 3.5;

  const hasData = spectrum.length > 2;

  const mapX = (freq: number) =>
    padX + ((freq - minFreq) / (maxFreq - minFreq)) * plotW;
  const mapY = (power: number) =>
    padTop + (1 - Math.min(1, Math.max(0, power))) * plotH;

  const polylinePoints = hasData
    ? spectrum
        .map((bin) => `${mapX(bin.freqHz).toFixed(1)},${mapY(bin.power).toFixed(1)}`)
        .join(" ")
    : "";

  const areaPoints = hasData
    ? `${padX},${padTop + plotH} ${polylinePoints} ${(padX + plotW).toFixed(1)},${
        padTop + plotH
      }`
    : "";

  const peakX = dominantFreqHz !== null ? mapX(dominantFreqHz) : null;

  // Normal resting heart-rate band shading (0.85 Hz – 2.0 Hz ≈ 51–120 BPM)
  const restBandX0 = mapX(0.85);
  const restBandX1 = mapX(2.0);

  return (
    <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 hover:border-slate-400 dark:hover:border-slate-700/90 transition-colors duration-200 rounded-xl p-5 flex flex-col gap-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-950 dark:text-white tracking-tight">
            التحليل الطيفي (1024-pt FFT Spectrum)
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
            الطاقة الترددية للنبض بين 36 و 210 نبضة/دقيقة
          </p>
        </div>

        <div
          dir="ltr"
          className="text-xs font-mono tabular-nums text-cyan-700 dark:text-cyan-300 shrink-0 pt-0.5 font-semibold"
        >
          {hoverBin
            ? `${hoverBin.freqHz.toFixed(2)} Hz · ${hoverBin.bpm} BPM`
            : dominantFreqHz && bpm
            ? `Peak ${dominantFreqHz.toFixed(2)} Hz · ${bpm} BPM`
            : "0.60 – 3.50 Hz"}
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
            const targetFreq =
              minFreq +
              Math.max(0, Math.min(1, (relX * width - padX) / plotW)) *
                (maxFreq - minFreq);
            let nearest = spectrum[0];
            let bestDist = Infinity;
            for (const b of spectrum) {
              const d = Math.abs(b.freqHz - targetFreq);
              if (d < bestDist) {
                bestDist = d;
                nearest = b;
              }
            }
            setHoverBin(nearest);
          }}
          onMouseLeave={() => setHoverBin(null)}
        >
          <defs>
            <linearGradient
              id="fftAreaGrad"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
              className="text-cyan-700 dark:text-cyan-400"
            >
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Subtle resting cardiac band tint */}
          <rect
            x={restBandX0}
            y={padTop}
            width={restBandX1 - restBandX0}
            height={plotH}
            className="fill-emerald-600/8 dark:fill-emerald-500/5"
          />

          {[0, 0.5, 1].map((frac) => (
            <line
              key={frac}
              x1={padX}
              y1={padTop + plotH * frac}
              x2={width - padX}
              y2={padTop + plotH * frac}
              className="stroke-slate-300 dark:stroke-slate-800"
              strokeWidth={frac === 1 ? 1 : 0.75}
              strokeOpacity={0.85}
            />
          ))}

          {[1.0, 1.5, 2.0, 2.5, 3.0].map((hz) => {
            const x = mapX(hz);
            return (
              <g key={hz}>
                <line
                  x1={x}
                  y1={padTop}
                  x2={x}
                  y2={padTop + plotH}
                  className="stroke-slate-300 dark:stroke-slate-800"
                  strokeWidth={0.75}
                  strokeDasharray="2 4"
                  strokeOpacity={0.75}
                />
                <text
                  x={x}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-slate-600 dark:fill-slate-400"
                  fontSize="9.5"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {hz.toFixed(1)}Hz ({Math.round(hz * 60)})
                </text>
              </g>
            );
          })}

          {hasData ? (
            <>
              <polygon fill="url(#fftAreaGrad)" points={areaPoints} />
              <polyline
                fill="none"
                className="stroke-cyan-700 dark:stroke-cyan-400"
                strokeWidth="2.1"
                strokeLinejoin="round"
                points={polylinePoints}
              />

              {peakX !== null && (
                <g>
                  <line
                    x1={peakX}
                    y1={padTop}
                    x2={peakX}
                    y2={padTop + plotH}
                    className="stroke-emerald-700 dark:stroke-emerald-500"
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                  />
                  <circle
                    cx={peakX}
                    cy={padTop + 4}
                    r={4.5}
                    className="fill-emerald-700/20 dark:fill-emerald-500/25"
                  />
                  <circle
                    cx={peakX}
                    cy={padTop + 4}
                    r={2.9}
                    className="fill-emerald-700 dark:fill-emerald-500"
                  />
                </g>
              )}

              {hoverBin && (
                <g>
                  <line
                    x1={mapX(hoverBin.freqHz)}
                    y1={padTop}
                    x2={mapX(hoverBin.freqHz)}
                    y2={padTop + plotH}
                    className="stroke-slate-600 dark:stroke-slate-400"
                    strokeWidth={0.9}
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={mapX(hoverBin.freqHz)}
                    cy={mapY(hoverBin.power)}
                    r={3.8}
                    className="fill-slate-900 dark:fill-slate-50 stroke-cyan-700 dark:stroke-cyan-400"
                    strokeWidth={1.8}
                  />
                </g>
              )}
            </>
          ) : (
            <text
              x={width / 2}
              y={height / 2 - 4}
              textAnchor="middle"
              className="fill-slate-600 dark:fill-slate-400"
              fontSize="11.5"
              fontFamily="JetBrains Mono, monospace"
            >
              Computing Welch FFT spectrum...
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
