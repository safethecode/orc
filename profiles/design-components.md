---
name: design-components
description: Component-Level Reference Library — Real patterns extracted from 36 production services
linked_to: design.md
---

# Component-Level Reference Library

> Extracted from 36 production services (KR-1~KR-14, GL-1~GL-38).
> Each pattern shows the REAL approach used by production products, not theoretical best practices.

---

## 1. Navigation

### Top Nav — Sticky Light (GL-1, KR-1, KR-2)

```html
<!-- GL-1 style: 48px, bg-blur, tab-based active state -->
<header class="sticky top-0 z-50 border-b border-gray-200 bg-white/80 backdrop-blur-md">
  <div class="mx-auto flex h-12 max-w-6xl items-center justify-between px-4">
    <div class="flex items-center gap-6">
      <span class="text-sm font-semibold tracking-tight">Brand</span>
      <nav class="flex items-center gap-1">
        <a class="rounded-md bg-gray-100 px-3 py-1.5 text-[13px] font-medium text-gray-900">Active</a>
        <a class="rounded-md px-3 py-1.5 text-[13px] text-gray-500 hover:bg-gray-50 transition-colors cursor-pointer">Item</a>
      </nav>
    </div>
    <div class="flex items-center gap-3">
      <button class="rounded-md border border-gray-200 px-3 py-1.5 text-[13px] text-gray-500 hover:bg-gray-50 transition-colors cursor-pointer">Action</button>
      <div class="h-7 w-7 rounded-full bg-blue-500 flex items-center justify-center">
        <span class="text-[11px] font-medium text-white">U</span>
      </div>
    </div>
  </div>
</header>
```

**Key traits**: h-12 (48px), backdrop-blur-md, bg-white/80, text-[13px], rounded-md active bg

### Top Nav — Marketing (KR-2, GL-3)

```html
<!-- KR-2 style: 56px, pill CTA, sparse links -->
<header class="sticky top-0 z-50 border-b border-gray-200/60 bg-white/80 backdrop-blur-md">
  <div class="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
    <div class="flex items-center gap-8">
      <span class="text-[15px] font-bold tracking-tight text-indigo-800">Brand</span>
      <nav class="flex items-center gap-6">
        <a class="text-[13px] text-gray-500 hover:text-gray-900 transition-colors cursor-pointer">Link</a>
      </nav>
    </div>
    <div class="flex items-center gap-3">
      <a class="text-[13px] text-gray-500 hover:text-gray-900 transition-colors cursor-pointer">Login</a>
      <button class="rounded-full bg-indigo-800 px-4 py-2 text-[13px] font-medium text-white hover:bg-indigo-900 transition-colors cursor-pointer">CTA</button>
    </div>
  </div>
</header>
```

**Key traits**: h-14, rounded-full pill CTA, gap-8 between logo and nav, text-[13px]

### Top Nav — Dark (KR-6, GL-34)

```html
<!-- KR-6 style: Dark unified, white/opacity text -->
<header class="border-b border-white/5 bg-[#14141e] px-5 py-3">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-6">
      <span class="text-[14px] font-semibold text-white/90">Brand</span>
      <nav class="flex items-center gap-1">
        <a class="rounded-md px-3 py-1.5 text-[13px] text-white/40 hover:bg-white/5 transition-colors cursor-pointer">Item</a>
        <a class="rounded-md bg-white/8 px-3 py-1.5 text-[13px] font-medium text-white/90">Active</a>
      </nav>
    </div>
  </div>
</header>
```

**Key traits**: border-white/5, text-white/40 (inactive), bg-white/8 (active), hover:bg-white/5

### DO NOT

- Dark sidebar + light content (mood mismatch)
- Gradient nav backgrounds
- Logo larger than 15px font
- More than 5 nav items at top level

---

## 2. Buttons

### Primary — Solid (GL-1, KR-1)

```html
<button class="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5
  text-[13px] font-medium text-white hover:bg-blue-700 transition-colors cursor-pointer">
  <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
    <path d="M12 4v16m8-8H4"/>
  </svg>
  Label
</button>
```

