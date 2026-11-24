import { getAgeAdjustedNorms } from "./hrvTrends";
import type { BiometricProfile, RppgMetrics, SessionReading } from "../types/rppg";

export type HrvFeedbackTone =
  | "optimal"
  | "good"
  | "respiratory"
  | "caution"
  | "pending";

export interface HrvInsightChip {
  label: string;
  value: string;
  status: "good" | "warn" | "neutral";
}

export interface HrvSmartAlert {
  id: string;
  tone: HrvFeedbackTone;
  badgeLabel: string;
  headline: string;
  guidance: string;
  chips: HrvInsightChip[];
  isLiveReliable: boolean;
  ageCalibrated: boolean;
}

export interface HrvInsightsInput {
  metrics: RppgMetrics;
  profile?: BiometricProfile;
  readings?: SessionReading[];
  isRunning: boolean;
  isPausedByZone: boolean;
}

function buildMetricChips(
  rmssdMs: number | null,
  coherencePct: number | null,
  sdRatio: number | null,
  lfHfRatio: number | null | undefined,
  rmssdFloorMs: number
): HrvInsightChip[] {
  const chips: HrvInsightChip[] = [];

  if (rmssdMs !== null) {
    chips.push({
      label: "RMSSD",
      value: `${rmssdMs} ms`,
      status: rmssdMs >= rmssdFloorMs ? "good" : "warn",
    });
  }
  if (coherencePct !== null) {
    chips.push({
      label: "التناغم",
      value: `${coherencePct}%`,
      status: coherencePct >= 55 ? "good" : "warn",
    });
  }
  if (lfHfRatio !== null && lfHfRatio !== undefined) {
    chips.push({
      label: "LF/HF",
      value: `${lfHfRatio}`,
      status: lfHfRatio <= 2.4 ? "good" : "warn",
    });
  } else if (sdRatio !== null) {
    chips.push({
      label: "SD2/SD1",
      value: `${sdRatio}`,
      status: sdRatio <= 2.5 ? "good" : "warn",
    });
  }

  return chips;
}

