# Next Steps (Always Current)

**Last updated**: 2026-03-07 19:45

---

## Context

**Current State**: Design agent profile significantly improved with Reference-First Protocol. System prevents "AI-looking" designs by requiring declared references from real product database.

**Completed Recently**:
- Reference-First Protocol implementation ([PRIORITY 0] in design.md)
- Reference Product Database (11 services documented with real tokens)
- 3 demo HTML files validating the protocol
- Service name anonymization (KR-/GL- codes)
- Korean font stack unified to Pretendard only

**Core Orchestrator Status**:
- 27 source files, 8 subsystems operational
- Interactive REPL functional
- Agent execution pipeline working
- Auto-commit, TodoContinuation, HarnessEnforcer integrated

---

## Immediate (Do Now)

### 1. Expand Reference Product Database
**Priority**: CRITICAL (User explicitly requested)
**Duration**: 4-6 hours

**Current state**: 11 references documented (KR-1 through KR-7, GL-1 through GL-5)
**Target**: 20-30 references covering all 12 UI type categories

**Action items**:
- Research 15-20 more production services
- Extract design tokens (hex colors, fonts, spacing, signatures)
- Document in same format as existing references
- Use anonymous codes (next: KR-8, GL-6/GL-31)
- Prioritize coverage across all UI types:
  - Dashboard / analytics (need 2-3 more)
  - Landing page B2B (need 2-3 more)
  - Landing page B2C (need 3-4)
  - CRM / data-heavy (add 2 more)
  - Developer tools (add 3-4)
  - E-commerce (add 3-4)
  - Productivity apps (add 2-3)
  - Fintech (add 1-2 more)
  - Mobile-first (add 3-4)

**Services to consider** (anonymize when documenting):
- Korean: Daangn, Musinsa, Kurly, Zigzag, Carrot, etc.
- Global: Notion, Raycast, Figma, Superhuman, Asana, Height, PostHog, Mixpanel, Warp, Arc, Framer, GitHub, GitLab, Sentry, Airtable

**Anonymization protocol**:
- Use KR-/GL- codes only
- No URLs or domain names
- Proprietary fonts → "proprietary sans", "custom mono", etc.
- Cultural refs → "portal-adjacent", "search-adjacent", etc.

### 2. Test Reference-First Protocol on Real Task
**Priority**: High
**Duration**: 1-2 hours

**Goal**: Validate that protocol actually prevents "AI look" in practice

**Action items**:
- Pick a real UI task (e.g., "build admin dashboard for analytics SaaS")
- Follow 5-step protocol (IDENTIFY → EXTRACT → DECLARE → GENERATE → VERIFY)
- Compare output with/without protocol
- Document findings in session notes
- Iterate protocol if gaps found

### 3. Update Memory with Co-Author Policy Change
**Priority**: Medium
**Duration**: 5 min

**What changed**: User now requires co-author tag on ALL commits
- Old: "No co-author tags" (Decision 12)
- New: `Co-Authored-By: orc-agent <hello@sson.tech>` on every commit

**Action**: Memory file already updated during this session

---

## Short Term (Next 1-2 Days)

### 4. Build Visual Comparison Examples
**Priority**: Medium
**Duration**: 2-3 hours

**Goal**: Show "AI default" vs "Reference-based" side-by-side

**Action items**:
- Create `demos/comparison/` folder
- Build 3 sets of comparisons:
  - Dashboard: AI default vs Reference-based
  - Landing page: AI default vs Reference-based
  - CRM: AI default vs Reference-based
- Document exact differences (colors, spacing, components)
- Use as training examples for design agent

### 5. Create Component-Level Reference Library
**Priority**: Medium
**Duration**: 3-4 hours

**Goal**: Document common components from each reference product

**Categories to extract**:
- Navigation patterns (top nav, sidebar, mobile)
- Button styles (primary, secondary, ghost, icon)
- Card components (shadow, border, radius)
- Input fields (text, select, date, search)
- Data tables (header, row, hover, selection)
- Modal dialogs (overlay, content, actions)
- Toast/alert patterns

**Format**: Extract real CSS/styles from each service, anonymize, document

### 6. Add Reference Selection Guidance
**Priority**: Low
**Duration**: 1 hour

**Goal**: Help agents pick the RIGHT references for each task

**Action items**:
- Add decision tree to design.md
- "If building Korean fintech → start with KR-1 + GL-3"
- "If building global PM tool → start with GL-1 + GL-11"
- Document when to mix Korean + Global vs same region

---

## Long Term (Next Week+)

### 7. Build Design Token JSON Exports
**Duration**: 4-6 hours

**Goal**: Programmatic access to reference database

**Action items**:
- Extract all design tokens to JSON format
- Schema: `{ service: "KR-1", colors: {...}, fonts: {...}, spacing: {...}, signature: {...} }`
- Build CLI tool to query database (e.g., `orc design-tokens KR-1`)
- Enable agents to fetch tokens programmatically

### 8. Add Mobile App Design References
**Duration**: 6-8 hours

**Goal**: Expand beyond web to iOS/Android patterns

**Action items**:
- Research 10-15 mobile apps (Korean + Global)
- Extract mobile-specific patterns (bottom nav, swipe gestures, safe area)
- Document in same anonymous format (KR-M1, GL-M1, etc.)

### 9. Visual Screenshot Database
**Duration**: 8-10 hours

**Goal**: Add visual examples to reference database

**Action items**:
- Capture screenshots of each reference service
- Annotate key design elements
- Store in `demos/references/` folder
- Link from design.md entries

### 10. A/B Testing Framework
**Duration**: 4-6 hours

**Goal**: Measure impact of Reference-First Protocol

**Action items**:
- Build test harness that generates UI with/without protocol
- Collect user feedback on "which looks more production-grade?"
- Quantify improvement (e.g., "85% prefer reference-based")

---

## Open Questions

1. **Which services should be prioritized for next 20 references?**
   - More Korean B2B SaaS?
   - More global developer tools?
   - Consumer apps (e-commerce, social)?

2. **Should reference database include mobile app designs?**
   - iOS/Android specific patterns
   - Would require new category (KR-M, GL-M codes)

3. **Should we build visual comparison tool?**
   - Side-by-side "AI default" vs "Reference-based"
   - Could be valuable for training/documentation

4. **Is 20-30 references the right target?**
   - User said 20-30 per category (could be 240+ total if literal)
   - Clarify: 20-30 total, or 20-30 per UI type?

5. **Should component-level library be separate profile?**
   - `profiles/design-components.md` for granular patterns
   - Keep `profiles/design.md` for high-level philosophy

---

## Orchestrator System Next Steps (Background)

These are lower priority than design agent work, but still pending:

### Integration Tests
- Test coverage for agent lifecycle
- REPL command tests
- Markdown rendering tests

### Agent Handoff Implementation
- architect → coder (design then implement)
- coder → reviewer (implement then review)

### Multi-Agent Concurrent Execution
- Display multiple agent outputs in REPL
- Per-agent box separation

### Decision Registry (Layer 5)
- Track architectural decisions across sessions

### File Watcher (Layer 4)
- Detect file changes, prevent conflicts

---

**Generated by**: global-pre-compact-historian
**Key Priority**: Expand Reference Product Database to 20-30 entries (user request)
**Remember**: All commits now require `Co-Authored-By: orc-agent <hello@sson.tech>`
