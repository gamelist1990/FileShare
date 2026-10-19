import { HttpError } from "./policy";
export interface FilePolicy {
  maxFileBytes: number;
  maxRetentionSeconds: number;
  trackDownloads: boolean;
  showDownloadCounts: boolean;
  showUploaders: boolean;
  rankingEnabled: boolean;
}
export const defaultFilePolicy: FilePolicy = {
  maxFileBytes: 5_000_000_000,
  maxRetentionSeconds: 30 * 86400,
  trackDownloads: true,
  showDownloadCounts: true,
  showUploaders: true,
  rankingEnabled: true,
};
export function validateFilePolicy(value: any, capacity: number): FilePolicy {
  if (
    !value ||
    !Number.isSafeInteger(value.maxFileBytes) ||
    value.maxFileBytes < 1 ||
    value.maxFileBytes > capacity ||
    !Number.isSafeInteger(value.maxRetentionSeconds) ||
    value.maxRetentionSeconds < 60 ||
    value.maxRetentionSeconds > 3650 * 86400 ||
    [
      "trackDownloads",
      "showDownloadCounts",
      "showUploaders",
      "rankingEnabled",
    ].some((k) => typeof value[k] !== "boolean")
  )
    throw new HttpError(
      400,
      "ファイル設定を確認してください（保存期間の上限は1分〜3650日）",
    );
  return {
    maxFileBytes: value.maxFileBytes,
    maxRetentionSeconds: value.maxRetentionSeconds,
    trackDownloads: value.trackDownloads,
    showDownloadCounts: value.showDownloadCounts,
    showUploaders: value.showUploaders,
    rankingEnabled: value.rankingEnabled,
  };
}
export function retentionSeconds(value: unknown, maximum: number) {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 60 ||
    Number(value) > maximum
  )
    throw new HttpError(
      400,
      `保存期間は1分〜${Math.floor(maximum / 60)}分で指定してください`,
    );
  return Number(value);
}
export function validateAISettings(value: any) {
  if (
    typeof value?.enabled !== "boolean" ||
    typeof value.model !== "string" ||
    !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(value.model) ||
    !Number.isSafeInteger(value.intervalSeconds) ||
    value.intervalSeconds < 60 ||
    value.intervalSeconds > 3600
  )
    throw new HttpError(
      400,
      "AI設定を確認してください（監視間隔は60〜3600秒）",
    );
  return {
    enabled: value.enabled,
    model: value.model,
    intervalSeconds: value.intervalSeconds,
  };
}

export interface RegistrationPolicy {
  publicRegistration: boolean;
  autoApprove: boolean;
  generalUploads: boolean;
  vipSharedUploads: boolean;
  vipSharedEditing: boolean;
  maxPasskeys: number;
}
export const defaultRegistrationPolicy: RegistrationPolicy = {
  publicRegistration: false,
  autoApprove: false,
  generalUploads: false,
  vipSharedUploads: false,
  vipSharedEditing: false,
  maxPasskeys: 3,
};
export function validateRegistrationPolicy(value: any): RegistrationPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "登録設定を確認してください");
  value = { ...defaultRegistrationPolicy, ...value };
  if (
    !value ||
    [
      "publicRegistration",
      "autoApprove",
      "generalUploads",
      "vipSharedUploads",
      "vipSharedEditing",
    ].some((k) => typeof value[k] !== "boolean")
  )
    throw new HttpError(400, "登録設定を確認してください");
  if (
    !Number.isSafeInteger(value.maxPasskeys) ||
    value.maxPasskeys < 1 ||
    value.maxPasskeys > 100
  )
    throw new HttpError(400, "登録パスキー数の上限は1〜100で指定してください");
  return {
    vipSharedUploads: value.vipSharedUploads,
    vipSharedEditing: value.vipSharedEditing,
    maxPasskeys: value.maxPasskeys,
    publicRegistration: value.publicRegistration,
    autoApprove: value.autoApprove,
    generalUploads: value.generalUploads,
  };
}