**Sizes**: h-7 compact (28px) | h-8 default (32px) | h-9 comfortable (36px)

### Primary — Pill (KR-2, GL-3)

```html
<button class="rounded-full bg-indigo-800 px-6 py-2.5 text-[14px] font-medium text-white
  hover:bg-indigo-900 transition-colors cursor-pointer">
  Label
</button>
```

### Secondary — Border (GL-1, GL-3)

```html
<button class="rounded-md border border-gray-200 px-3 py-1.5 text-[13px] text-gray-500
  hover:bg-gray-50 transition-colors cursor-pointer">
  Label
</button>
```

### Ghost / Tertiary

```html
<button class="rounded-md px-3 py-1.5 text-[13px] text-gray-500
  hover:bg-gray-50 transition-colors cursor-pointer">
  Label
</button>
```

### Dark Mode Button (KR-6)

```html
<button class="rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white
  hover:bg-blue-700 transition-colors cursor-pointer">
  Label
</button>
<button class="rounded-md border border-white/10 px-2.5 py-1 text-[12px] text-white/50
  hover:bg-white/5 transition-colors cursor-pointer">
  Label
</button>
```

### DO NOT

- `hover:scale-*` on any button
- `shadow-*` on buttons (except focus ring)
- Gradient backgrounds (`from-X to-Y`)
- More than 2 button variants on one screen
- `rounded-2xl` or `rounded-3xl` (use `rounded-md` or `rounded-full`)

---

## 3. Cards

### Stat Card — Light (KR-1, GL-1)

```html
<div class="rounded-md border border-gray-200 bg-white p-4">
  <p class="text-[12px] font-medium text-gray-400">Label</p>
  <p class="mt-1 text-2xl font-bold tracking-tight">1,284</p>
  <p class="mt-1 text-[12px] text-blue-500 font-medium">+12.3% vs last week</p>
</div>
```

**Key traits**: border-only (NO shadow), rounded-md, p-4, text-2xl for value

### Feature Card — Light (KR-2)

```html
<article class="rounded-md border border-gray-200 bg-white p-5">
  <div class="mb-3 flex h-8 w-8 items-center justify-center rounded-md bg-indigo-50 text-indigo-800">
    <svg class="h-4 w-4"><!-- icon --></svg>
  </div>
  <h3 class="text-[14px] font-semibold">Title</h3>
  <p class="mt-1.5 text-[13px] leading-relaxed text-gray-500">Description text here.</p>
</article>
```

**Key traits**: 8x8 icon container with bg-indigo-50, rounded-md, p-5

### Card on Dark (KR-6)

```html
<div class="rounded-md border border-white/5 bg-white/[0.02] p-4">
  <p class="text-[12px] text-white/30">Label</p>
  <p class="mt-1 text-xl font-bold text-white/90">Value</p>
</div>
```

### DO NOT

- `shadow-*` on cards (use border only)
- `rounded-xl` or larger (use rounded-md: 6px)
- Gradient backgrounds on cards
- `hover:scale-*` on cards
- Different styles per card in a grid (uniform grid = production)

---

## 4. Data Tables

### Light Table (GL-1, KR-1)

```html
<section class="rounded-md border border-gray-200 bg-white">
  <!-- Header bar -->
  <div class="flex items-center justify-between border-b border-gray-100 px-4 py-3">
    <h2 class="text-[13px] font-semibold">Title</h2>
    <div class="flex items-center gap-2">
      <button class="rounded-md border border-gray-200 px-2.5 py-1 text-[12px] text-gray-500
        hover:bg-gray-50 transition-colors cursor-pointer">Filter</button>
    </div>
  </div>
  <table class="w-full">
    <thead>
      <tr class="border-b border-gray-100">
        <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">Column</th>
      </tr>
    </thead>
    <tbody class="text-[13px]">
      <tr class="border-b border-gray-100/50 hover:bg-gray-50 transition-colors cursor-pointer">
        <td class="px-4 py-2.5 font-medium">Cell</td>
      </tr>
    </tbody>
  </table>
</section>
```

