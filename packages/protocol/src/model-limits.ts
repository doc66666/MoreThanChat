// There is no total tool-round budget. Stop only a consecutive failure streak.
export const MODEL_MAX_CONSECUTIVE_TOOL_FAILURES = 5;
// Wire-format bound for integer counters, not a model execution budget.
export const MODEL_USAGE_MAX_COUNT = 1_000_000_000;
