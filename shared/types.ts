/**
 * Shared contract between the engine, the API and the dashboard.
 *
 * Provenance rule: every value that comes from the outside world carries a DataMode.
 *  - live               → fetched now from a live source
 *  - replay             → historical data, replayed with its ORIGINAL timestamp
 *  - synthetic_scenario → written by the team for the demo; never real
 */

export type DataMode = 'live' | 'replay' | 'synthetic_scenario';
export type SystemMode = 'live' | 'replay';

export type WarningLevel = 'NONE' | 'WATCH' | 'WARNING' | 'SEVERE';
export const WARNING_LEVELS: WarningLevel[] = ['NONE', 'WATCH', 'WARNING', 'SEVERE'];

export type RoadStatus = 'OPEN' | 'AT_RISK' | 'BLOCKED';
export type AccessStatus = 'REACHABLE' | 'DEGRADED' | 'CUT_OFF' | 'UNKNOWN';
export type PriorityBand = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type Verification = 'unverified' | 'corroborated' | 'verified' | 'disputed';

// ── Static geography (built once from OSM / DEM / Census) ────────────────────

export interface Provenance {
  source: string;
  note?: string;
}

export interface Settlement {
  id: string;
  name: string;
  name_mr?: string | null;
  kind: 'city' | 'town' | 'village' | 'hamlet' | 'suburb';
  lat: number;
  lng: number;
  /** null = no reliable figure. Never estimated silently. */
  population: number | null;
  population_source: string | null;
  /** Share of vulnerable residents (proxy, e.g. Census children 0–6). null = unknown. */
  vulnerable_share: number | null;
  elevation_m: number | null;
  /** Elevation above the nearest mapped river point (m). null when unknown. */
  height_above_river_m: number | null;
  distance_to_river_m: number | null;
  /** 0..1, derived from terrain (see engine/terrain.ts). null when terrain unknown. */
  terrain_susceptibility: number | null;
  /** Road-graph node used for routing to this settlement. null = no road access in the data. */
  road_node: string | null;
  road_node_distance_m: number | null;
  /** Rainfall grid cell that covers this settlement. */
  rain_cell: string | null;
  /** Near a river gauge, so gauge level is relevant evidence. */
  gauge_id: string | null;
  sources: Record<string, Provenance>;
}

export interface RoadSegment {
  id: string;
  osm_way_id: number | null;
  name: string | null;
  road_class: string;
  /** [lat, lng] pairs */
  coords: [number, number][];
  from: string;
  to: string;
  length_m: number;
  speed_kmh: number;
  oneway: boolean;
  is_bridge: boolean;
  is_ford: boolean;
  flood_prone: boolean;
  flood_prone_reason: string | null;
}

export interface ResponseBase {
  id: string;
  name: string;
  kind: 'fire_station' | 'police' | 'hospital' | 'staging';
  lat: number;
  lng: number;
  road_node: string | null;
  source: string;
}

export interface RiverGauge {
  id: string;
  name: string;
  river: string;
  lat: number;
  lng: number;
  unit: 'ft' | 'm';
  warning_level: number | null;
  danger_level: number | null;
  levels_source: string;
  levels_verified: boolean;
}

// ── Observations and events (the inputs) ─────────────────────────────────────

export interface RainObservation {
  cell_id: string;
  lat: number;
  lng: number;
  /** ISO timestamp of the END of the observation interval, with offset. Original time for replay. */
  observed_at: string;
  interval_min: number;
  /** null = missing value in the source. */
  rainfall_mm: number | null;
  source: string;
  mode: DataMode;
}

export interface WaterLevelObservation {
  gauge_id: string;
  observed_at: string;
  level: number;
  unit: 'ft' | 'm';
  source: string;
  mode: DataMode;
}

export type FloodReportKind =
  | 'water_in_homes'
  | 'road_flooded'
  | 'bridge_submerged'
  | 'people_trapped'
  | 'rescue_needed'
  | 'water_rising'
  | 'vehicles_cannot_pass'
  | 'shelter_inaccessible'
  | 'road_open'
  | 'no_flooding';

export interface ReportEvidence {
  kinds: FloodReportKind[];
  road_blocked: boolean;
  people_trapped: number; // 0 none, -1 present but count unknown, N count
  injured: number;
  vulnerable_present: boolean;
  place_text: string | null;
  language: 'en' | 'hi' | 'mr' | 'mixed' | 'unknown';
  /** How the evidence was extracted. The LLM's self-rating is kept only as a hint. */
  extractor: 'gemini' | 'keyword';
  extractor_confidence_hint: number | null;
}

export interface GroundReport {
  id: string;
  text: string;
  received_at: string;
  lat: number;
  lng: number;
  /** 0..1 from location resolution. */
  location_confidence: number;
  reporter_ref: string;
  evidence: ReportEvidence;
  verification: Verification;
  mode: DataMode;
}

export interface RoadEvent {
  id: string;
  segment_id: string;
  action: 'close' | 'reopen';
  at: string;
  reason: string;
  /** coordinator = decided by a person; scenario = demo script; documented = cited historical record */
  origin: 'coordinator' | 'scenario' | 'documented';
  source: string;
  mode: DataMode;
}

