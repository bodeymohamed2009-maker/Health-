import { Activity, Download, Trash2 } from "lucide-react";
import type { SessionReading } from "../types/rppg";

interface SessionLogTableProps {
  readings: SessionReading[];
  onExportCsv: () => void;
  onClear: () => void;
}

function formatModeLabel(mode: SessionReading["mode"]): string {
  if (mode === "finger") return "الإصبع (PPG)";
  return "الوجه (rPPG)";
}

export function SessionLogTable({
  readings,
  onExportCsv,
  onClear,
}: SessionLogTableProps) {
  return (
    <section
      id="history"
      className="max-w-7xl mx-auto px-6 py-10 border-t border-slate-300 dark:border-slate-800/80"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-slate-950 dark:text-white tracking-tight">
              سجل القياسات السريرية المحفوظة
            </h2>
            {readings.length > 0 && (
              <>
                <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span
                  dir="ltr"
                  className="font-mono text-xs text-cyan-700 dark:text-cyan-300 tabular-nums font-semibold"
                >
                  {readings.length} {readings.length === 1 ? "session" : "sessions"}
                </span>
              </>
            )}
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
            القراءات المسجلة محلياً مع مؤشر بوانكاريه SD1 والتناغم التنفسي وجودة الطيف SNR
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {readings.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 dark:text-slate-300 bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-700/80 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>مسح السجل</span>
            </button>
          )}
          <button
            type="button"
            onClick={onExportCsv}
            disabled={readings.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-cyan-700 hover:bg-cyan-800 disabled:bg-slate-200 disabled:text-slate-500 dark:text-slate-950 dark:bg-cyan-400 dark:hover:bg-cyan-300 dark:disabled:bg-slate-800 dark:disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>تصدير CSV</span>
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-[#0c1322] border border-slate-300 dark:border-slate-800/90 rounded-xl overflow-hidden">
        {readings.length === 0 ? (
          <div className="py-10 px-6 flex flex-col items-center justify-center text-center gap-2">
            <Activity className="w-6 h-6 text-slate-500 dark:text-slate-600" />
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-300">
              لا توجد قراءات محفوظة بعد
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-400 max-w-md leading-relaxed">
              شغّل القياس البصري وسيتم تسجيل القراءة تلقائياً عند اكتمال المدة أو
              عند الضغط على «حفظ لقطة القراءة الحالية».
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="bg-slate-100 dark:bg-[#080d16] border-b border-slate-300 dark:border-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-400">
                  <th className="py-3 px-4">الوقت</th>
                  <th className="py-3 px-4">النمط</th>
                  <th className="py-3 px-4">الخوارزمية</th>
                  <th className="py-3 px-4">النبض (BPM)</th>
                  <th className="py-3 px-4">التنفس (BrPM)</th>
                  <th className="py-3 px-4">التناغم</th>
                  <th className="py-3 px-4">RMSSD / SD1</th>
                  <th className="py-3 px-4">SNR</th>
                  <th className="py-3 px-4">المدة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70 text-sm">
                {readings.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/35 transition-colors"
                  >
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-slate-600 dark:text-slate-400 tabular-nums text-right"
                    >
                      {row.timestamp}
                    </td>
                    <td className="py-3 px-4 text-xs font-medium text-slate-900 dark:text-slate-200">
                      {formatModeLabel(row.mode)}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700 dark:text-slate-300">
                      {row.algorithm}
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono font-bold text-cyan-800 dark:text-cyan-300 tabular-nums text-right"
                    >
                      {row.bpm} BPM
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono font-semibold text-teal-800 dark:text-teal-300 tabular-nums text-right"
                    >
                      {row.respirationBrpm !== null
                        ? `${row.respirationBrpm} BrPM`
                        : "—"}
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums text-right"
                    >
                      {row.coherencePct !== null
                        ? `${row.coherencePct}%`
                        : "—"}
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-slate-800 dark:text-slate-300 tabular-nums text-right"
                    >
                      {row.rmssdMs !== null ? `${row.rmssdMs}` : "—"} /{" "}
                      {row.sd1Ms !== null ? `${row.sd1Ms} ms` : "—"}
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-slate-800 dark:text-slate-300 tabular-nums text-right"
                    >
                      {row.snrDb.toFixed(1)} dB
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-slate-600 dark:text-slate-400 tabular-nums text-right"
                    >
                      {row.durationSec}s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
