import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-shimmer rounded-md bg-accent bg-[linear-gradient(100deg,transparent_30%,var(--shimmer)_50%,transparent_70%)] bg-[length:200%_100%] bg-no-repeat motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
