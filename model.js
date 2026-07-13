/*
 * model.js — the sports-nutrition + hydration engine.
 *
 * Every number here traces to the literature pass we did (2025-26 current):
 *   - Protein 1.8 g/kg default (Witard 2025, Sports Medicine), 2.0 in a deficit.
 *   - Carbohydrate periodized to the day's work ("fuel for the work required",
 *     Impey/Burke) using the ACSM/Burke g/kg-by-load bands. We skew to ADEQUACY,
 *     never deliberately starve a session (2024 RCTs: train-low doesn't beat
 *     consistent high-carb for performance, and chronic low-carb feeds REDs).
 *   - Energy availability floor: >=45 kcal/kg FFM optimal, <30 problematic
 *     (IOC 2023 REDs consensus). We also protect carbohydrate availability.
 *   - During-exercise carbs scale with duration up to ~90 g/h, ceiling 120 g/h
 *     for gut-trained athletes on long efforts (J. Nutrition 2026).
 *   - Iron flagged first-class: male 8 mg/day, female 18 mg/day; ferritin >=50.
 *
 * Constants are named and tunable so the science can be updated in one place.
 */
window.NutriModel = (function () {
  "use strict";

  const C = {
    PROTEIN_G_PER_KG: 1.8,
    PROTEIN_G_PER_KG_DEFICIT: 2.0,
    FAT_MIN_G_PER_KG: 0.8,
    FAT_MIN_PCT_ENERGY: 0.2,
    EA_OPTIMAL: 45, // kcal / kg FFM / day
    EA_LOW: 30, // problematic threshold
    EA_TARGET_FLOOR: 40, // we won't let a weight-loss deficit push EA below this
    NON_EXERCISE_ACTIVITY_FACTOR: 1.35, // BMR -> daily living (exercise added separately)
    KCAL_PER_KG_BODYWEIGHT: 7700, // energy to shift 1 kg
    MAX_DEFICIT_KCAL: 750,
    WATER_BASE_ML_PER_KG: 35,
    GLASS_ML: 240, // 8 fl oz
    IRON_MG: { male: 8, female: 18 },
    FERRITIN_TARGET_NG_ML: 50,
  };

  // Sweat loss estimate (ml per minute) by session intensity. Moderate ~0.7 L/h.
  const SWEAT_ML_PER_MIN = {
    rest: 0,
    recovery: 8,
    easy: 11,
    long: 13,
    tempo: 16,
    quality: 16,
    race: 18,
  };

  // Carbohydrate band (g/kg/day) chosen by the day's demand — "fuel for the work".
  function carbBand(day) {
    const t = day.type;
    const min = day.durationMin || 0;
    if (t === "rest") return { name: "rest / very light", low: 3, high: 5 };
    if (t === "recovery" || (t === "easy" && min <= 45))
      return { name: "moderate", low: 5, high: 7 };
    if (t === "long" && min >= 150)
      return { name: "very high", low: 8, high: 12 };
    if (t === "long" || t === "race")
      return { name: "very high", low: 8, high: 10 };
    // easy(long), tempo, quality
    return { name: "high", low: 6, high: 10 };
  }

  // During-exercise carbohydrate target (g/h) — only relevant for longer sessions.
  function duringCarb(day) {
    const min = day.durationMin || 0;
    if (min < 60) return null;
    if (min < 90) return { low: 0, high: 30, note: "small feeds or mouth-rinse" };
    if (min < 150) return { low: 30, high: 60, note: "glucose+fructose mix" };
    return {
      low: 60,
      high: 90,
      ceiling: 120,
      note: "glucose:fructose ~1:0.8 — gut-train up to your tolerance",
    };
  }

  function mifflinBMR(u) {
    const base = 10 * u.weightKg + 6.25 * u.heightCm - 5 * u.age;
    return u.sex === "female" ? base - 161 : base + 5;
  }

  // Deurenberg body-fat estimate when the user hasn't measured it — used for FFM.
  function estBodyFatPct(u) {
    const bmi = u.weightKg / Math.pow(u.heightCm / 100, 2);
    const sexTerm = u.sex === "male" ? 1 : 0;
    return Math.max(5, 1.2 * bmi + 0.23 * u.age - 10.8 * sexTerm - 5.4);
  }

  function fatFreeMassKg(u) {
    const bf = (u.bodyFatPct != null ? u.bodyFatPct : estBodyFatPct(u)) / 100;
    return u.weightKg * (1 - bf);
  }

  function bmr(u) {
    if (u.bodyFatPct != null) return 370 + 21.6 * fatFreeMassKg(u); // Katch-McArdle
    return mifflinBMR(u);
  }

  // Zones aligned to the gauge (green >=45, amber 30-45, red <30). A weight-
  // stable athlete typically sits in the high-30s and that is healthy, so the
  // amber band is a calm "monitor", not an alarm. The hard REDs warning is <30.
  // (EA is prescribed-equal across days until real intake is logged; the 7-day
  // rolling average only starts doing real work once food logging feeds it.)
  function eaZone(ea) {
    if (ea >= C.EA_OPTIMAL) return { key: "ok", label: "optimal" };
    if (ea >= C.EA_LOW) return { key: "watch", label: "adequate — monitor" };
    return { key: "danger", label: "very low — REDs risk" };
  }

  /*
   * dayPlan — the core call. Given a user profile and one day of training
   * (type, duration, expenditure), returns fully-resolved targets + flags.
   */
  function dayPlan(user, day) {
    const w = user.weightKg;
    const ffm = fatFreeMassKg(user);
    const bmrVal = bmr(user);
    const eee = day.eeeKcal || 0;
    const maintenance = bmrVal * C.NON_EXERCISE_ACTIVITY_FACTOR + eee;

    // Target energy, honouring a weight-loss goal but protecting EA.
    let deficit = 0;
    const losing = user.goal && user.goal.type === "lose";
    if (losing) {
      const perDay = ((user.goal.rateKgPerWeek || 0.4) * C.KCAL_PER_KG_BODYWEIGHT) / 7;
      deficit = Math.min(perDay, C.MAX_DEFICIT_KCAL);
    }
    let target = maintenance - deficit;
    const eaFloorTarget = C.EA_TARGET_FLOOR * ffm + eee; // keep EA >= 40
    let deficitTrimmed = false;
    if (losing && target < eaFloorTarget) {
      target = eaFloorTarget;
      deficitTrimmed = true;
    }

    // Protein — near-constant, higher in a deficit.
    const proteinPerKg = losing ? C.PROTEIN_G_PER_KG_DEFICIT : C.PROTEIN_G_PER_KG;
    const proteinG = w * proteinPerKg;

    // Carbohydrate — periodized to the work.
    const band = carbBand(day);
    let carbG = w * ((band.low + band.high) / 2);

    // Fat = remainder, with a floor. If the floor bites, pull carbs down toward
    // the band minimum (never below) to make room — protects hormones/vitamins.
    const proteinKcal = proteinG * 4;
    const fatFloorG = Math.max(C.FAT_MIN_G_PER_KG * w, (C.FAT_MIN_PCT_ENERGY * target) / 9);
    let fatG = (target - proteinKcal - carbG * 4) / 9;
    let underfuelled = false;
    if (fatG < fatFloorG) {
      const carbFloorG = w * band.low;
      const shortfallKcal = (fatFloorG - fatG) * 9;
      const carbReducibleKcal = (carbG - carbFloorG) * 4;
      const removeKcal = Math.min(shortfallKcal, Math.max(0, carbReducibleKcal));
      carbG -= removeKcal / 4;
      fatG = (target - proteinKcal - carbG * 4) / 9;
      if (fatG < fatFloorG - 1) {
        fatG = fatFloorG;
        underfuelled = true; // target too low to satisfy every floor
      }
    }

    const ea = (target - eee) / ffm;
    const zone = eaZone(ea);

    // Carbohydrate-availability flag: a hard day forced to the band's low end.
    const carbAvailabilityLow =
      (day.type === "long" || day.type === "quality" || day.type === "tempo") &&
      carbG <= w * band.low + 1;

    // Hydration — baseline plus estimated sweat for the day's session.
    const baseMl = C.WATER_BASE_ML_PER_KG * w;
    const sweatMl = (day.durationMin || 0) * (SWEAT_ML_PER_MIN[day.type] || 0);
    const totalMl = baseMl + sweatMl;

    return {
      day,
      bmr: Math.round(bmrVal),
      ffm: Math.round(ffm * 10) / 10,
      maintenance: Math.round(maintenance),
      eee: Math.round(eee),
      calories: Math.round(target),
      deficit: Math.round(maintenance - target),
      deficitTrimmed,
      macros: {
        protein: Math.round(proteinG),
        carbs: Math.round(carbG),
        fat: Math.round(fatG),
        proteinPerKg: Math.round(proteinPerKg * 100) / 100,
        carbPerKg: Math.round((carbG / w) * 10) / 10,
      },
      carbBand: band,
      duringCarb: duringCarb(day),
      energyAvailability: { value: Math.round(ea), zone },
      hydration: {
        baseMl: Math.round(baseMl),
        sweatMl: Math.round(sweatMl),
        totalMl: Math.round(totalMl),
        glasses: Math.max(1, Math.round(totalMl / C.GLASS_ML)),
        glassMl: C.GLASS_ML,
      },
      iron: {
        mgPerDay: C.IRON_MG[user.sex] || 8,
        ferritinTarget: C.FERRITIN_TARGET_NG_ML,
        female: user.sex === "female",
      },
      flags: buildFlags({ zone, deficitTrimmed, carbAvailabilityLow, underfuelled, user }),
    };
  }

  function buildFlags({ deficitTrimmed, carbAvailabilityLow, underfuelled, user }) {
    // Energy-availability warnings are raised by the caller off the 7-day
    // rolling average (LEA is a chronic pattern, not a single-day event).
    const flags = [];
    if (deficitTrimmed)
      flags.push({ level: "info", text: "Weight-loss deficit reduced to protect energy availability." });
    if (carbAvailabilityLow)
      flags.push({ level: "warn", text: "Carbs are at the low end for a hard session — consider topping up around the workout." });
    if (underfuelled)
      flags.push({ level: "warn", text: "Calorie target is too low to meet every macro floor — this day is underfuelled." });
    if (user.sex === "female")
      flags.push({ level: "info", text: "Female athlete: iron needs are higher (~18 mg/day) and under-fuelling risk is elevated." });
    return flags;
  }

  return { dayPlan, bmr, fatFreeMassKg, estBodyFatPct, carbBand, eaZone, C };
})();
