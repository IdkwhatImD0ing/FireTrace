import { ImageResponse } from "next/og";

export const alt = "FireTrace — LLM traces that do not expire";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The brand mark from icon.svg, scaled from its 32px viewBox to 120px. */
const S = 120 / 32;
const BARS = [
  [7, 9, 18, 3],
  [10, 15, 10, 3],
  [14, 21, 11, 3],
];

/** Social card for every route that does not define its own. */
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: "#0e0d0b",
        backgroundImage:
          "radial-gradient(900px 500px at 85% 0%, rgba(240,129,58,0.20), rgba(14,13,11,0))",
        padding: "0 84px",
        color: "#efe9df",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
        <div
          style={{
            display: "flex",
            position: "relative",
            width: 120,
            height: 120,
            borderRadius: 8 * S,
            backgroundImage: "linear-gradient(135deg, #ffb27a, #d95926)",
          }}
        >
          {BARS.map(([x, y, w, h]) => (
            <div
              key={`${x}-${y}`}
              style={{
                position: "absolute",
                left: x * S,
                top: y * S,
                width: w * S,
                height: h * S,
                borderRadius: 1.5 * S,
                background: "#1a0d04",
              }}
            />
          ))}
        </div>
        <div style={{ fontSize: 60, letterSpacing: -1 }}>FireTrace</div>
      </div>
      <div style={{ marginTop: 52, fontSize: 76, lineHeight: 1.1, letterSpacing: -2 }}>
        LLM traces that do not expire.
      </div>
      <div style={{ marginTop: 26, fontSize: 32, color: "#b7ada0" }}>
        Self-deployed on Vercel. Stored in your own Firebase project.
      </div>
    </div>,
    size,
  );
}
