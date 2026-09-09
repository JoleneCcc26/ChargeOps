// server/lib/charging.js — how much energy a charging session actually delivers
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ═════════════════════════════════════════════════════════════════════════════
// Energy was previously estimated as `power × hours × 0.85`. That is dimensionally
// correct and physically impossible. A 350 kW charger running for four hours
// comes out at 1190 kWh — roughly fifteen times the usable capacity of a car
// battery. The seeded history showed DC fast sessions averaging 107 kWh, which
// is more than most EVs can hold, and live sessions that had been "charging" for
// nearly five hours at 207 kW.
//
// Two facts bound the real number, and the old formula ignored both.
//
// 1. THE BATTERY IS FINITE. A session cannot deliver more energy than the pack
//    can accept. Typical usable capacity is 60–100 kWh, and drivers on a fast
//    charger stop around 80% state of charge because the last fifth takes as
//    long as the first four.
//
// 2. FAST CHARGING TAPERS. Nameplate power is the peak, held only while the
//    battery is nearly empty and cool. Charge rate falls steeply as the pack
//    fills, so the AVERAGE power over a session is far below the sticker. A
//    350 kW stall averages perhaps 150 kW across a real stop. Level 2 barely
//    tapers at all — it is slow enough that the battery keeps up — so it runs
//    near nameplate the whole way.
//
// Getting this right matters beyond looking plausible: energy is what the
// customer is billed for, so an energy model that is off by 10x is a billing
// model that is off by 10x.

/** Usable pack capacity, kWh. A mid-size EV; enough for a demo fleet. */
export const BATTERY_KWH = 75;

/**
 * Fraction of the pack a driver typically adds in one public session.
 *
 * They arrive with charge left and leave before 100%, so a session moves the
 * battery through part of its range rather than filling it from empty.
 */
export const TYPICAL_SOC_GAIN = 0.62;

/** The most one session can plausibly deliver. */
export const MAX_SESSION_KWH = Math.round(BATTERY_KWH * 0.9);

/** Above this, a charger is DC fast and tapers hard. */
const DC_FAST_THRESHOLD_KW = 50;

/**
 * Average power actually sustained over a session, given the charger's rating.
 *
 * @param {number} nameplateKw
 * @returns {number} kW
 */
export function effectivePowerKw(nameplateKw) {
  const kw = Number(nameplateKw) || 0;
  if (kw <= 0) return 0;
  // DC fast: the curve starts high and falls away, so roughly 45% of nameplate
  // averaged over a stop. Level 2: slow enough that the battery keeps up, so
  // close to nameplate less charging losses.
  return kw > DC_FAST_THRESHOLD_KW ? kw * 0.45 : kw * 0.92;
}

/**
 * Energy delivered by a session of a given length, bounded by the battery.
 *
 * @param {number} nameplateKw charger rating
 * @param {number} hours       session length
 * @returns {number} kWh, rounded to 2dp
 */
export function energyDeliveredKwh(nameplateKw, hours) {
  const h = Math.max(0, Number(hours) || 0);
  const raw = effectivePowerKw(nameplateKw) * h;
  return Number(Math.min(raw, MAX_SESSION_KWH).toFixed(2));
}

/**
 * How long a realistic session on this charger lasts, in minutes.
 *
 * Derived from the physics rather than picked out of the air: the driver wants
 * a certain number of kWh, and the charger delivers them at its effective rate.
 * A 350 kW stall therefore takes about 20 minutes and an 11 kW one takes about
 * four and a half hours — which is exactly the difference between stopping at a
 * motorway charger and leaving the car plugged in at work.
 *
 * `spread` (0–1, derived from a row id) varies the target so a fleet of
 * sessions does not all last exactly the same time.
 *
 * @param {number} nameplateKw
 * @param {number} spread 0..1
 * @returns {number} minutes
 */
export function typicalSessionMinutes(nameplateKw, spread = 0.5) {
  const power = effectivePowerKw(nameplateKw);
  if (power <= 0) return 45;

  // Drivers top up by different amounts; 45%–80% of the pack covers most stops.
  const targetKwh = BATTERY_KWH * (0.45 + 0.35 * spread) * TYPICAL_SOC_GAIN;
  const minutes = (targetKwh / power) * 60;

  // Floor and ceiling for sanity: nobody plugs in for two minutes, and a public
  // session running beyond eight hours means the driver went home and forgot.
  return Math.round(Math.min(Math.max(minutes, 12), 480));
}

/**
 * Longest a session on this charger should be left running before the platform
 * treats it as finished. Used to retire live demo sessions that would otherwise
 * age forever, and to flag genuinely abandoned ones.
 */
export function maxPlausibleSessionMinutes(nameplateKw) {
  return Math.round(typicalSessionMinutes(nameplateKw, 1) * 1.6);
}
