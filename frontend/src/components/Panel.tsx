import type { ReactNode } from "react";

interface Props {
  title: string;
  /** Short context shown beside the title (units, scope). */
  aside?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
  children: ReactNode;
}

/** A terminal pane: a hairline-ruled title bar over a content area. */
export function Panel({ title, aside, actions, className = "", bodyClassName = "", testId, children }: Props) {
  return (
    <section data-testid={testId} className={`flex h-full min-h-0 min-w-0 flex-col bg-panel ${className}`}>
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-rule px-3">
        <h2 className="shrink-0 text-[12.5px] font-semibold whitespace-nowrap text-text" style={{ fontStretch: "110%" }}>
          {title}
        </h2>
        {aside && <div className="min-w-0 truncate text-[11px] text-faint">{aside}</div>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
