import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { DayPicker, getDefaultClassNames } from "react-day-picker"
import { cn } from "@/lib/utils"

// Calendar for react-day-picker v10 (the shadcn original targets v9 and replaces our Button). Same class-slot approach, token colours
// only, day buttons 40px so a thumb hits them (touch: 44px, the phone size). Range ends use the primary colour, the days between them a
// faint tint of it. `components` adds to the built-in ones (a custom DayButton, say); `touch` sizes the day and nav buttons at 44px.
function Calendar({
  className,
  classNames,
  components,
  showOutsideDays = true,
  touch = false,
  ...props
}) {
  const d = getDefaultClassNames()
  const cell = touch ? "size-11" : "size-10"

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        root: cn("w-fit", d.root),
        months: cn("relative flex flex-col gap-4 sm:flex-row", d.months),
        month: cn("flex w-full flex-col gap-3", d.month),
        nav: cn("absolute inset-x-0 top-0 flex w-full items-center justify-between", d.nav),
        button_previous: cn("grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground aria-disabled:opacity-40", cell, d.button_previous),
        button_next: cn("grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground aria-disabled:opacity-40", cell, d.button_next),
        month_caption: cn("flex h-10 w-full items-center justify-center px-10", d.month_caption),
        caption_label: cn("text-sm font-bold select-none", d.caption_label),
        month_grid: cn("w-full border-collapse", d.month_grid),
        weekdays: cn("flex", d.weekdays),
        weekday: cn("flex-1 text-center font-mono text-micro font-medium text-muted-foreground uppercase select-none", d.weekday),
        week: cn("mt-1 flex w-full", d.week),
        day: cn("group/day p-0 text-center text-sm select-none", cell, d.day),
        day_button: cn(cell, "rounded-md font-medium transition-colors outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring", d.day_button),
        selected: cn("font-bold", d.selected),
        range_start: cn("rounded-l-md bg-primary/15 [&_button]:bg-primary [&_button]:text-primary-foreground [&_button:hover]:bg-primary", d.range_start),
        range_middle: cn("bg-primary/15", d.range_middle),
        range_end: cn("rounded-r-md bg-primary/15 [&_button]:bg-primary [&_button]:text-primary-foreground [&_button:hover]:bg-primary", d.range_end),
        today: cn("[&_button]:ring-1 [&_button]:ring-primary/70", d.today),
        outside: cn("text-muted-foreground/60", d.outside),
        disabled: cn("opacity-40", d.disabled),
        hidden: cn("invisible", d.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: c }) => (orientation === "left"
          ? <ChevronLeftIcon className={cn("size-4", c)} aria-hidden="true" />
          : <ChevronRightIcon className={cn("size-4", c)} aria-hidden="true" />),
        ...components,
      }}
      {...props}
    />
  )
}

export { Calendar }
