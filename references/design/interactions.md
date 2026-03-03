# Interaction & Animation Patterns

Production-quality interaction patterns extracted from elevenlabs/ui and square-ui. These are the details that separate polished UI from AI-generated defaults.

## Button System (cva pattern — elevenlabs/ui)

Complete button with all states, icon handling, and accessibility:

```tsx
const buttonVariants = cva(
  [
    // Structure
    "inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0",
    "rounded-md text-sm font-medium",
    // Transitions
    "transition-all duration-150",
    // Disabled
    "disabled:pointer-events-none disabled:opacity-50",
    // Icon auto-sizing: any SVG child gets sized automatically
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
    // Focus ring
    "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2",
    // Accessibility
    "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:scale-[0.98]",
        destructive: "bg-destructive text-white shadow-xs hover:bg-destructive/90 active:scale-[0.98]",
        outline: [
          "border bg-background shadow-xs",
          "hover:bg-accent hover:text-accent-foreground",
          "dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        ],
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",       // Smaller padding when only icon
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",                                     // Square for icon-only buttons
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);
```

**Key techniques:**
- `[&_svg]:size-4` — child SVGs are auto-sized without manual className
- `has-[>svg]:px-3` — padding shrinks when button contains only an icon (CSS `:has()`)
- `active:scale-[0.98]` — subtle press effect (2% shrink, not 5%)
- `shadow-xs` — the lightest possible shadow for tactile feel
- Dark mode variants per-button: `dark:bg-input/30` (not just color inversion)

## Entrance Animations

### Fade-in Variants (elevenlabs/ui)

```css
/* Basic fade with scale — feels like emerging from behind */
@keyframes fade-in {
  from { opacity: 0; transform: scale(0.95) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* Directional entrances */
@keyframes fade-in-up {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes fade-in-down {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes fade-in-left {
  from { opacity: 0; transform: translateX(-20px); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes fade-in-right {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}

/* Scale entrance — for modals and popovers */
@keyframes fade-in-scale {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}
```

### Timing Functions

```css
/* Easing choices by context */
--ease-default: cubic-bezier(0.4, 0, 0.2, 1);     /* Material standard */
--ease-in: cubic-bezier(0.4, 0, 1, 1);              /* For exits */
--ease-out: cubic-bezier(0, 0, 0.2, 1);             /* For entrances */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);     /* Dramatic entrance, quick settle */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);   /* Bouncy, playful */
```

When to use which:
- **Page/section entrance**: `ease-out-expo` + 400-600ms (dramatic but quick)
- **Hover state**: `ease-default` + 150ms (snappy response)
- **Modal open**: `ease-out` + 200-300ms (smooth reveal)
- **Dropdown/menu**: `ease-out` + 150-200ms (fast utility)
- **Exit/close**: `ease-in` + 100-150ms (faster than entrance)

### Duration Scale

| Duration | Use Case | Tailwind |
|----------|----------|----------|
| 75ms | Color changes on hover | `duration-75` |
| 150ms | Button press, toggle state | `duration-150` |
| 200ms | Card hover, dropdown open | `duration-200` |
| 300ms | Modal/dialog, tab switch | `duration-300` |
| 400ms | Section entrance, page transition | `duration-400` |
| 500ms | Hero animation, image zoom | `duration-500` |
| 700ms+ | Decorative, parallax | Custom |

## Staggered Grid Entrance

Cards in a grid should not appear simultaneously. Stagger them:

```tsx
// React pattern
{items.map((item, i) => (
  <div
    key={item.id}
    className="opacity-0 animate-fade-in-up"
    style={{
      animationDelay: `${i * 75}ms`,
      animationFillMode: 'forwards',
      animationDuration: '400ms',
      animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    }}
  >
    <Card item={item} />
  </div>
))}
```

Rules:
- 75ms delay between items (fast enough to feel connected, slow enough to see)
- Cap at 8-12 items (beyond that, remaining items appear instantly)
- First item has 0ms delay (something visible immediately)

## Scroll Fade Overlay

For scrollable containers (tables, lists, sidebars):

```html
<!-- Container -->
<div class="relative overflow-hidden">
  <!-- Scrollable content -->
  <div class="max-h-[400px] overflow-y-auto">
    <!-- content -->
  </div>

  <!-- Top fade (only if scrolled down) -->
  <div class="pointer-events-none absolute left-0 right-0 top-0 h-8 bg-gradient-to-b from-background to-transparent" />

  <!-- Bottom fade (always visible) -->
  <div class="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-background to-transparent" />
</div>
```

**Key:** `pointer-events-none` prevents the overlay from blocking clicks on content underneath.

## Navigation Scroll Behavior

### Sticky Nav with Backdrop Blur

```html
<nav class="
  sticky top-0 z-50
  border-b border-transparent
  bg-background/80 backdrop-blur-md
  transition-all duration-300
  data-[scrolled=true]:border-border
  data-[scrolled=true]:shadow-sm
">
```

The nav starts transparent and gains border + shadow on scroll. Use `data-[scrolled]` attribute toggled via IntersectionObserver or scroll listener.

### Mobile Bottom Tab Bar

```html
<nav class="
  fixed bottom-0 left-0 right-0 z-50
  flex h-14 items-stretch
  border-t border-border bg-background/95 backdrop-blur-sm
  safe-area-pb
">
  <a class="
    flex flex-1 flex-col items-center justify-center gap-0.5
    text-[10px] font-medium text-muted-foreground
    transition-colors duration-150
    aria-[current=page]:text-primary
  ">
    <svg class="size-5" />
    <span>Home</span>
  </a>
  <!-- More tabs... -->
</nav>
```

**Key:** `safe-area-pb` for iPhone notch/home indicator spacing. Tab text is `text-[10px]` not `text-xs` (precise sizing).

## Tooltip & Popover Animations

```css
/* Enter from below */
[data-state="open"] {
  animation: tooltip-in 0.15s cubic-bezier(0, 0, 0.2, 1);
}
[data-state="closed"] {
  animation: tooltip-out 0.1s cubic-bezier(0.4, 0, 1, 1);
}

@keyframes tooltip-in {
  from { opacity: 0; transform: translateY(4px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes tooltip-out {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(2px) scale(0.98); }
}
```

Exit is faster and smaller movement than entrance (asymmetric timing).

## Focus Management

```css
/* Focus ring that works on both light and dark */
.focus-ring {
  outline: none;
}
.focus-ring:focus-visible {
  box-shadow:
    0 0 0 2px var(--background),     /* Inner gap (matches bg) */
    0 0 0 4px var(--ring);            /* Outer ring (primary color) */
}
```

Double ring technique: inner ring matches background color, outer ring is the visible focus indicator. Works on any background.

## Reduced Motion

Always provide fallbacks:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

This preserves final animation states (elements still appear) but removes motion.
