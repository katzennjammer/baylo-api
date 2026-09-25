export const t = {
  color: {
    bg: "#070708", shell: "#0d0d10", shellBorder: "rgba(255,255,255,0.04)",
    panel: "linear-gradient(180deg, #16141c 0%, #1a1224 100%)", panelSolid: "#1a1224",
    panelFlat: "#17161b", input: "#111015", scrim: "rgba(0,0,0,0.60)",
    border: "rgba(255,255,255,0.06)", borderHover: "rgba(255,255,255,0.12)",
    borderInput: "rgba(255,255,255,0.10)", borderControl: "rgba(255,255,255,0.12)",
    borderSecondary: "rgba(255,255,255,0.16)", borderChip: "rgba(255,255,255,0.08)",
    borderEmpty: "rgba(255,255,255,0.10)", divider: "rgba(255,255,255,0.06)",
    track: "rgba(255,255,255,0.05)", hoverFill: "rgba(255,255,255,0.05)",
    text: "#f5f4f7", textSecondary: "#c8c5d0", textMuted: "#8d8a96", textDim: "#5f5c68",
    textOnAccent: "#12081f", textOnSoft: "#1a1024",
    accent: "#a45cf0", accentStrong: "#7b3fd1", accentText: "#c9a2f7",
    accentIconActive: "#b57bf5", accentSoft: "#dcc6fb",
    accentTint: "rgba(164,92,240,0.16)", accentTintHover: "rgba(164,92,240,0.14)",
    accent2: "#f2cf3a",
    barPrimary: "linear-gradient(90deg, #7b3fd1 0%, #a45cf0 100%)", barSecondary: "#f2cf3a",
    warnOutline: "rgba(255,90,110,0.50)", warnHoverBg: "rgba(255,90,110,0.10)",
    badge: "#ff5a6e", badgeText: "#1a0508",
    highlight: "linear-gradient(160deg, #9b5cf0 0%, #d98bd0 55%, #f0c24a 100%)",
    stripes: "repeating-linear-gradient(135deg, #1d1b23 0 8px, #17161b 8px 16px)",
    stripesThumb: "repeating-linear-gradient(135deg, #24212c 0 6px, #1b1920 6px 12px)",
  },
  tone: {
    queue:   { fg: "#f5b544", bg: "rgba(245,181,68,0.12)" },
    warn:    { fg: "#ff5a6e", bg: "rgba(255,90,110,0.12)" },
    good:    { fg: "#3fcf8e", bg: "rgba(63,207,142,0.12)" },
    info:    { fg: "#c9a2f7", bg: "rgba(164,92,240,0.16)" },
    neutral: { fg: "#c8c5d0", bg: "rgba(255,255,255,0.06)" },
  },
  font: {
    sans: 'var(--font-adm-sans), "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: 'var(--font-adm-mono), "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
  },
  type: {
    // size / weight / lineHeight / letterSpacing
    wordmark:     { fontSize: 28, fontWeight: 800, lineHeight: 1,    letterSpacing: "-0.03em" },
    pageTitle:    { fontSize: 30, fontWeight: 700, lineHeight: 1.2,  letterSpacing: "-0.02em" },
    detailTitle:  { fontSize: 26, fontWeight: 700, lineHeight: 1.2,  letterSpacing: "-0.01em" },
    sectionTitle: { fontSize: 22, fontWeight: 700, lineHeight: 1.25, letterSpacing: "0" },
    cardTitle:    { fontSize: 16, fontWeight: 700, lineHeight: 1.35, letterSpacing: "0" },
    entityName:   { fontSize: 15, fontWeight: 700, lineHeight: 1.35, letterSpacing: "0" },  // row/card primary name
    entityNameLg: { fontSize: 17, fontWeight: 700, lineHeight: 1.3,  letterSpacing: "0" },
    body:         { fontSize: 14, fontWeight: 500, lineHeight: 1.5,  letterSpacing: "0" },
    bodyLong:     { fontSize: 14, fontWeight: 500, lineHeight: 1.6,  letterSpacing: "0" },  // page intros
    small:        { fontSize: 13, fontWeight: 500, lineHeight: 1.5,  letterSpacing: "0" },
    smallStrong:  { fontSize: 13, fontWeight: 600, lineHeight: 1.4,  letterSpacing: "0" },
    caption:      { fontSize: 12, fontWeight: 500, lineHeight: 1.45, letterSpacing: "0" },
    microLabel:   { fontSize: 11, fontWeight: 600, lineHeight: 1.3,  letterSpacing: "0.08em", textTransform: "uppercase" as const },
    brandLabel:   { fontSize: 11, fontWeight: 600, lineHeight: 1.3,  letterSpacing: "0.12em", textTransform: "uppercase" as const },
    pill:         { fontSize: 11, fontWeight: 800, lineHeight: 1.2,  letterSpacing: "0.04em" }, // status pills (uppercase source text)
    pillNum:      { fontSize: 11, fontWeight: 800, lineHeight: 1.2,  letterSpacing: "0" },      // yellow/violet count pills
    button:       { fontSize: 14, fontWeight: 700, lineHeight: 1.2,  letterSpacing: "0" },
    buttonSm:     { fontSize: 13, fontWeight: 700, lineHeight: 1.2,  letterSpacing: "0" },
    chip:         { fontSize: 13, fontWeight: 600, lineHeight: 1.2,  letterSpacing: "0" },
    segmented:    { fontSize: 15, fontWeight: 500, lineHeight: 1.2,  letterSpacing: "0" },       // active = 700
    metricXL:     { fontSize: 44, fontWeight: 700, lineHeight: 1,    letterSpacing: "-0.03em" }, // overview tiles
    metricL:      { fontSize: 38, fontWeight: 700, lineHeight: 1,    letterSpacing: "-0.03em" }, // report stat tiles
    highlight:    { fontSize: 64, fontWeight: 800, lineHeight: 1,    letterSpacing: "-0.04em" },
    mono:         { fontSize: 12, fontWeight: 400, lineHeight: 1.45, letterSpacing: "0" },
    monoSm:       { fontSize: 11, fontWeight: 400, lineHeight: 1.45, letterSpacing: "0" },
  },
  space: { 0.5: 2, 1: 4, 1.5: 6, 2: 8, 2.5: 10, 3: 12, 3.5: 14, 4: 16, 4.5: 18, 5: 20, 6: 24, 7: 28, 8: 32, 10: 40, 14: 56 },
  radius: { shell: 36, rail: 28, panel: 24, tile: 16, input: 14, menuItem: 10, pill: 999 },
  borderWidth: { base: 1, focus: 2, focusOffset: 2 },
  shadow: { none: "none", glowActive: "0 0 24px rgba(164,92,240,0.35)", overlay: "0 24px 64px rgba(0,0,0,0.55)" },
  z: { base: 0, sticky: 10, dropdown: 30, drawerScrim: 40, drawer: 41, paletteScrim: 50, palette: 51, tooltip: 60, toast: 70 },
  bp: { sm: 640, md: 768, lg: 1024, xl: 1100, xxl: 1280, shellMax: 1440 },
  motion: {
    dur: { fast: 0.12, base: 0.2, slow: 0.25, shimmer: 1.4 },         // seconds (Framer)
    ease: {
      standard: [0.2, 0, 0, 1] as const,
      out: [0.16, 1, 0.3, 1] as const,
      inOut: [0.65, 0, 0.35, 1] as const,
    },
    spring: {
      indicator: { type: "spring", stiffness: 500, damping: 40, mass: 1 } as const, // layoutId rail/chip indicator
      drawer:    { type: "spring", stiffness: 380, damping: 38 } as const,
      pop:       { type: "spring", stiffness: 600, damping: 30 } as const,        // menus, palette
    },
    stagger: { children: 0.04, delay: 0.02, maxItems: 12 },
    enterOffsetY: 8,
  },
} as const;
export type AdminTone = keyof typeof t.tone;
