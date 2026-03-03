# Polished Card Patterns

Real production card patterns extracted from square-ui and elevenlabs/ui. Use these as the baseline quality standard — never produce cards simpler than these.

## 1. Stat Card (Dashboard — square-ui)

The double-container pattern creates visual depth that flat cards lack.

```html
<div class="relative overflow-hidden rounded-xl border border-border bg-card p-4">
  <div class="flex items-start justify-between gap-4">
    <!-- Left: Label + Value -->
    <div class="space-y-1">
      <p class="text-sm text-muted-foreground">Total Revenue</p>
      <p class="text-2xl font-semibold tracking-tight">$45,231.89</p>
      <div class="flex items-center gap-1 text-xs">
        <span class="text-emerald-600 dark:text-emerald-400">+20.1%</span>
        <span class="text-muted-foreground">vs last month</span>
      </div>
    </div>
    <!-- Right: Icon in muted container (NOT floating icon) -->
    <div class="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
      <svg class="size-6 text-muted-foreground"><!-- icon --></svg>
    </div>
  </div>
</div>
```

**Why it works:**
- Icon sits in its own container with border + bg (depth, not floating)
- `tracking-tight` on the value number (optical tightness at large sizes)
- Trend color is semantic: emerald for positive, not generic blue
- `shrink-0` on icon container prevents layout collapse
- `space-y-1` between label/value is tighter than default

## 2. Marketing Stats Card (Nested Container — square-ui)

```html
<div class="rounded-lg border bg-muted/30 p-3 flex flex-col gap-3">
  <!-- Header row -->
  <div class="flex items-center justify-between">
    <span class="text-sm font-medium text-muted-foreground">Visitors</span>
    <svg class="size-3.5 text-muted-foreground"><!-- icon --></svg>
  </div>
  <!-- Inner elevated card -->
  <div class="rounded-md border bg-card p-3 flex items-center justify-between">
    <span class="text-2xl font-semibold tracking-tight">12,486</span>
    <div class="flex items-center gap-1">
      <svg class="size-3.5 text-emerald-600 dark:text-emerald-400"><!-- trend up --></svg>
      <span class="text-xs font-medium text-emerald-600 dark:text-emerald-400">+12.5%</span>
    </div>
  </div>
</div>
```

**Why it works:**
- Outer: `bg-muted/30` (30% opacity!) not solid — subtle, breathable
- Inner: `bg-card` with its own border — clearly elevated above outer
- Two distinct visual layers without heavy shadows
- Icon size `size-3.5` (14px) — precisely sized for small UI, not default `size-4`

## 3. Product Card (Marketplace — Korean convention)

```html
<div class="group overflow-hidden rounded-lg border border-border bg-card transition-all duration-200 hover:shadow-md hover:-translate-y-0.5">
  <!-- Image with badges -->
  <div class="relative aspect-[4/3] overflow-hidden">
    <img class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
    <!-- Badges: absolute positioned -->
    <div class="absolute left-2 top-2 flex gap-1">
      <span class="rounded-sm bg-red-500 px-1.5 py-0.5 text-[11px] font-bold text-white">HOT</span>
      <span class="rounded-sm bg-primary-500 px-1.5 py-0.5 text-[11px] font-bold text-white">30%</span>
    </div>
    <!-- Duration overlay (for video/course) -->
    <span class="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white backdrop-blur-sm">
      32:15
    </span>
  </div>
  <!-- Content -->
  <div class="space-y-2 p-3">
    <span class="text-xs text-muted-foreground">Finance</span>
    <h3 class="line-clamp-2 text-sm font-semibold leading-snug">
      Building Wealth: Complete Investment Strategy for Beginners
    </h3>
    <div class="flex items-center gap-1.5">
      <img class="size-5 rounded-full" />
      <span class="text-xs text-muted-foreground">John Kim</span>
    </div>
    <div class="flex items-center gap-1 text-xs">
      <span class="text-amber-500">★★★★★</span>
      <span class="text-muted-foreground">(1,234)</span>
    </div>
    <div class="flex items-baseline gap-2">
      <span class="text-base font-bold">39,000원</span>
      <span class="text-xs text-muted-foreground line-through">49,000원</span>
    </div>
  </div>
</div>
```

**Why it works:**
- `group` + `group-hover:scale-105` on image (hover zoom without JS)
- `aspect-[4/3]` maintains consistent image ratio across grid
- Badge uses `text-[11px]` — custom size, not default scale (precision)
- `line-clamp-2` prevents title overflow with proper truncation
- `leading-snug` tightens multi-line title spacing
- Avatar `size-5` (20px) not 24/28 — proportional to card density
- Price layout: `items-baseline` aligns different text sizes on their baselines
- `bg-black/70 backdrop-blur-sm` on duration tag — readable but see-through

## 4. Feature Card (SaaS — Dark Theme)

```html
<div class="group rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm transition-all duration-300 hover:border-white/20 hover:bg-white/[0.08]">
  <!-- Icon with gradient background -->
  <div class="mb-4 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 shadow-lg shadow-primary-500/20">
    <svg class="size-6 text-white"><!-- icon --></svg>
  </div>
  <!-- Content -->
  <h3 class="mb-2 text-lg font-semibold text-white">Real-time Analytics</h3>
  <p class="mb-4 line-clamp-3 text-sm leading-relaxed text-white/60">
    Track your metrics in real-time with our advanced dashboard.
    Get instant insights and make data-driven decisions.
  </p>
  <a class="inline-flex items-center gap-1 text-sm font-medium text-primary-400 transition-colors hover:text-primary-300">
    Learn more
    <svg class="size-3.5 transition-transform group-hover:translate-x-0.5"><!-- arrow --></svg>
  </a>
</div>
```

**Why it works:**
- `bg-white/5` not solid dark — transparent, shows page gradient through card
- `border-white/10` → `hover:border-white/20` — subtle border brightening on hover
- Icon container has `shadow-lg shadow-primary-500/20` — colored shadow glow
- `text-white/60` on description — not full white, creates hierarchy
- Arrow `group-hover:translate-x-0.5` — micro-animation on hover (3px movement)
- `rounded-2xl` for premium feel (larger than standard `rounded-xl`)

## 5. Content Card (Community — Image-first)

```html
<div class="group overflow-hidden rounded-xl bg-card">
  <!-- Full-bleed image with gradient overlay -->
  <div class="relative aspect-[3/2] overflow-hidden">
    <img class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
    <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
    <h3 class="absolute bottom-3 left-3 right-3 text-base font-semibold text-white drop-shadow-sm">
      My Living Room Makeover
    </h3>
  </div>
  <!-- Metadata -->
  <div class="flex items-center justify-between p-3">
    <div class="flex items-center gap-2">
      <img class="size-6 rounded-full ring-1 ring-border" />
      <span class="text-xs text-muted-foreground">Designer Kim · 2h</span>
    </div>
    <div class="flex items-center gap-3 text-xs text-muted-foreground">
      <span class="flex items-center gap-1">♡ 234</span>
      <span class="flex items-center gap-1">💬 12</span>
    </div>
  </div>
</div>
```

**Why it works:**
- `scale-[1.03]` not `scale-105` — 3% zoom is subtle enough to feel natural
- `duration-500` on image scale — slower than card hover for cinematic feel
- Gradient overlay: `from-black/60 via-transparent` — only darkens bottom third
- Avatar has `ring-1 ring-border` — tiny border prevents blending into background
- `drop-shadow-sm` on title text — ensures readability on any image
