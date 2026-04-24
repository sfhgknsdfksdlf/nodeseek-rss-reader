const boardNames: Record<string, string> = {
  daily: "日常",
  tech: "技术",
  info: "情报",
  review: "测评",
  trade: "交易",
  carpool: "拼车",
  promotion: "推广",
  life: "生活",
  dev: "Dev",
  image: "贴图",
  expose: "曝光",
  sandbox: "沙盒",
  日常: "日常",
  技术: "技术",
  情报: "情报",
  测评: "测评",
  交易: "交易",
  拼车: "拼车",
  推广: "推广",
  生活: "生活",
  Dev: "Dev",
  贴图: "贴图",
  曝光: "曝光",
  沙盒: "沙盒"
};

export const boardOptions = [
  ["", "全部"],
  ["daily", "日常"],
  ["tech", "技术"],
  ["info", "情报"],
  ["review", "测评"],
  ["trade", "交易"],
  ["carpool", "拼车"],
  ["promotion", "推广"],
  ["life", "生活"],
  ["dev", "Dev"],
  ["image", "贴图"],
  ["expose", "曝光"],
  ["sandbox", "沙盒"]
] as const;

export function displayBoard(key: string | null): string {
  if (!key) return "";
  return boardNames[key] || key;
}

export function normalizeBoard(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  if (boardNames[lowered]) return lowered;
  return trimmed;
}
