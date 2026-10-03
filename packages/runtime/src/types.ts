/** Public result types — no @effigent/core imports here (core is inlined by the bundle, not installed). */
export interface UploadResult {
  ok: boolean;
  status: number;
  sessionId: string;
  detail?: string;
  /** Step payloads were cut locally to fit the collector's body cap. */
  truncated?: boolean;
}
