import type { SpanKind, TraceStatus } from "./schema";

/**
 * Categorical colors for span kinds, validated against the dark surface
 * (#171411) with the dataviz palette checker: lightness band, chroma floor,
 * adjacent CVD separation, normal-vision floor and 3:1 contrast all pass for
 * the seven hues in this order. "custom" is the neutral "other" slot so an
 * eighth hue is never invented. Kind is always shown as text beside the mark.
 */
export const KIND_COLOR: Record<SpanKind, string> = {
  agent: "#3987e5",
  llm: "#d95926",
  tool: "#199e70",
  retriever: "#c98500",
  chain: "#d55181",
  embedding: "#008300",
  reranker: "#9085e9",
  custom: "#8a857c",
};

export const STATUS_LABEL: Record<TraceStatus, string> = {
  ok: "ok",
  error: "error",
  unset: "unset",
};
