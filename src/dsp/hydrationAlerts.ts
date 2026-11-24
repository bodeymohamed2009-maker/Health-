import { getAgeAdjustedNorms } from "./hrvTrends";
import type { BiometricProfile, RppgMetrics, SessionReading } from "../types/rppg";

export interface HydrationDailyState {
  dateKey: string;
  glassesDrank: number;
  lastAckMeasurements: number;
  snoozedUntilMeasurements: number;
}

export type HydrationAlertStatus = "ready" | "remind" | "urgent" | "hydrated";

export interface HydrationSmartAlert {
  status: HydrationAlertStatus;
  badgeLabel: string;
  title: string;
  message: string;
  todayCount: number;
  glassesDrank: number;
  dailyGoalGlasses: number;
  nextTriggerAtCount: number;
  canAcknowledge: boolean;
  canSnooze: boolean;
}

export function getLocalDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function extractReadingDateKey(reading: SessionReading): string {
  if (reading.dateKey) return reading.dateKey;
  const prefix = reading.id.split("-")[0];
  const ms = Number(prefix);
  if (Number.isFinite(ms) && ms > 1_000_000_000_000) {
    return getLocalDateKey(new Date(ms));
  }
  return getLocalDateKey();
}

export function getTodayReadings(
  readings: SessionReading[],
  todayKey: string = getLocalDateKey()
): SessionReading[] {
  return readings.filter((r) => extractReadingDateKey(r) === todayKey);
}

export function createInitialHydrationState(
  todayKey: string = getLocalDateKey()
): HydrationDailyState {
  return {
    dateKey: todayKey,
    glassesDrank: 0,
    lastAckMeasurements: 0,
    snoozedUntilMeasurements: 0,
  };
}

export function computeDailyWaterGoalGlasses(profile?: BiometricProfile): number {
  if (profile?.weightKg && profile.weightKg >= 30 && profile.weightKg <= 220) {
    // ~30 ml/kg divided by 250 ml cup, bounded [6, 12]
    return Math.max(6, Math.min(12, Math.round((profile.weightKg * 30) / 250)));
  }
  return 8;
}

