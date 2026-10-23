export interface Vec { x: number; y: number }
export interface Rect extends Vec { w: number; h: number; id: string }
export type ExitId = 'A' | 'B';
export interface AgentSeed {
  id: number;
  position: Vec;
  speed: number;
  radius: number;
  knowsA: boolean;
  knowsB: boolean;
  cohort: string;
}
export interface Exit extends Vec { width: number; interval: number; label: string }
export interface Scene {
  id: string;
  width: number;
  height: number;
  walls: Rect[];
  exits: Record<ExitId, Exit>;
}
export interface SpawnGroup {
  id: string;
  label: string;
  color: string;
  origin: Vec;
  columns: number;
  rows: number;
  gap: Vec;
  speed: [number, number];
  known: ExitId[];
}
export interface Scenario { scene: Scene; groups: SpawnGroup[] }
export interface Sign {
  id: number;
  position: Vec;
  normal: Vec;
  range: number;
  target: ExitId;
  from: number;
  until: number;
}
export interface Barrier { position: Vec; vertical: boolean }
export interface Design { signs: Sign[]; barrier: Barrier | null }
export interface Snapshot { seed: number; agents: AgentSeed[]; scene: Scene }
export interface DecisionEvent {
  agentId: number;
  tick: number;
  time: number;
  type: 'learn' | 'choose' | 'arrive' | 'queue' | 'blocked';
  position: Vec;
  exit: ExitId;
  learnedExit?: ExitId;
  signId?: number;
  distanceToSign?: number;
  costA?: number;
  costB?: number;
  peers?: number[];
  source?: 'initial' | 'sign';
}
export interface AgentFrame extends Vec {
  id: number;
  vx: number;
  vy: number;
  exit: ExitId;
  knowsA: boolean;
  knowsB: boolean;
  arrived: boolean;
  queued: boolean;
  hx: number;
  hy: number;
}
export interface Frame { time: number; agents: AgentFrame[] }
export interface AgentResult {
  id: number;
  cohort: string;
  exit: ExitId;
  initialExit: ExitId;
  arrivalTime: number | null;
  distance: number;
  stopped: number;
  delay: number;
  gateWait: number;
  learnedAt: number | null;
}
export interface CohortMetrics { count: number; completed: number; mean: number | null; tail: number | null; delay: number }
export interface Metrics {
  completed: number;
  unfinished: number;
  exits: Record<ExitId, number>;
  informed: number;
  rerouted: number;
  meanArrival: number | null;
  meanStopped: number;
  meanDelay: number;
  lastArrival: number | null;
  cohorts: Record<string, CohortMetrics>;
}
export interface Run {
  model: string;
  design: Design;
  duration: number;
  frames: Frame[];
  events: DecisionEvent[];
  agents: AgentResult[];
  metrics: Metrics;
  fingerprint: string;
}