export function evaluateHrvSmartAlert({
  metrics,
  profile,
  readings = [],
  isRunning,
  isPausedByZone,
}: HrvInsightsInput): HrvSmartAlert {
  const norms = getAgeAdjustedNorms(profile?.age);
  const ageCalibrated = Boolean(profile?.age && profile.age >= 8 && profile.age <= 110);

  if (isRunning && isPausedByZone) {
    return {
      id: "paused-zone",
      tone: "pending",
      badgeLabel: "متوقف مؤقتاً",
      headline: "التنبيهات متوقفة مؤقتاً لحين عودة الوجه في الكادر",
      guidance:
        "أعد تثبيت موضعك أمام الكاميرا لاستئناف تحليل تقلب النبض HRV وإصدار التقييم الذكي.",
      chips: [],
      isLiveReliable: false,
      ageCalibrated,
    };
  }

  const hasReading = metrics.bpm !== null && metrics.rmssdMs !== null;

  if (!isRunning && !hasReading) {
    const lastWithHrv = readings.find((r) => r.rmssdMs !== null);
    if (lastWithHrv && lastWithHrv.rmssdMs !== null) {
      const lastSdRatio =
        lastWithHrv.sd1Ms && lastWithHrv.sd2Ms && lastWithHrv.sd1Ms > 0
          ? Number((lastWithHrv.sd2Ms / lastWithHrv.sd1Ms).toFixed(2))
          : null;
      const chips = buildMetricChips(
        lastWithHrv.rmssdMs,
        lastWithHrv.coherencePct,
        lastSdRatio,
        null,
        norms.rmssdFloorMs
      );
      const isLow = lastWithHrv.rmssdMs < norms.rmssdFloorMs;
      const needsResp =
        lastWithHrv.coherencePct !== null && lastWithHrv.coherencePct < 54;
      const isHighRest =
        !isLow &&
        !needsResp &&
        lastWithHrv.rmssdMs >= norms.expectedRmssdRange[0] + 10;

      if (isLow) {
        return {
          id: `last-caution-${lastWithHrv.id}`,
          tone: "caution",
          badgeLabel: "آخر جلسة · إجهاد",
          headline: "مؤشر إجهاد ملحوظ في آخر جلسة — يفضّل أخذ قسط من الراحة",
          guidance: `سجّلت الجلسة الأخيرة RMSSD بقيمة ${lastWithHrv.rmssdMs} ms. يمكنك بدء قياس جديد بعد دقائق من الاسترخاء لمراقبة التحسن.`,
          chips,
          isLiveReliable: true,
          ageCalibrated,
        };
      }
      if (needsResp) {
        return {
          id: `last-resp-${lastWithHrv.id}`,
          tone: "respiratory",
          badgeLabel: "آخر جلسة · تنفس",
          headline: "تحتاج إلى توازن تنفسي أفضل",
          guidance: `تناغم القلب مع التنفس في آخر جلسة كان ${lastWithHrv.coherencePct}%. تنفّس بإيقاع بطيء ومنتظم في الجلسة القادمة.`,
          chips,
          isLiveReliable: true,
          ageCalibrated,
        };
      }
      if (isHighRest) {
        return {
          id: `last-optimal-${lastWithHrv.id}`,
          tone: "optimal",
          badgeLabel: "آخر جلسة · راحة عالية",
          headline: "الراحة عالية — تعافٍ عصبي ممتاز",
          guidance: `آخر جلسة أظهرت نشاطاً باراسمبثاوياً قوياً (RMSSD ${lastWithHrv.rmssdMs} ms). ابدأ جلسة جديدة للمتابعة المباشرة.`,
          chips,
          isLiveReliable: true,
          ageCalibrated,
        };
      }
      return {
        id: `last-good-${lastWithHrv.id}`,
        tone: "good",
        badgeLabel: "آخر جلسة · مستقر",
        headline: "توازن عصبي جيد في آخر قياس مسجّل",
        guidance: `مؤشراتك السابقة مستقرة (RMSSD ${lastWithHrv.rmssdMs} ms). اضغط «بدء القياس» للحصول على تنبيه فوري محدّث.`,
        chips,
        isLiveReliable: true,
        ageCalibrated,
      };
    }

    return {
      id: "idle-ready",
      tone: "pending",
      badgeLabel: "نظام التنبيهات جاهز",
      headline: "ابدأ القياس لتفعيل ملاحظات HRV والتوازن العصبي الذكية",
      guidance:
        "عند جمع 6–10 ثوانٍ من النبضات المستقرة، سيظهر هنا تقييم فوري لمستوى الراحة والإجهاد والتوازن التنفسي.",
      chips: [],
      isLiveReliable: false,
      ageCalibrated,
    };
  }

  if (
    isRunning &&
    (metrics.rmssdMs === null || metrics.bufferSeconds < 6)
  ) {
    return {
      id: "calibrating-hrv",
      tone: "pending",
      badgeLabel: "جارٍ التحليل",
      headline: "جارٍ تجميع نبضات كافية لحساب مؤشرات HRV",
      guidance:
        "حافظ على ثبات الجلسة وتنفس بشكل طبيعي لبضع ثوانٍ حتى يكتمل حساب الفواصل بين النبضات.",
      chips: [],
      isLiveReliable: false,
      ageCalibrated,
    };
  }

  if (
    isRunning &&
    metrics.respStatus === "breath_hold"
  ) {
    const holdSec = Math.round(metrics.breathHoldSeconds ?? 5);
    return {
      id: "resp-breath-hold",
      tone: "caution",
      badgeLabel: "كتم النفس / توقف التنفس",
      headline: `تم رصد توقف مؤقت في التنفس (كتم النفس ~${holdSec} ثوانٍ)`,
      guidance:
        "توقّف التضمين التنفسي في موجة النبض واضطراب النظم الجيبي (RSA). استأنف التنفس الهادئ لإعادة احتساب معدل التنفس والتناغم.",
      chips: [
        ...(metrics.bpm !== null
          ? [{ label: "النبض", value: `${metrics.bpm} BPM`, status: "neutral" as const }]
          : []),
        {
          label: "مدة التوقف",
          value: `${(metrics.breathHoldSeconds ?? 5).toFixed(1)}s`,
          status: "warn" as const,
        },
        ...(metrics.respModulationPct !== undefined
          ? [
              {
                label: "التضمين",
                value: `${metrics.respModulationPct}%`,
                status: "warn" as const,
              },
            ]
          : []),
      ],
      isLiveReliable: true,
      ageCalibrated,
    };
  }

  const sqiOk = metrics.sqiPct === undefined || metrics.sqiPct >= 42;
  if (
    isRunning &&
    (!sqiOk ||
      metrics.snrDb < 1.8 ||
      metrics.signalState === "motion" ||
      metrics.signalState === "low_light" ||
      metrics.signalState === "no_skin")
  ) {
    return {
      id: "low-quality-hold",
      tone: "pending",
      badgeLabel: "تحسين الالتقاط",
      headline: "الإشارة غير مستقرة حالياً لتقييم HRV بدقة",
      guidance:
        "ثبّت الرأس ووجّه إضاءة أمامية متوازنة حتى يتجاوز مؤشر الجودة SQI نسبة 50% للحصول على ملاحظة دقيقة.",
      chips:
        metrics.sqiPct !== undefined
          ? [
              {
                label: "SQI",
                value: `${metrics.sqiPct}%`,
                status: metrics.sqiPct >= 50 ? "good" : "warn",
              },
              {
                label: "SNR",
                value: `${metrics.snrDb.toFixed(1)} dB`,
                status: metrics.snrDb >= 2 ? "good" : "warn",
              },
            ]
          : [],
      isLiveReliable: false,
      ageCalibrated,
    };
  }

  const rmssdMs = metrics.rmssdMs ?? 0;
  const coherencePct = metrics.coherencePct;
  const sdRatio =
    metrics.sd1Ms && metrics.sd2Ms && metrics.sd1Ms > 0
      ? Number((metrics.sd2Ms / metrics.sd1Ms).toFixed(2))
      : null;
  const lfHf = metrics.lfHfRatio;

  // Personal baseline from historical sessions with HRV
  const histRmssds = readings
    .map((r) => r.rmssdMs)
    .filter((v): v is number => v !== null);
  const baselineRmssd =
    histRmssds.length >= 2
      ? histRmssds.reduce((a, b) => a + b, 0) / histRmssds.length
      : null;

  const chips = buildMetricChips(
    rmssdMs,
    coherencePct,
    sdRatio,
    lfHf,
    norms.rmssdFloorMs
  );

  const vagalDropVsBaseline =
    baselineRmssd !== null &&
    baselineRmssd >= norms.rmssdFloorMs &&
    rmssdMs < baselineRmssd * 0.74;
  const lowVagal = rmssdMs < norms.rmssdFloorMs || vagalDropVsBaseline;
  const highSympatheticBalance =
    (lfHf !== null && lfHf !== undefined && lfHf > 2.8) ||
    (sdRatio !== null && sdRatio > 2.85);
  const fastOrIrregularResp =
    metrics.respirationBrpm !== null &&
    (metrics.respirationBrpm >= 20 || metrics.respirationBrpm <= 7);
  const lowCoherence = coherencePct !== null && coherencePct < 54;

  // 1. High autonomic strain / low HRV
  if (lowVagal || highSympatheticBalance) {
    const baselineNote =
      baselineRmssd !== null
        ? ` مقارنةً بمتوسطك المرجعي (${Math.round(baselineRmssd)} ms)`
        : "";
    return {
      id: "hrv-caution",
      tone: "caution",
      badgeLabel: "إجهاد عصبي",
      headline: lowCoherence
        ? "إجهاد مرتفع — تحتاج إلى استرخاء وتوازن تنفسي أفضل"
        : "مؤشر إجهاد عصبي مرتفع — يُنصح بالراحة",
      guidance: `انخفاض تقلب النبض (RMSSD ${rmssdMs} ms${baselineNote}) يشير إلى غلبة الجهاز العصبي الودي. جرّب التنفس العميق البطيء (زفير أطول من الشهيق) لدقيقتين.`,
      chips,
      isLiveReliable: true,
      ageCalibrated,
    };
  }

  // 2. Desynchronized / shallow breathing
  if (lowCoherence || fastOrIrregularResp) {
    return {
      id: "hrv-respiratory",
      tone: "respiratory",
      badgeLabel: "توازن التنفس",
      headline: "تحتاج إلى توازن تنفسي أفضل",
      guidance:
        metrics.respirationBrpm !== null && metrics.respirationBrpm >= 20
          ? `معدل التنفس سريع نسبياً (${metrics.respirationBrpm} BrPM) وتناغم القلب مع التنفس ${coherencePct ?? "--"}%. أبطئ وتيرة التنفس إلى ~6 أنفاس/دقيقة.`
          : `مستوى التقلب العصبي مقبول (RMSSD ${rmssdMs} ms)، لكن تناغم النبض مع التنفس منخفض (${coherencePct ?? "--"}%). وحّد إيقاع الشهيق والزفير بهدوء.`,
      chips,
      isLiveReliable: true,
      ageCalibrated,
    };
  }

  // 3. High rest & parasympathetic recovery
  const aboveAgeOptimal = rmssdMs >= norms.expectedRmssdRange[0] + 10;
  const aboveBaselineOptimal =
    baselineRmssd !== null && rmssdMs >= baselineRmssd * 1.12;
  const calmBpm = metrics.bpm === null || metrics.bpm <= 84;
  const goodCoherence = coherencePct === null || coherencePct >= 62;
  const balancedRatio = sdRatio === null || sdRatio <= 2.35;

  if ((aboveAgeOptimal || aboveBaselineOptimal) && calmBpm && goodCoherence && balancedRatio) {
    return {
      id: "hrv-optimal",
      tone: "optimal",
      badgeLabel: "راحة عالية",
      headline: "الراحة عالية — استشفاء عصبي ممتاز",
      guidance: `مؤشر التعافي الباراسمبثاوي مرتفع (RMSSD ${rmssdMs} ms)${
        coherencePct !== null ? ` مع تناغم تنفسي قوي (${coherencePct}%)` : ""
      }، ما يدل على استرخاء جيد وتوازن مثالي للجهاز العصبي.`,
      chips,
      isLiveReliable: true,
      ageCalibrated,
    };
  }

  // 4. Balanced / Stable
  return {
    id: "hrv-good",
    tone: "good",
    badgeLabel: "توازن مستقر",
    headline: "التوازن العصبي جيد ومعدل الراحة مستقر",
    guidance: `قراءات HRV (${rmssdMs} ms) تقع ضمن النطاق الطبيعي المتوازن${
      ageCalibrated ? " مقارنةً بمرحلتك العمرية" : ""
    }. حافظ على نفس نمط التنفس الهادئ.`,
    chips,
    isLiveReliable: true,
    ageCalibrated,
  };
}