// ── Engine outputs ───────────────────────────────────────────────────────────

export interface EvidenceItem {
  kind: 'rain_1h' | 'rain_3h' | 'rain_6h' | 'rain_24h' | 'antecedent_72h' | 'terrain' | 'water_level'
    | 'ground_support' | 'ground_conflict' | 'road_blocked' | 'rain_trend';
  label: string;
  value: number | string | null;
  unit?: string;
  threshold?: number | null;
  threshold_source?: string;
  /** Does this item point towards flooding? */
  supports: boolean;
  observed_at: string | null;
  age_min: number | null;
  stale: boolean;
  source: string;
  mode: DataMode | 'static';
}

export interface ConfidenceBreakdown {
  value: number;
  independence: number;
  freshness: number;
  consistency: number;
  coverage: number;
  location: number;
}

export interface SettlementWarning {
  settlement_id: string;
  level: WarningLevel;
  /** Level from environmental evidence only (before ground reports and the false-alert check). */
  initial_level: WarningLevel;
  /** The level the evidence would support before hysteresis / false-alert limits. */
  candidate_level: WarningLevel;
  risk: number;
  confidence: ConfidenceBreakdown;
  evidence: EvidenceItem[];
  data_gaps: string[];
  verification_requested: boolean;
  false_alert_notes: string[];
  /** Since when the evidence has supported a lower level (hysteresis); null when not improving. */
  downgrade_pending_since: string | null;
  would_increase: string[];
  would_decrease: string[];
  version: number;
  reason_for_change: string | null;
  as_of: string;
}

export interface RoadState {
  segment_id: string;
  status: RoadStatus;
  reason: string;
  source: string;
  mode: DataMode | 'static';
  since: string | null;
}

export interface RouteResult {
  status: 'ok' | 'no_route';
  /** [lat, lng] */
  coords: [number, number][];
  segment_ids: string[];
  distance_m: number;
  duration_s: number;
  uses_at_risk: string[];
}

export interface SettlementAccess {
  settlement_id: string;
  status: AccessStatus;
  base_id: string | null;
  route: RouteResult | null;
  baseline_duration_s: number | null;
  eta_delta_min: number | null;
  blocked_on_baseline: string[];
  note: string | null;
}

export interface PriorityComponents {
  level: number;
  exposure: number;
  vulnerability: number;
  rescue: number;
  access: number;
  trend: number;
}

export interface SettlementPriority {
  settlement_id: string;
  score: number;
  band: PriorityBand;
  rank: number;
  components: PriorityComponents;
  unknowns: string[];
  previous_rank: number | null;
  previous_score: number | null;
  changes: string[];
}

export interface Unit {
  id: string;
  name: string;
  type: 'rescue_team' | 'rescue_boat' | 'ambulance' | 'police';
  base_id: string;
  road_node: string | null;
  status: 'available' | 'assigned' | 'en_route' | 'on_scene' | 'unavailable';
  capabilities: string[];
  /** Units are demo units; names are synthetic. */
  synthetic: true;
}

export interface Recommendation {
  id: string;
  unit_id: string;
  settlement_id: string;
  kind: 'new' | 'reroute' | 'replacement' | 'reassign';
  eta_min: number;
  route: RouteResult;
  staging_note: string | null;
  reasons: string[];
  utility: number;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
}

/** An approved dispatch. Created only by a coordinator approving a recommendation. */
export interface Assignment {
  id: string;
  unit_id: string;
  settlement_id: string;
  status: 'assigned' | 'en_route' | 'on_scene' | 'completed' | 'cancelled';
  route: RouteResult;
  eta_min: number;
  staging_note: string | null;
  approved_by: string;
  approved_at: string;
  updated_at: string;
}

export interface SituationChange {
  at: string;
  type: 'warning_escalated' | 'warning_downgraded' | 'warning_created' | 'verification_requested'
    | 'road_status_changed' | 'route_invalidated' | 'alternate_route_found' | 'settlement_cut_off'
    | 'priority_changed' | 'recommendation_changed';
  settlement_id?: string;
  segment_id?: string;
  message: string;
}

export interface Situation {
  mode: SystemMode;
  replay: ReplayInfo | null;
  /** Engine clock: original event time in replay, wall time in live. */
  as_of: string;
  warnings: SettlementWarning[];
  roads: RoadState[];
  access: SettlementAccess[];
  priorities: SettlementPriority[];
  recommendations: Recommendation[];
  assignments: Assignment[];
  units: Unit[];
  unmet: { settlement_id: string; need: string; reason: string }[];
  reports: GroundReport[];
  changes: SituationChange[];
  freshness: { rain_age_min: number | null; report_age_min: number | null; water_age_min: number | null; rain_stale: boolean };
}

export interface ReplayInfo {
  event_id: string;
  event_name: string;
  step: number;
  total_steps: number;
  /** Event time covered by one replay step (minutes). */
  step_min: number;
  original_time: string;
  replayed_at: string;
  playing: boolean;
  speed: number;
}
