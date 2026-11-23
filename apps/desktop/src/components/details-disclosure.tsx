import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** A native disclosure keeps keyboard and screen reader behavior consistent across the inspector. */
export function DetailsDisclosure({
  title,
  icon,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  icon: ReactNode;
  count?: number;
  /** Shown open at first; a person can still close it. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="inspector-disclosure" open={defaultOpen}>
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
