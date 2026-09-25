import type { ReactNode } from "react";

export function LocalTooltip({ label, position = "bottom", className = "", children }: { label: string; position?: "top" | "bottom"; className?: string; children: ReactNode }) {
  return <span className={`local-tooltip-control local-tooltip-${position} ${className}`.trim()}><span className="local-tooltip-target">{children}</span><span className="local-tooltip" role="tooltip">{label}</span></span>;
}