export function evaluateHydrationAlert({
  readings,
  hydrationState,
  profile,
  liveMetrics,
  todayKey = getLocalDateKey(),
}: {
  readings: SessionReading[];
  hydrationState: HydrationDailyState;
  profile?: BiometricProfile;
  liveMetrics?: RppgMetrics;
  todayKey?: string;
}): HydrationSmartAlert {
  const state =
    hydrationState.dateKey === todayKey
      ? hydrationState
      : createInitialHydrationState(todayKey);

  const todayReadings = getTodayReadings(readings, todayKey);
  const todayCount = todayReadings.length;
  const dailyGoalGlasses = computeDailyWaterGoalGlasses(profile);
  const norms = getAgeAdjustedNorms(profile?.age);

  const latestToday = todayReadings[0] ?? null;
  const refBpm = liveMetrics?.bpm ?? latestToday?.bpm ?? null;
  const refRmssd = liveMetrics?.rmssdMs ?? latestToday?.rmssdMs ?? null;
  const hasPhysioStrain =
    (refBpm !== null && refBpm >= 88) ||
    (refRmssd !== null && refRmssd < norms.rmssdFloorMs);

  const scansSinceLastDrink = Math.max(0, todayCount - state.lastAckMeasurements);
  const stepPerReminder = hasPhysioStrain ? 1 : 2;
  const nextTriggerAtCount =
    state.glassesDrank === 0 && todayCount === 0
      ? 1
      : Math.max(
          state.lastAckMeasurements + stepPerReminder,
          state.snoozedUntilMeasurements
        );

  const isSnoozed =
    state.snoozedUntilMeasurements > 0 && todayCount < state.snoozedUntilMeasurements;

  const shouldRemind =
    todayCount > 0 &&
    !isSnoozed &&
    (state.glassesDrank === 0
      ? scansSinceLastDrink >= 1
      : scansSinceLastDrink >= stepPerReminder);

  if (todayCount === 0) {
    return {
      status: state.glassesDrank > 0 ? "hydrated" : "ready",
      badgeLabel: state.glassesDrank > 0 ? "ترطيب مبكر" : "تذكير ذكي نشط",
      title:
        state.glassesDrank > 0
          ? `رائع! سجّلت ${state.glassesDrank} من ${dailyGoalGlasses} أكواب ماء اليوم`
          : "لم تُسجَّل قياسات اليوم بعد — اشرب كوب ماء قبل البدء",
      message:
        "يعتمد التذكير الصحي على عدد قياساتك اليومية المسجلة. الترطيب الجيد يحسّن مرونة الشعيرات الدموية ويمنح قراءات rPPG أكثر ثباتاً.",
      todayCount,
      glassesDrank: state.glassesDrank,
      dailyGoalGlasses,
      nextTriggerAtCount: 1,
      canAcknowledge: state.glassesDrank < dailyGoalGlasses,
      canSnooze: false,
    };
  }

  if (shouldRemind) {
    const isUrgent =
      scansSinceLastDrink >= 3 || (hasPhysioStrain && scansSinceLastDrink >= 2);

    const physioNote = hasPhysioStrain
      ? "لاحظنا ارتفاعاً نسبياً في النبض أو انخفاضاً في HRV، وشرب الماء يساعد على تهدئة الحمل القلبي الوعائي."
      : "الحفاظ على شرب كوب ماء بعد كل جلستين يدعم توازن السوائل ودقة النبض.";

    return {
      status: isUrgent ? "urgent" : "remind",
      badgeLabel: isUrgent ? "تنبيه ترطيب مهم" : "وقت شرب الماء",
      title: isUrgent
        ? `تنبيه صحي: سجّلت ${todayCount} قياسات اليوم — اشرب كوب ماء الآن`
        : `تذكير شرب الماء بعد ${todayCount} ${todayCount === 1 ? "قياس" : todayCount === 2 ? "قياسين" : todayCount <= 10 ? "قياسات" : "قياساً"} اليوم`,
      message: `مرّ ${
        scansSinceLastDrink === 1
          ? "قياس جديد"
          : scansSinceLastDrink === 2
          ? "قياسان"
          : `${scansSinceLastDrink} قياسات`
      } منذ آخر كوب ماء مسجّل. ${physioNote}`,
      todayCount,
      glassesDrank: state.glassesDrank,
      dailyGoalGlasses,
      nextTriggerAtCount,
      canAcknowledge: true,
      canSnooze: true,
    };
  }

  const remainingGoal = Math.max(0, dailyGoalGlasses - state.glassesDrank);
  return {
    status: "hydrated",
    badgeLabel: remainingGoal === 0 ? "الهدف اليومي مكتمل" : "ترطيب متوازن",
    title:
      remainingGoal === 0
        ? `ممتاز! أكملت هدفك اليومي (${state.glassesDrank}/${dailyGoalGlasses} أكواب)`
        : `ترطيب جيد — تم تسجيل ${state.glassesDrank} من ${dailyGoalGlasses} أكواب اليوم`,
    message: `لديك ${todayCount} ${
      todayCount === 1 ? "قياس مسجّل" : todayCount === 2 ? "قياسان مسجّلان" : todayCount <= 10 ? "قياسات مسجّلة" : "قياساً مسجّلاً"
    } اليوم. سيظهر التذكير التالي تلقائياً عند الوصول إلى القياس رقم ${nextTriggerAtCount}.`,
    todayCount,
    glassesDrank: state.glassesDrank,
    dailyGoalGlasses,
    nextTriggerAtCount,
    canAcknowledge: state.glassesDrank < dailyGoalGlasses,
    canSnooze: false,
  };
}
