/** Versioned model identities: a different set of equations/data needs a new identity. */
export const DAMAGE_IMPLEMENTATIONS = ["off-v1", "health-v1"] as const;
export type DamageImplementation = typeof DAMAGE_IMPLEMENTATIONS[number];
export type SettingsEditors = "host" | "everyone";

export interface SharedFlightSettings {
  damageImplementation: DamageImplementation;
  settingsEditors: SettingsEditors;
}
export type SharedSettingsPatch = Partial<SharedFlightSettings>;
export const DEFAULT_SHARED_SETTINGS: Readonly<SharedFlightSettings> = {
  damageImplementation: "health-v1", settingsEditors: "host",
};
export type SharedSettingsRejection = "host-only" | "permission-host-only" | "stale" | "unsupported" | "not-ready";

export function isDamageImplementation(value: unknown): value is DamageImplementation {
  return value === "off-v1" || value === "health-v1";
}
export function isSharedSettings(value: unknown): value is SharedFlightSettings {
  return record(value) && Object.keys(value).length === 2 && isDamageImplementation(value.damageImplementation)
    && (value.settingsEditors === "host" || value.settingsEditors === "everyone");
}
export function isSharedSettingsPatch(value: unknown): value is SharedSettingsPatch {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(key => key === "damageImplementation" ? isDamageImplementation(value[key])
    : key === "settingsEditors" && (value[key] === "host" || value[key] === "everyone"));
}
export function isDamageCapabilities(value: unknown): value is DamageImplementation[] {
  return Array.isArray(value) && value.length > 0 && value.length <= DAMAGE_IMPLEMENTATIONS.length
    && value.every(isDamageImplementation) && new Set(value).size === value.length;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