**Key traits**:
- Header: text-[11px] uppercase tracking-wider text-gray-400
- Cells: text-[13px], py-2.5 (row height ~40px)
- Hover: bg-gray-50 only (no scale, no shadow)
- Borders: border-gray-100/50 between rows

### Dark Table (KR-6)

```html
<div class="rounded-md border border-white/5 overflow-hidden">
  <table class="w-full">
    <thead>
      <tr class="border-b border-white/5 bg-white/[0.02]">
        <th class="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-white/30">Column</th>
      </tr>
    </thead>
    <tbody class="text-[13px]">
      <tr class="border-b border-white/5 hover:bg-white/[0.02] transition-colors cursor-pointer">
        <td class="px-4 py-2.5 font-medium text-white/90">Cell</td>
        <td class="px-4 py-2.5 text-white/50">Secondary</td>
        <td class="px-4 py-2.5"><span class="font-mono text-[12px] text-white/40">monospace</span></td>
      </tr>
    </tbody>
  </table>
</div>
```

### Status Indicators (GL-1 style)

```html
<!-- Dot status — NOT colored badges -->
<span class="inline-flex items-center gap-1.5">
  <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
  <span class="text-gray-500">Active</span>
</span>

<!-- Only these 4 dot colors: -->
<!-- bg-emerald-500: success/active/complete -->
<!-- bg-blue-500: running/in-progress -->
<!-- bg-gray-300: idle/waiting/pending -->
<!-- bg-red-500: error/failed (ONLY for actual errors) -->
```

### DO NOT

- Card grid for 3+ attribute data (use table)
- Colored badge pills for every status (use dot + text)
- More than 4 status colors
- `hover:scale-*` on rows
- Shadow on table container

---

## 5. Input Fields

### Text Input — Light

```html
<div>
  <label class="block text-[13px] font-medium text-gray-700 mb-1.5">Label</label>
  <input type="text" placeholder="Placeholder..."
    class="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-900
    placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/20
    transition-colors">
  <p class="mt-1 text-[12px] text-gray-400">Helper text</p>
</div>
```

### Search Input — Dark (KR-6)

```html
<div class="relative">
  <input type="text" placeholder="Search..."
    class="h-8 w-48 rounded-md border border-white/10 bg-white/5 px-3 text-[13px] text-white/80
    placeholder-white/30 focus:border-white/20 focus:outline-none">
</div>
```

### Search Input — Light (GL-1)

```html
<div class="relative">
  <svg class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"><!-- search icon --></svg>
  <input type="text" placeholder="Search..."
    class="h-8 w-64 rounded-md border border-gray-200 bg-gray-50 pl-8 pr-3 text-[13px]
    placeholder-gray-400 focus:bg-white focus:border-gray-300 focus:outline-none transition-colors">
</div>
```

### DO NOT

- `h-10` or taller (SaaS inputs are h-8 to h-9)
- `rounded-lg` or larger (use rounded-md)
- `shadow-*` on inputs
- `ring-2 ring-offset-2` default focus (use ring-1 ring-blue-500/20)

---

## 6. Badges & Tags

### Status Dot (GL-1 — preferred)

```html
<span class="inline-flex items-center gap-1.5">
  <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
  <span class="text-[13px] text-gray-500">Complete</span>
</span>
```

### Pill Badge (KR-2 — sparingly)

```html
<div class="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1">
  <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
  <span class="text-[12px] font-medium text-gray-500">v2.0 Released</span>
</div>
```

### Gray-Default Badge

```html
<!-- DEFAULT: Gray for most statuses -->
<span class="rounded-sm bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">Draft</span>
<span class="rounded-sm bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">Pending</span>
<span class="rounded-sm bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">Archived</span>

<!-- ONLY for semantic urgency: -->
<span class="rounded-sm bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">Failed</span>
<span class="rounded-sm bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600">Success</span>
```

### DO NOT

- Rainbow badges (5+ colors)
- `rounded-full` colored pills for every status
- Blue/purple/pink/teal for status badges (these are decorative, not semantic)
- More than 3 badge colors on one page (gray + 2 semantic max)

---

## 7. Modals & Dialogs

### Modal — Light (GL-1, GL-6)

