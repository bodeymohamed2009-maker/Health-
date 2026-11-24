import { extractReadingDateKey, getLocalDateKey } from "./hydrationAlerts";
import type { SessionReading } from "../types/rppg";

export interface DailyWeeklyBucket {
  dateKey: string;
  dayLabel: string;
  shortDateLabel: string;
  isToday: boolean;
  sessionCount: number;
  respirationAvgBrpm: number | null;
  respirationMinBrpm: number | null;
  respirationMaxBrpm: number | null;
  respirationSamples: number;
  coherenceAvgPct: number | null;
  coherenceMinPct: number | null;
  coherenceMaxPct: number | null;
  coherenceSamples: number;
}

export type WeeklyRespirationStatus =
  | "normal"
  | "bradypnea"
  | "tachypnea"
  | "insufficient";

export type WeeklyCoherenceStatus =
  | "optimal"
  | "moderate"
  | "low"
  | "insufficient";

export interface WeeklyAveragesSummary {
  days: DailyWeeklyBucket[];
  windowStartLabel: string;
  windowEndLabel: string;
  activeDaysCount: number;
  totalSessionsCount: number;
  respiration: {
    weeklyAvgBrpm: number | null;
    minBrpm: number | null;
    maxBrpm: number | null;
    sampleCount: number;
    deltaVsPrevWeekBrpm: number | null;
    status: WeeklyRespirationStatus;
    statusLabel: string;
    clinicalNote: string;
  };
  coherence: {
    weeklyAvgPct: number | null;
    minPct: number | null;
    maxPct: number | null;
    sampleCount: number;
    deltaVsPrevWeekPct: number | null;
    status: WeeklyCoherenceStatus;
    statusLabel: string;
    clinicalNote: string;
  };
}

