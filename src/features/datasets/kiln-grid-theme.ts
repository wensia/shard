import type { Theme } from "@glideapps/glide-data-grid";

/** Canvas cannot inherit CSS. Resolve the same semantic tokens used by the DOM. */
export function readKilnGridTheme(element: HTMLElement): { theme: Partial<Theme>; rowHeight: number; headerHeight: number; columnWidth: number } {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const number = (name: string) => parseFloat(token(name));
  const probe = document.createElement("span");
  probe.hidden = true;
  element.append(probe);
  // Glide's color parser only understands rgb()/rgba(); color-mix() tokens compute to
  // color(srgb …), which it turns into NaN fills (black in WKWebView). Paint each color
  // onto a pixel and read it back as rgba().
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const toRgba = (value: string) => {
    if (!pixel || /^rgba?\(/u.test(value)) return value;
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = value;
    pixel.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
  };
  const color = (name: string) => {
    probe.style.color = `var(${name})`;
    return toRgba(getComputedStyle(probe).color);
  };
  const length = (name: string) => {
    probe.style.width = `var(${name})`;
    return parseFloat(getComputedStyle(probe).width);
  };
  const columnDivider = () => {
    probe.style.color = "color-mix(in srgb, var(--border) 35%, transparent)";
    return toRgba(getComputedStyle(probe).color);
  };
  const theme: Partial<Theme> = {
    accentColor: color("--primary"), accentFg: color("--primary-foreground"), accentLight: color("--table-row-selected"),
    textDark: color("--foreground"), textMedium: color("--muted-foreground"), textLight: color("--muted-foreground"),
    textBubble: color("--foreground"), textHeader: color("--foreground"), textGroupHeader: color("--foreground"), textHeaderSelected: color("--primary-foreground"),
    bgIconHeader: color("--muted-foreground"), fgIconHeader: color("--card"),
    bgCell: color("--card"), bgCellMedium: color("--background"),
    bgHeader: color("--table-header"), bgHeaderHasFocus: color("--table-row-selected"), bgHeaderHovered: color("--table-row-hover"),
    bgBubble: color("--muted"), bgBubbleSelected: color("--card"), bgSearchResult: color("--primary-subtle"),
    borderColor: columnDivider(), horizontalBorderColor: color("--border"), headerBottomBorderColor: color("--table-header-border"),
    drilldownBorder: color("--border"), linkColor: color("--primary"), resizeIndicatorColor: color("--primary"),
    fontFamily: style.fontFamily, baseFontStyle: token("--text-body"), editorFontSize: token("--text-body"),
    headerFontStyle: `${token("--weight-medium")} ${token("--text-body")}`, markerFontStyle: token("--text-meta"),
    lineHeight: number("--leading-normal"), cellHorizontalPadding: number("--space-3"), cellVerticalPadding: number("--space-1"),
    headerIconSize: number("--space-4"), checkboxMaxSize: number("--space-4"),
    bubbleHeight: number("--space-6"), bubblePadding: number("--space-2"), bubbleMargin: number("--space-1"),
    roundingRadius: length("--radius-sm"),
  };
  probe.remove();
  return { theme, rowHeight: number("--table-row-height"), headerHeight: number("--control-height-lg"), columnWidth: number("--space-12") * 4 };
}
