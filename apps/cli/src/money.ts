import { terminalText } from "./terminal-text.js";

/** Shared money formatting for CLI output. Amounts arrive in minor units. */

/** Minor units as currency, such as 1234 USD as $12.34. */
export function money(minor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return `${minor} ${terminalText(currency)} minor units`;
  }
}
