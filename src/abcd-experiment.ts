// A/B/C/D CPU-stage experiment (factory test branch only; off by default).
//
// Every inline invocation still races the normal per-UTC-minute sync gate, so
// only gate winners reach a cut and A/B/C/D are all gate winners. The cut is
// chosen once, after the gate claim and before any state read, and is recorded
// on the invocation root span only. Queue mode and an absent/off env value keep
// the unchanged path: no randomness, no span access, no cut.

export type AbcdCut = "A" | "B" | "C" | "D";

// Attribute tag identifying this experiment generation (low cardinality).
export const ABCD_EXPERIMENT_TAG = "inline-v1";

// The pinned @cloudflare/workers-types release predates the documented
// `getActiveSpan` runtime method, so declare it here to annotate the root span
// without a type escape.
declare global {
  interface Tracing {
    getActiveSpan(): Span | undefined;
  }
}

// Minimal structural view of a Span attribute writer, so this module stays
// usable outside the Workers type environment.
export interface AbcdSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value: string): void;
}

// Pure mapping. The caller masks the random byte with & 3 (0..3); any other
// input uses only its low two bits, so 4 -> A, 7 -> D, 255 -> D.
export function pickAbcdCut(byte: number): AbcdCut {
  switch (byte & 3) {
    case 0:
      return "A";
    case 1:
      return "B";
    case 2:
      return "C";
    default:
      return "D";
  }
}

// Only inline mode + strict "1" enables the experiment. The gate claim is
// enforced by call placement (consulted only after the gate is won).
export function isAbcdExperimentEnabled(ingestMode: "inline" | "queue", value: string | undefined): boolean {
  return ingestMode === "inline" && value === "1";
}

// Records the chosen cut (experiment tag + cut letter). Attribute computation
// only; isTraced never decides whether a cut runs.
export function annotateAbcdCut(span: AbcdSpan | undefined, cut: AbcdCut): void {
  if (!span || !span.isTraced) return;
  span.setAttribute("nd.abcd_experiment", ABCD_EXPERIMENT_TAG);
  span.setAttribute("nd.abcd_cut", cut);
}

// Records where the invocation actually went (A/B/C/D, state_recovery, failed).
export function annotateAbcdPath(span: AbcdSpan | undefined, path: string): void {
  if (!span || !span.isTraced) return;
  span.setAttribute("nd.abcd_path", path);
}
