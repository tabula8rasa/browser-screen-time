// For n nonnegative terms, sequential IEEE754 addition has forward error
// <= gamma_n * exactSum, gamma_n = n*u/(1-n*u), u = EPSILON/2.
// Allow one independent rounding of the declared total as well. Converting
// exactSum to the observed magnitude costs 1/(1-gamma_n). No absolute floor:
// tiny totals retain a tiny bound, and zero must match exactly.
export function consistentDailyTotal(total: number, values: number[]): boolean {
    if (!Number.isFinite(total) || total < 0 || values.some(value => !Number.isFinite(value) || value < 0)) return false;
    const sum = values.reduce((value, term) => value + term, 0);
    if (!Number.isFinite(sum)) return false;
    if (sum === total) return true;
    // Keep the legacy exact comparison for integer-only datasets. This also
    // prevents a tolerance at very large magnitudes admitting missing seconds.
    if (Number.isInteger(total) && values.every(Number.isInteger)) return false;
    const u = Number.EPSILON / 2, nu = values.length * u;
    if (nu >= 1) return false;
    const gamma = nu / (1 - nu);
    if (gamma >= 1) return false;
    const bound = Math.max(sum, total) * ((gamma + u) / (1 - gamma));
    return Math.abs(sum - total) <= bound;
}
