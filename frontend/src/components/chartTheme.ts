import { ColorType, type DeepPartial, type ChartOptions, type Time } from "lightweight-charts";

const toDate = (time: Time) => new Date((typeof time === "number" ? time : 0) * 1000);

const secondsFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const minutesFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const dollarsFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Axis labels for portfolio value: "$10,008". */
export const formatWholeDollars = (v: number) => dollarsFmt.format(v);

/**
 * Shared look for both Lightweight Charts instances, in the terminal palette.
 * `withSeconds` suits the tick-level price chart; the P&L chart spans minutes to hours.
 */
export function baseChartOptions(withSeconds: boolean): DeepPartial<ChartOptions> {
  const tickFmt = withSeconds ? secondsFmt : minutesFmt;
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: "#121922" },
      textColor: "#8b97a7",
      fontFamily: '"Archivo Variable", system-ui, sans-serif',
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "rgba(37, 47, 61, 0.55)" },
      horzLines: { color: "rgba(37, 47, 61, 0.55)" },
    },
    rightPriceScale: { borderColor: "#252f3d" },
    timeScale: {
      borderColor: "#252f3d",
      timeVisible: true,
      secondsVisible: withSeconds,
      tickMarkFormatter: (time: Time) => tickFmt.format(toDate(time)),
    },
    localization: {
      timeFormatter: (time: Time) => secondsFmt.format(toDate(time)),
    },
    crosshair: {
      vertLine: { color: "#5b6778", labelBackgroundColor: "#19222e" },
      horzLine: { color: "#5b6778", labelBackgroundColor: "#19222e" },
    },
    handleScroll: false,
    handleScale: false,
  };
}
