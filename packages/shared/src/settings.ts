/**
 * Local application settings (PLAN.md §7 Phase 7a, decisions D27/D29).
 *
 * These live in a LOCAL backend JSON config file (`$MAILORDOMO_CONFIG_DIR/settings.json`), NOT in
 * the metadata server (Golden rule #2 — settings are machine-local app config, not shared state) and
 * NOT in browser localStorage-as-truth. The two engine-facing knobs were promised as user-adjustable
 * in D27: the stale-day thresholds feed the pure `detectStale` engine, and `lockTimeoutMinutes` is
 * sent as `ttl_seconds` (× 60) when acquiring/refreshing a thread lock. `colorScheme` persists the
 * light/dark theme here (resolving a PROJECT.md §11 gap) — again local, never server-of-truth.
 */
import { z } from 'zod';

/** Light/dark/system theme preference (PROJECT.md §11 light/dark). `system` follows the OS. */
export const COLOR_SCHEMES = ['light', 'dark', 'system'] as const;
export const ColorSchemeSchema = z.enum(COLOR_SCHEMES);
export type ColorScheme = z.infer<typeof ColorSchemeSchema>;

/**
 * The full local settings object. All numeric knobs are positive integers (a zero/negative threshold
 * is nonsensical and would break the engines). Strict — an unknown key is rejected.
 */
export const AppSettingsSchema = z.strictObject({
  /** Days a `waiting` thread may sit silent before it is stale (feeds `detectStale`). Default 3. */
  waitingStaleDays: z.number().int().positive(),
  /** Days a `needs-reply`/`drafted` thread may sit before it is stale (feeds `detectStale`). Default 2. */
  needsReplyStaleDays: z.number().int().positive(),
  /** Lock timeout in minutes; sent to the server as `ttl_seconds = minutes * 60`. Default 30. */
  lockTimeoutMinutes: z.number().int().positive(),
  colorScheme: ColorSchemeSchema,
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/**
 * The shipped defaults — identical to the engine/lock defaults so settings are purely additive
 * (D27: "the current values stay as defaults"). The settings store returns this on a missing/invalid
 * config file so the app is always usable out of the box.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  waitingStaleDays: 3,
  needsReplyStaleDays: 2,
  lockTimeoutMinutes: 30,
  colorScheme: 'system',
};

/**
 * The `PUT /api/settings` request body: a partial patch over the current settings. Stays STRICT
 * (`.partial()` only makes the declared keys optional — it keeps rejecting unknown keys), so a typo'd
 * or smuggled field is still refused.
 */
export const UpdateSettingsRequestSchema = AppSettingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
