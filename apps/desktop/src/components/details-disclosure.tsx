import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** A native disclosure keeps keyboard and screen reader behavior consistent across the inspector. */
export function DetailsDisclosure({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  return (
    <details className="inspector-disclosure">
      <summary>
        {icon}
        <span>{title}</span>
        {count !== undefined && <small>{count}</small>}
        <ChevronRight className="inspector-chevron" size={14} aria-hidden />
      </summary>
      <div className="inspector-disclosure-body">{children}</div>
    </details>
  );
}