```html
<!-- Overlay -->
<div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
  <!-- Dialog -->
  <div class="w-full max-w-md rounded-lg border border-gray-200 bg-white">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-gray-100 px-5 py-4">
      <h3 class="text-[15px] font-semibold">Title</h3>
      <button class="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600
        transition-colors cursor-pointer">
        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <!-- Body -->
    <div class="px-5 py-4">
      <p class="text-[13px] text-gray-500 leading-relaxed">Content here.</p>
    </div>
    <!-- Footer -->
    <div class="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
      <button class="rounded-md border border-gray-200 px-3 py-1.5 text-[13px] text-gray-500
        hover:bg-gray-50 transition-colors cursor-pointer">Cancel</button>
      <button class="rounded-md bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white
        hover:bg-blue-700 transition-colors cursor-pointer">Confirm</button>
    </div>
  </div>
</div>
```

**Key traits**: max-w-md, rounded-lg (modal is the ONE place where lg is ok), bg-black/50 overlay

### DO NOT

- `shadow-2xl` on modal (use border)
- `rounded-2xl` or larger
- Gradient overlays
- `backdrop-blur` on overlay (bg-black/50 is sufficient)
- Nested scrollbars inside modal (paginate or restructure instead)

---

## 8. Toast / Alert

### Toast — Bottom Right (GL-1)

```html
<div class="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-md border border-gray-200
  bg-white px-4 py-3 text-[13px] shadow-sm">
  <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0"></span>
  <span class="text-gray-700">Action completed successfully.</span>
  <button class="ml-2 text-gray-400 hover:text-gray-600 cursor-pointer">
    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path d="M6 18L18 6M6 6l12 12"/>
    </svg>
  </button>
</div>
```

**Key traits**: shadow-sm (toast is the ONE exception where shadow is acceptable), rounded-md, fixed bottom-4 right-4

### DO NOT

- Colored backgrounds (use white + dot indicator)
- `shadow-lg` or larger
- Scale/slide animations
- Auto-dismiss faster than 3 seconds

---

## 9. Section Spacing

### SaaS App Sections

```
Page title:      text-xl (20px) font-semibold, mb-6
Section gap:     mb-6 between sections (24px)
Card grid gap:   gap-3 (12px)
Table row:       py-2.5 (20px total with padding)
Nav height:      h-12 (48px)
Page padding:    px-4 py-6
Max width:       max-w-6xl (1152px)
```

### Marketing Page Sections

```
Hero:            pt-20 pb-16
Section gap:     py-16 between sections
Card grid gap:   gap-3 (12px)
Nav height:      h-14 (56px)
Page padding:    px-6
Max width:       max-w-5xl (1024px)
Heading:         text-[40px] leading-[1.15]
Body:            text-[16px] leading-relaxed
Sub-features:    text-[14px] leading-relaxed
```

### Korean Density Adjustments

```
Card gap:        gap-2 to gap-3 (not gap-4+)
Section:         py-12 to py-16 (not py-20+)
Mobile grid:     2 columns (not single)
Info density:    Show price, rating, badge without hover
Base font:       14px (not 16px)
Letter spacing:  -0.01em body, -0.02em headings
word-break:      keep-all (mandatory for Korean)
```

---

## 10. Icon + Text Alignment

### Correct Pattern

```html
<!-- Container has the color, not children -->
<div class="flex items-center gap-2 text-gray-500 hover:text-gray-900 transition-colors cursor-pointer">
  <svg class="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
    <path d="M..."/>
  </svg>
  <span class="text-[13px]">Label</span>
</div>
```

**Rules**:
- `flex items-center gap-2` on EVERY icon+text pair
- Color on the container, not individual children
- Icon size = text size + 2-4px (13px text → 16px/h-4 icon)
- `flex-shrink-0` on icon to prevent squish
- Never use text "+" character — use SVG `<path d="M12 4v16m8-8H4"/>`

### DO NOT

- Icon and text at different colors (both must match)
- Icon without `flex-shrink-0`
- Text "+" or "×" characters instead of SVG icons
- Icon size more than 6px larger than text
