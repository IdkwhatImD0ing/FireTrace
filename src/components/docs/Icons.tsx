/**
 * Line icons for the docs cards and the MCP setup tiles. Drawn here rather
 * than pulled from an icon package: the set is small, and the docs pipeline
 * carries no dependencies of its own.
 */
const PATHS = {
  terminal: "M4 6l4 4-4 4M11 14h5",
  braces:
    "M9 3.5H8a2 2 0 0 0-2 2V8L4 10l2 2v2.5a2 2 0 0 0 2 2h1M11 3.5h1a2 2 0 0 1 2 2V8l2 2-2 2v2.5a2 2 0 0 1-2 2h-1",
  plug: "M7 3v4M13 3v4M5 7h10v3a5 5 0 0 1-10 0zM10 15v2.5",
  code: "M7.5 6.5L4 10l3.5 3.5M12.5 6.5L16 10l-3.5 3.5",
  agent:
    "M10 3v2M5.5 5h9a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 14.5 15h-9A1.5 1.5 0 0 1 4 13.5v-7A1.5 1.5 0 0 1 5.5 5zM7.5 9v1.5M12.5 9v1.5",
  spark: "M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z",
  database:
    "M10 3.5c3.3 0 6 .9 6 2s-2.7 2-6 2-6-.9-6-2 2.7-2 6-2zM4 5.5v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9M4 10c0 1.1 2.7 2 6 2s6-.9 6-2",
  list: "M4 6h12M4 10h12M4 14h7",
  check: "M4 10.5l3.5 3.5L16 5.5",
  layers: "M10 3l6 3.5-6 3.5-6-3.5zM4 10l6 3.5 6-3.5M4 13.5L10 17l6-3.5",
  key: "M12.5 3.5a4 4 0 1 0-2.9 6.8L4 15.9V17h2.2l.9-.9h1.6v-1.6h1.6l1-1a4 4 0 0 0 1.2-10z",
  pencil: "M13.5 3.5l3 3L7 16H4v-3zM11.5 5.5l3 3",
  refresh: "M16 5.5v4h-4M4 14.5v-4h4M5 8a5.5 5.5 0 0 1 9.6-2M15 12a5.5 5.5 0 0 1-9.6 2",
  shield: "M10 3l6 2v4.5c0 3.4-2.4 6.4-6 7.5-3.6-1.1-6-4.1-6-7.5V5z",
  gauge: "M4 14a6 6 0 1 1 12 0M10 14l3-4",
  book: "M4 4.5h4a2 2 0 0 1 2 2V16a2 2 0 0 0-2-2H4zM16 4.5h-4a2 2 0 0 0-2 2V16a2 2 0 0 1 2-2h4z",
  package: "M10 3l6 3v8l-6 3-6-3V6zM4 6l6 3 6-3M10 9v8",
  github:
    "M7.5 16.5c-3 1-3-1.7-4.2-2m8.4 3.5v-2.7c0-.8-.1-1.1-.5-1.4 2.3-.3 4.3-1.1 4.3-4.7a3.6 3.6 0 0 0-1-2.5 3.4 3.4 0 0 0-.1-2.5s-.8-.3-2.7 1a9.2 9.2 0 0 0-4.8 0C5 3.1 4.2 3.4 4.2 3.4a3.4 3.4 0 0 0-.1 2.5 3.6 3.6 0 0 0-1 2.5c0 3.6 2 4.4 4.3 4.7-.3.3-.5.7-.5 1.4v2.8",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
