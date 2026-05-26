import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground border border-border",
        primary: "bg-primary/15 text-primary border border-primary/30",
        success:
          "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
        warn:
          "bg-amber-500/15 text-amber-300 border border-amber-500/30",
        destructive:
          "bg-destructive/15 text-destructive border border-destructive/30",
        muted: "bg-muted text-muted-foreground border border-border/60",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
