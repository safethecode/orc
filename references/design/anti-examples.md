# Anti-examples: What NOT to Do

Every "Bad" example below is something AI commonly generates. Every "Good" example shows the production-quality alternative. Study the difference — it's in the details.

---

## 1. The Generic Card

**Bad — AI default:**
```html
<div class="rounded-lg bg-white p-4 shadow">
  <h3 class="text-lg font-bold">Title</h3>
  <p class="text-gray-600">Description text here</p>
  <button class="mt-4 rounded bg-blue-500 px-4 py-2 text-white">Click</button>
</div>
```

Problems:
- `rounded-lg` on everything (no hierarchy)
- `bg-white` flat, no border, no depth
- `shadow` — the same generic shadow everywhere
- `bg-blue-500` — Tailwind's default blue (AI's favorite color)
- `font-bold` on title — too heavy for a card heading
- No hover, focus, disabled, or transition states

**Good — production quality:**
```html
<div class="group overflow-hidden rounded-xl border border-border bg-card transition-all duration-200 hover:shadow-md hover:-translate-y-0.5">
  <div class="p-5">
    <h3 class="text-base font-semibold tracking-tight text-foreground">Title</h3>
    <p class="mt-1.5 text-sm leading-relaxed text-muted-foreground">Description text here</p>
    <button class="mt-4 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-all duration-150 hover:bg-primary/90 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50">
      Click
    </button>
  </div>
</div>
```

What changed:
- `rounded-xl` + `border border-border` (border adds definition)
- Semantic colors: `bg-card`, `text-foreground`, `text-muted-foreground` (theme-aware)
- `font-semibold` not `font-bold` (less aggressive)
- `tracking-tight` on heading (optical adjustment)
- `leading-relaxed` on description (more breathable body text)
- `overflow-hidden` + `group` (prepares for image/hover effects)
- Hover: `shadow-md` + `-translate-y-0.5` (subtle lift)
- Button: 5 states defined (default, hover, active, focus, disabled)
- `shadow-xs` on button (tactile depth)
- `h-9` fixed height (consistent across all buttons)

---

## 2. The Boring Grid

**Bad — AI default:**
```html
<div class="grid grid-cols-3 gap-4">
  <div class="rounded-lg bg-white p-4 shadow">Card 1</div>
  <div class="rounded-lg bg-white p-4 shadow">Card 2</div>
  <div class="rounded-lg bg-white p-4 shadow">Card 3</div>
  <div class="rounded-lg bg-white p-4 shadow">Card 4</div>
  <div class="rounded-lg bg-white p-4 shadow">Card 5</div>
  <div class="rounded-lg bg-white p-4 shadow">Card 6</div>
</div>
```

Problems:
- Every card identical — no visual rhythm
- Fixed 3 columns — breaks on mobile
- No responsive gap scaling
- No entrance animation
- Page background likely also white → cards float in void

**Good — with rhythm and responsiveness:**
```html
<!-- Page background is NOT white -->
<div class="bg-gray-50 dark:bg-gray-950">
  <section class="mx-auto max-w-6xl px-4 py-16">
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 lg:gap-5">
      <!-- Featured first card — spans 2 columns on desktop -->
      <div class="col-span-2 row-span-2 rounded-2xl border border-border bg-card p-6 opacity-0 animate-fade-in-up"
           style="animation-delay: 0ms; animation-fill-mode: forwards;">
        <!-- Larger, different treatment for visual anchor -->
      </div>
      <!-- Regular cards with stagger -->
      <div class="rounded-xl border border-border bg-card p-4 opacity-0 animate-fade-in-up"
           style="animation-delay: 75ms; animation-fill-mode: forwards;">Card 2</div>
      <div class="rounded-xl border border-border bg-card p-4 opacity-0 animate-fade-in-up"
           style="animation-delay: 150ms; animation-fill-mode: forwards;">Card 3</div>
      <!-- ... -->
    </div>
  </section>
</div>
```

