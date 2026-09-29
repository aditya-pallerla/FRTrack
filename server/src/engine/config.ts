/**
 * Every threshold and weight used by the flood engine, in one place.
 *
 * Each value records its basis:
 *  - "IMD"        → India Meteorological Department rainfall-intensity categories (24 h). These are
 *                   RAINFALL categories, not official flood thresholds.
 *  - "prototype"  → a documented assumption for this prototype, to be calibrated on historical data.
 * No value here is an official flood-warning threshold.
 */

export interface WindowThreshold {
  /** Rainfall (mm) at which the window starts to indicate WATCH / WARNING / SEVERE. */
  watch: number;
  warning: number;
  severe: number;
  basis: 'IMD' | 'prototype';
  note: string;
}

export const RAIN_WINDOWS = {
  rain_1h: { hours: 1, label: '1-hour rainfall' },
  rain_3h: { hours: 3, label: '3-hour rainfall' },
  rain_6h: { hours: 6, label: '6-hour rainfall' },
  rain_24h: { hours: 24, label: '24-hour rainfall' },
} as const;
export type RainWindow = keyof typeof RAIN_WINDOWS;

export const RAIN_THRESHOLDS: Record<RainWindow | 'antecedent_72h', WindowThreshold> = {
  rain_1h: { watch: 15, warning: 30, severe: 50, basis: 'prototype', note: 'Prototype threshold — IMD defines no hourly flood threshold.' },
  rain_3h: { watch: 35, warning: 60, severe: 90, basis: 'prototype', note: 'Prototype threshold.' },
  rain_6h: { watch: 50, warning: 90, severe: 130, basis: 'prototype', note: 'Prototype threshold.' },
  rain_24h: {
    watch: 64.5, warning: 115.6, severe: 204.5, basis: 'IMD',
    note: 'IMD 24 h rainfall categories: heavy ≥64.5 mm, very heavy ≥115.6 mm, extremely heavy ≥204.5 mm.',
  },
  antecedent_72h: { watch: 100, warning: 200, severe: 350, basis: 'prototype', note: 'Prototype threshold — rain in the previous 72 h (wet ground, more runoff).' },
};

/**
 * Environmental hazard index = weighted mean of the dynamic drivers that are available
 * (weights renormalised when one is missing), then scaled by terrain susceptibility:
 *   envRisk = hazard × (TERRAIN_FACTOR.base + TERRAIN_FACTOR.span × susceptibility)
 * so susceptible ground amplifies a hazard but creates none on its own.
 */
export const HAZARD_WEIGHTS = { rain: 0.6, antecedent: 0.2, water: 0.2 } as const;
export const TERRAIN_FACTOR = { base: 0.6, span: 0.4, unknown: 0.8 } as const;

/** Ground reports add to risk on top of the environmental index. */
export const GROUND_RISK_WEIGHT = 0.25;

/** Severity index boundaries (0..1) that map to levels. */
export const LEVEL_INDEX = { watch: 1 / 3, warning: 2 / 3, severe: 1 } as const;

export const TERRAIN = {
  /** Height above nearest river (m) at or below which terrain susceptibility is maximal. */
  hand_full_m: 3,
  /** Height above nearest river (m) at or above which terrain contributes nothing. */
  hand_zero_m: 25,
  /** Distance to river (m) beyond which proximity contributes nothing. */
  river_distance_zero_m: 3000,
  /** Terrain at or above this susceptibility counts as "susceptible" evidence. */
  susceptible: 0.5,
  basis: 'prototype' as const,
  note: 'Simplified height-above-nearest-drainage (HAND) proxy: low ground close to a river is more susceptible. Susceptibility is not a guarantee of flooding.',
};

export const GROUND = {
  /** Reports within this distance of a settlement are attributed to it. */
  radius_m: 2500,
  /** Reports older than this no longer count (prototype: a confirmed flood observation stays relevant ~half a day). */
  window_min: 12 * 60,
  weight: { verified: 1, corroborated: 0.7, unverified: 0.35, disputed: 0 } as const,
  /** Support weight (after location confidence) that counts as strong ground evidence. */
  strong_support: 1.2,
  /** Distance within which a road-blocked report closes a road segment. */
  road_match_m: 150,
  /** Independent reports needed to mark a report "corroborated". */
  corroboration_count: 2,
  /** Distance and time window for corroboration. */
  corroboration_radius_m: 800,
  corroboration_window_min: 120,
};

export const FRESHNESS = {
  /** Observation age (min) up to which it is fully fresh, and after which it is stale. */
  rain: { fresh: 90, stale: 180 },
  water: { fresh: 120, stale: 360 },
  // A corroborated flood observation keeps full weight for 6 h, then fades to half weight by 12 h.
  report: { fresh: 360, stale: GROUND.window_min },
};

export const CONFIDENCE_WEIGHTS = { independence: 0.3, freshness: 0.25, consistency: 0.2, coverage: 0.15, location: 0.1 } as const;

export const FALSE_ALERT = {
  /** Minimum confidence to issue SEVERE. */
  severe_min_confidence: 0.6,
  /** SEVERE needs at least this many independent strong evidence classes. */
  severe_strong_classes: 2,
  /** A downgrade needs the lower candidate level to hold for this long, in engine time (hysteresis). */
  downgrade_after_min: 180,
  basis: 'prototype' as const,
};

export const PRIORITY_WEIGHTS = { level: 0.3, exposure: 0.2, vulnerability: 0.15, rescue: 0.15, access: 0.1, trend: 0.1 } as const;
export const PRIORITY_BANDS = { critical: 75, high: 55, medium: 35 } as const;
/** Value used when population or vulnerability is unknown — neutral, and always flagged as unknown. */
export const UNKNOWN_NEUTRAL = 0.5;

export const ACCESS = {
  /** An alternative route this much slower than the undisrupted baseline makes access DEGRADED. */
  degraded_ratio: 1.15,
  /** Travel-time multiplier on AT_RISK roads (routes prefer to avoid them). */
  at_risk_penalty: 1.6,
};