const ARABIC_WEEKDAYS = [
  "الأحد",
  "الإثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

function formatShortDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}`;
}

function classifyWeeklyRespiration(avgBrpm: number | null): {
  status: WeeklyRespirationStatus;
  statusLabel: string;
  clinicalNote: string;
} {
  if (avgBrpm === null) {
    return {
      status: "insufficient",
      statusLabel: "بانتظار بيانات التنفس",
      clinicalNote:
        "تظهر تقييمات معدل التنفس الأسبوعي تلقائياً بعد حفظ جلسات تحتوي على قراءة BrPM صالحة (مدة ≥ 15 ثانية).",
    };
  }
  if (avgBrpm < 12) {
    return {
      status: "bradypnea",
      statusLabel: "أبطأ من المعدل (< 12 BrPM)",
      clinicalNote:
        "المتوسط الأسبوعي أقل من النطاق المرجعي للبالغين (12–20 نفس/دقيقة)؛ قد يعكس تنفساً بطيئاً عميقاً أو يستدعي مراجعة ظروف القياس.",
    };
  }
  if (avgBrpm > 20) {
    return {
      status: "tachypnea",
      statusLabel: "أسرع من المعدل (> 20 BrPM)",
      clinicalNote:
        "المتوسط الأسبوعي أعلى من النطاق المرجعي للراحة (12–20 نفس/دقيقة)؛ يُنصح بمراقبة الإجهاد التنفسي وإعادة الفحص في وضع راحة تام.",
    };
  }
  return {
    status: "normal",
    statusLabel: "ضمن النطاق الطبيعي (12–20 BrPM)",
    clinicalNote:
      "معدل التنفس الأسبوعي مستقر داخل المدى الفسيولوجي الطبيعي للراحة عند البالغين (12–20 نفس/دقيقة).",
  };
}

function classifyWeeklyCoherence(avgPct: number | null): {
  status: WeeklyCoherenceStatus;
  statusLabel: string;
  clinicalNote: string;
} {
  if (avgPct === null) {
    return {
      status: "insufficient",
      statusLabel: "بانتظار بيانات التناغم",
      clinicalNote:
        "يُحسب متوسط التناغم القلبي التنفسي الأسبوعي بمجرد تسجيل جلسات تتضمن استخلاص فترات النبض IBI بنجاح.",
    };
  }
  if (avgPct >= 60) {
    return {
      status: "optimal",
      statusLabel: "تناغم عالٍ ومتزن (≥ 60%)",
      clinicalNote:
        "يشير المتوسط الأسبوعي إلى اقتران جيد بين إيقاع التنفس وتقلب نبض القلب (RSA) وكفاءة عالية في التعافي العصبي.",
    };
  }
  if (avgPct >= 40) {
    return {
      status: "moderate",
      statusLabel: "تناغم متوسط (40–59%)",
      clinicalNote:
        "تناغم قلبي تنفسي متوسط خلال الأسبوع؛ يمكن رفعه فوق 60% عبر جلسات تنفس بطيء منتظمة (6 أنفاس/دقيقة).",
    };
  }
  return {
    status: "low",
    statusLabel: "تناغم منخفض (< 40%)",
    clinicalNote:
      "انخفاض أسبوعي في التناغم القلبي التنفسي؛ يُنصح بمراقبة الإجهاد العام وضبط جودة الإشارة وتكرار تمارين التهدئة التنفسية.",
  };
}

/**
 * Computes rolling 7-day clinical averages for respiration rate (BrPM) and
 * autonomic cardiorespiratory coherence (%) from persisted local sessions,
 * plus comparison against the prior 7-day window when earlier history exists.
 */
export function analyzeWeeklyAverages(
  readings: SessionReading[],
  referenceDate: Date = new Date()
): WeeklyAveragesSummary {
  const baseDate = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate()
  );

  const currentWindowKeys: Array<{
    dateKey: string;
    dayLabel: string;
    shortDateLabel: string;
    isToday: boolean;
  }> = [];

  for (let offset = -6; offset <= 0; offset++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + offset);
    currentWindowKeys.push({
      dateKey: getLocalDateKey(d),
      dayLabel: offset === 0 ? "اليوم" : ARABIC_WEEKDAYS[d.getDay()],
      shortDateLabel: formatShortDate(d),
      isToday: offset === 0,
    });
  }

  const prevWindowKeySet = new Set<string>();
  for (let offset = -13; offset <= -7; offset++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + offset);
    prevWindowKeySet.add(getLocalDateKey(d));
  }

  const byDate = new Map<string, SessionReading[]>();
  for (const bucket of currentWindowKeys) {
    byDate.set(bucket.dateKey, []);
  }

  const prevRespValues: number[] = [];
  const prevCohValues: number[] = [];

  for (const reading of readings) {
    const key = extractReadingDateKey(reading);
    const list = byDate.get(key);
    if (list) {
      list.push(reading);
    } else if (prevWindowKeySet.has(key)) {
      if (
        reading.respirationBrpm !== null &&
        Number.isFinite(reading.respirationBrpm)
      ) {
        prevRespValues.push(reading.respirationBrpm);
      }
      if (
        reading.coherencePct !== null &&
        Number.isFinite(reading.coherencePct)
      ) {
        prevCohValues.push(reading.coherencePct);
      }
    }
  }

  const allWeekResp: number[] = [];
  const allWeekCoh: number[] = [];
  let activeDaysCount = 0;
  let totalSessionsCount = 0;

  const days: DailyWeeklyBucket[] = currentWindowKeys.map((meta) => {
    const dayReadings = byDate.get(meta.dateKey) ?? [];
    if (dayReadings.length > 0) activeDaysCount++;
    totalSessionsCount += dayReadings.length;

    const respVals = dayReadings
      .map((r) => r.respirationBrpm)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const cohVals = dayReadings
      .map((r) => r.coherencePct)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    allWeekResp.push(...respVals);
    allWeekCoh.push(...cohVals);

    const respMean = mean(respVals);
    const cohMean = mean(cohVals);

    return {
      dateKey: meta.dateKey,
      dayLabel: meta.dayLabel,
      shortDateLabel: meta.shortDateLabel,
      isToday: meta.isToday,
      sessionCount: dayReadings.length,
      respirationAvgBrpm: respMean !== null ? round1(respMean) : null,
      respirationMinBrpm:
        respVals.length > 0 ? round1(Math.min(...respVals)) : null,
      respirationMaxBrpm:
        respVals.length > 0 ? round1(Math.max(...respVals)) : null,
      respirationSamples: respVals.length,
      coherenceAvgPct: cohMean !== null ? round1(cohMean) : null,
      coherenceMinPct:
        cohVals.length > 0 ? Math.round(Math.min(...cohVals)) : null,
      coherenceMaxPct:
        cohVals.length > 0 ? Math.round(Math.max(...cohVals)) : null,
      coherenceSamples: cohVals.length,
    };
  });

  const weeklyRespRaw = mean(allWeekResp);
  const weeklyRespAvgBrpm =
    weeklyRespRaw !== null ? round1(weeklyRespRaw) : null;
  const prevRespRaw = mean(prevRespValues);
  const deltaVsPrevWeekBrpm =
    weeklyRespRaw !== null && prevRespRaw !== null
      ? round1(weeklyRespRaw - prevRespRaw)
      : null;

  const weeklyCohRaw = mean(allWeekCoh);
  const weeklyCoherenceAvgPct =
    weeklyCohRaw !== null ? round1(weeklyCohRaw) : null;
  const prevCohRaw = mean(prevCohValues);
  const deltaVsPrevWeekPct =
    weeklyCohRaw !== null && prevCohRaw !== null
      ? round1(weeklyCohRaw - prevCohRaw)
      : null;

  const respStatus = classifyWeeklyRespiration(weeklyRespAvgBrpm);
  const cohStatus = classifyWeeklyCoherence(weeklyCoherenceAvgPct);

  return {
    days,
    windowStartLabel: currentWindowKeys[0].shortDateLabel,
    windowEndLabel: currentWindowKeys[currentWindowKeys.length - 1].shortDateLabel,
    activeDaysCount,
    totalSessionsCount,
    respiration: {
      weeklyAvgBrpm: weeklyRespAvgBrpm,
      minBrpm: allWeekResp.length > 0 ? round1(Math.min(...allWeekResp)) : null,
      maxBrpm: allWeekResp.length > 0 ? round1(Math.max(...allWeekResp)) : null,
      sampleCount: allWeekResp.length,
      deltaVsPrevWeekBrpm,
      ...respStatus,
    },
    coherence: {
      weeklyAvgPct: weeklyCoherenceAvgPct,
      minPct: allWeekCoh.length > 0 ? Math.round(Math.min(...allWeekCoh)) : null,
      maxPct: allWeekCoh.length > 0 ? Math.round(Math.max(...allWeekCoh)) : null,
      sampleCount: allWeekCoh.length,
      deltaVsPrevWeekPct,
      ...cohStatus,
    },
  };
}