What changed:
- Page `bg-gray-50` creates contrast with white cards
- Featured card breaks the grid monotony (`col-span-2 row-span-2`)
- `rounded-2xl` on featured vs `rounded-xl` on regular (hierarchy)
- Responsive: 2→3→4 columns with scaling gaps
- Staggered entrance animation (75ms intervals)
- `max-w-6xl` constrains content width (Korean convention)

---

## 3. The Flat Dark Mode

**Bad — AI default (just invert colors):**
```html
<div class="bg-gray-900 text-white">
  <div class="rounded-lg bg-gray-800 p-4 shadow">
    <h3 class="text-white">Title</h3>
    <p class="text-gray-400">Description</p>
  </div>
</div>
```

Problems:
- `bg-gray-900` → `bg-gray-800` — almost no contrast between levels
- `shadow` on dark background — invisible, useless
- Pure gray — cold, lifeless
- No border → cards blend into background

**Good — layered dark mode:**
```html
<div class="bg-gray-950">
  <!-- Card uses border instead of shadow, slightly tinted background -->
  <div class="rounded-xl border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-sm">
    <h3 class="text-base font-semibold text-gray-50">Title</h3>
    <p class="mt-1.5 text-sm leading-relaxed text-gray-400">Description</p>
  </div>
</div>
```

What changed:
- `bg-white/[0.03]` — barely-there transparent white, not solid gray (shows page gradient through)
- `border border-white/[0.08]` — subtle white border replaces shadow
- `backdrop-blur-sm` — glass effect adds depth
- `text-gray-50` not `text-white` — slightly softer than pure white (easier on eyes)
- `bg-gray-950` page background (deepest) vs card (slightly lighter via transparency)

---

## 4. The Generic Hero

**Bad — AI default:**
```html
<section class="bg-blue-500 py-20 text-center text-white">
  <h1 class="text-4xl font-bold">Welcome to Our Platform</h1>
  <p class="mt-4 text-lg">The best solution for your needs</p>
  <button class="mt-8 rounded bg-white px-6 py-3 text-blue-500">Get Started</button>
</section>
```

Problems:
- Flat solid `bg-blue-500` (the most AI color)
- Centered everything (no layout tension)
- Generic copy ("Welcome", "best solution")
- No visual element (image, mockup, illustration)
- No secondary CTA option

**Good — with depth, layout, and personality:**
```html
<section class="relative overflow-hidden bg-gradient-to-br from-gray-950 via-primary-950 to-gray-950">
  <!-- Subtle grid pattern overlay -->
  <div class="absolute inset-0 bg-[url('/grid.svg')] bg-center opacity-[0.03]" />

  <div class="relative mx-auto grid max-w-6xl grid-cols-1 gap-12 px-6 py-24 lg:grid-cols-2 lg:items-center">
    <!-- Text: left-aligned, not centered -->
    <div class="space-y-6">
      <span class="inline-flex items-center gap-2 rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-medium text-primary-400">
        <span class="size-1.5 rounded-full bg-primary-400 animate-pulse" />
        New in v2.0
      </span>
      <h1 class="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
        Build faster with
        <span class="bg-gradient-to-r from-primary-400 to-primary-200 bg-clip-text text-transparent">
          intelligent tools
        </span>
      </h1>
      <p class="max-w-lg text-lg leading-relaxed text-gray-400">
        Ship production-quality interfaces in minutes, not months.
        Design systems that scale with your team.
      </p>
      <div class="flex items-center gap-3">
        <button class="inline-flex h-11 items-center gap-2 rounded-lg bg-primary-500 px-6 font-medium text-white shadow-lg shadow-primary-500/25 transition-all hover:bg-primary-400 active:scale-[0.98]">
          Get started free
          <svg class="size-4"><!-- arrow --></svg>
        </button>
        <button class="inline-flex h-11 items-center gap-2 rounded-lg border border-white/10 px-6 font-medium text-gray-300 transition-all hover:bg-white/5 hover:text-white">
          View demo
        </button>
      </div>
    </div>
    <!-- Visual: product screenshot -->
    <div class="relative">
      <div class="overflow-hidden rounded-xl border border-white/10 shadow-2xl shadow-black/50">
        <img src="..." class="w-full" />
      </div>
      <!-- Glow effect behind image -->
      <div class="absolute -inset-4 -z-10 rounded-2xl bg-primary-500/10 blur-3xl" />
    </div>
  </div>
</section>
```

