// Shared by the producer, receiver and published schema. The final request
// summarizes the result without tools, so it must count towards token usage.
export const MODEL_MAX_TOOL_ROUNDS = 12;
export const MODEL_MAX_REQUESTS = MODEL_MAX_TOOL_ROUNDS + 1;
