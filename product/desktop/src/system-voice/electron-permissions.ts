import type { SystemVoicePermissionReader, SystemVoicePermissions } from "@uclaw/shared/dist/system-voice.js";

type ElectronPermissionState = "granted" | "denied" | "restricted" | "unknown" | "not-determined";
export interface ElectronSystemVoicePermissionAuthority {
  getMediaAccessStatus(mediaType: "microphone"): ElectronPermissionState;
  isNotificationsSupported(): boolean;
  getNotificationPermission(): ElectronPermissionState;
}

export function createElectronSystemVoicePermissionReader(authority: ElectronSystemVoicePermissionAuthority): SystemVoicePermissionReader {
  return { async get(): Promise<SystemVoicePermissions> {
    return {
      microphone: authority.getMediaAccessStatus("microphone"),
      notifications: authority.isNotificationsSupported() ? authority.getNotificationPermission() : "restricted",
    };
  } };
}