What changed:
- Gradient background: `from-gray-950 via-primary-950 to-gray-950` (depth, not flat)
- Grid pattern overlay at 3% opacity (texture)
- 2-column layout: text left, visual right (asymmetry, tension)
- Badge with animated dot (draws attention, feels live)
- Gradient text on key phrase (visual anchor)
- `shadow-lg shadow-primary-500/25` — colored shadow glow on CTA
- Two CTAs: primary (filled) + secondary (ghost) — gives user choice
- Screenshot with glow: `blur-3xl` behind image creates depth
- `tracking-tight` on headline (optical adjustment for large text)

---

## 5. Missing States

**Bad — button with only default state:**
```html
<button class="rounded bg-blue-500 px-4 py-2 text-white">Submit</button>
```

**Good — complete state coverage:**
```html
<button class="
  inline-flex h-10 items-center justify-center gap-2
  rounded-md bg-primary px-5
  text-sm font-medium text-primary-foreground
  shadow-xs
  transition-all duration-150
  hover:bg-primary/90
  active:scale-[0.98] active:shadow-none
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2
  disabled:pointer-events-none disabled:opacity-50
  [&_svg]:size-4 [&_svg]:shrink-0
">
  Submit
</button>
```

**Loading state:**
```html
<button class="... pointer-events-none" disabled>
  <svg class="size-4 animate-spin"><!-- spinner --></svg>
  Submitting...
</button>
```

Every interactive element needs: default → hover → active → focus → disabled → loading.

---

## 6. Typography Mistakes

**Bad:**
```html
<h1 class="text-3xl font-bold">Big Heading Here</h1>
<h2 class="text-2xl font-bold">Medium Heading</h2>
<h3 class="text-xl font-bold">Small Heading</h3>
<p class="text-base">Body text goes here with some content.</p>
```

Problems:
- All headings use `font-bold` (no weight hierarchy)
- No letter-spacing adjustment for large text
- No line-height variation
- Same color for everything

**Good:**
```html
<h1 class="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">Big Heading</h1>
<h2 class="text-2xl font-semibold tracking-tight text-foreground">Medium Heading</h2>
<h3 class="text-lg font-semibold text-foreground">Small Heading</h3>
<p class="text-sm leading-relaxed text-muted-foreground">Body text with proper leading.</p>
```

Rules:
- `font-bold` (700) only for h1, `font-semibold` (600) for h2-h3
- `tracking-tight` on text >= 24px (optical compensation)
- `leading-relaxed` on body (especially Korean text)
- Body is `text-muted-foreground` (lighter than headings → hierarchy)
- Responsive heading sizes: `text-4xl sm:text-5xl`

---

## Summary: The AI-to-Professional Upgrade Checklist

| AI Default | Professional Fix |
|-----------|-----------------|
| `bg-white` flat cards | `bg-card border border-border` with semantic tokens |
| `shadow` everywhere | Varied elevation: `shadow-xs`, `shadow-sm`, `shadow-md`, `shadow-lg` |
| `rounded-lg` everything | Hierarchy: `rounded-sm` → `rounded-md` → `rounded-xl` → `rounded-2xl` |
| `bg-blue-500` accent | Project-specific primary color from oklch palette |
| No hover states | `hover:` + `active:` + `focus-visible:` + `disabled:` on every interactive |
| No transitions | `transition-all duration-150` minimum |
| Fixed grid columns | Responsive: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` |
| Centered hero | Asymmetric 2-column with visual element |
| Dark = invert | Transparent layers + borders + backdrop-blur |
| Same-size headings | Weight + tracking + color hierarchy |
| No animations | Staggered fade-in-up on grid items |
| No loading state | Skeleton + spinner + disabled states |
